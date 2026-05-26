// OAuth 2.0 Device Authorization Grant (RFC 8628) client for ModelBound.
// Lets users sign in by opening a browser instead of copy/pasting an API key.
//
// Flow:
//   1. POST /start  -> { device_code, user_code, verification_uri_complete, interval, expires_in }
//   2. Open verification_uri_complete in the user's browser (logs in + approves)
//   3. POST /poll   every `interval` seconds until { api_key, team_id, user_email }
//   4. Persist api_key via VS Code config (modelbound.apiKey)

import * as vscode from 'vscode';

const DEFAULT_AUTH_BASE =
  'https://modelbound.co/api/extension-device-auth';

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

export interface DevicePollApproved {
  api_key: string;
  team_id: string;
  user_email: string | null;
}

function getAuthBase(): string {
  const cfg = vscode.workspace.getConfiguration('modelbound');
  return cfg.get<string>('authUrl') || DEFAULT_AUTH_BASE;
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let data: T | null = null;
    if (text) {
      try { data = JSON.parse(text) as T; } catch { data = null; }
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function startDeviceFlow(deviceLabel?: string): Promise<DeviceStartResponse> {
  const { status, data } = await postJson<DeviceStartResponse & { error?: string }>(
    `${getAuthBase()}/start`,
    { device_label: deviceLabel },
  );
  if (status !== 200 || !data?.device_code) {
    throw new Error(data?.error || `start failed (${status})`);
  }
  return data;
}

/**
 * Runs the polling loop until the user approves, denies, or the code expires.
 * Reports progress via the supplied VS Code progress reporter. Cancellation
 * (user closes the notification) throws to abort the sign-in.
 */
export async function pollUntilApproved(
  start: DeviceStartResponse,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<DevicePollApproved> {
  const deadline = Date.now() + start.expires_in * 1000;
  const intervalMs = Math.max(2, start.interval) * 1000;

  while (Date.now() < deadline) {
    if (token.isCancellationRequested) throw new Error('Sign-in cancelled');
    await new Promise((r) => setTimeout(r, intervalMs));
    if (token.isCancellationRequested) throw new Error('Sign-in cancelled');

    const { status, data } = await postJson<
      Partial<DevicePollApproved> & { status?: string; error?: string }
    >(`${getAuthBase()}/poll`, { device_code: start.device_code });

    if (status === 200 && data?.api_key) {
      return {
        api_key: data.api_key,
        team_id: data.team_id || '',
        user_email: data.user_email ?? null,
      };
    }
    if (data?.status === 'authorization_pending') {
      progress.report({ message: `Waiting for approval · code ${start.user_code}` });
      continue;
    }
    if (data?.status === 'denied') throw new Error('Sign-in denied');
    if (data?.status === 'expired') throw new Error('Sign-in code expired — try again');
    if (data?.status === 'consumed') throw new Error('Sign-in code already used');
    if (status >= 400) throw new Error(data?.error || `poll failed (${status})`);
  }
  throw new Error('Sign-in timed out — try again');
}

/**
 * Full sign-in convenience: start the flow, open the browser, poll, and
 * persist the resulting API key to the global config.
 *
 * Returns the user's email (when available) on success.
 */
export async function runSignIn(): Promise<string | null> {
  const deviceLabel = `${vscode.env.appName} on ${process.platform}`;
  const start = await startDeviceFlow(deviceLabel);

  const open = await vscode.window.showInformationMessage(
    `ModelBound: Open browser to sign in?\nCode: ${start.user_code}`,
    { modal: false },
    'Open Browser',
    'Copy Code',
    'Cancel',
  );
  if (open === 'Cancel' || !open) throw new Error('Sign-in cancelled');
  if (open === 'Copy Code') {
    await vscode.env.clipboard.writeText(start.user_code);
  }
  await vscode.env.openExternal(vscode.Uri.parse(start.verification_uri_complete));

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ModelBound: Waiting for browser sign-in...',
      cancellable: true,
    },
    (progress, token) => pollUntilApproved(start, progress, token),
  );

  const cfg = vscode.workspace.getConfiguration('modelbound');
  await cfg.update('apiKey', result.api_key, vscode.ConfigurationTarget.Global);
  return result.user_email;
}