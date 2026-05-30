// Validates a stored ModelBound API key against the lightweight
// `extension-auth-check` edge function before the extension prompts for a
// fresh sign-in. Avoids the annoyance of being re-prompted on every window
// reload when an existing key is still valid.
//
// Previously this round-tripped through MCP `auth_whoami`, but that path is
// heavier and conflated transient MCP/SSE failures with auth failures. The
// dedicated check endpoint returns a clear JSON verdict.

import * as vscode from 'vscode';

const AUTH_CHECK_URL =
  'https://qwqfoyhnhszqqplsavxk.supabase.co/functions/v1/extension-auth-check';

export type ValidateResult =
  | { valid: true; user_email?: string | null; team_id?: string | null }
  | { valid: false; reason: 'unauthorized' | 'network' | 'unknown'; detail?: string };

/**
 * Lightweight key validation. Calls the `extension-auth-check` edge function
 * which returns `{ valid: true, ... }` or `{ valid: false, reason }` for
 * known states (missing/invalid/revoked/expired). Network and 5xx errors
 * are returned as transient so the caller can keep the stored key.
 */
export async function validateApiKey(
  _mcpUrl: string, // kept for backwards-compat with existing call sites
  apiKey: string,
  log: (msg: string) => void,
): Promise<ValidateResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(AUTH_CHECK_URL, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (res.status >= 500) {
      log(`extension-auth-check: HTTP ${res.status} — treating as transient`);
      return { valid: false, reason: 'unknown', detail: `HTTP ${res.status}` };
    }

    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* ignore */ }

    if (parsed && parsed.valid === true) {
      return {
        valid: true,
        user_email: parsed.user_email ?? null,
        team_id: parsed.team_id ?? null,
      };
    }

    const reason = String(parsed?.reason || '');
    // Definitive rejections — clear the key.
    if (
      reason === 'missing_api_key' ||
      reason === 'invalid_api_key' ||
      reason === 'revoked' ||
      reason === 'expired'
    ) {
      return { valid: false, reason: 'unauthorized', detail: reason };
    }

    // Anything else (lookup_failed, method_not_allowed, unparseable body) —
    // treat as transient so we don't wipe a still-valid key.
    log(`extension-auth-check: indeterminate response (${reason || res.status}) — keeping stored key`);
    return { valid: false, reason: 'unknown', detail: reason || `HTTP ${res.status}` };
  } catch (err) {
    log(`extension-auth-check: network error — ${(err as Error).message ?? String(err)}`);
    return { valid: false, reason: 'network', detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether the stored API key is usable. Returns the key on success.
 * On a confirmed rejection (unauthorized) it clears storage and runs
 * `promptSignIn`. On a transient/network failure it returns the existing
 * key unchanged so the extension keeps working — preventing the
 * "re-prompt on every window open" loop when the auth check endpoint is
 * briefly unreachable.
 */
export async function ensureUsableApiKey(opts: {
  mcpUrl: string;
  storedKey: string | undefined;
  log: (msg: string) => void;
  clearStoredKey: () => Promise<void>;
  promptSignIn: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  const { mcpUrl, storedKey, log, clearStoredKey, promptSignIn } = opts;

  if (!storedKey || !storedKey.trim()) {
    return promptSignIn();
  }

  const check = await validateApiKey(mcpUrl, storedKey, log);
  if (check.valid) {
    log(`Stored API key validated (team=${check.team_id ?? 'n/a'})`);
    return storedKey;
  }

  if (check.reason === 'unauthorized') {
    log(`Stored API key rejected (${check.detail}) — clearing and prompting sign-in.`);
    await clearStoredKey();
    vscode.window.showWarningMessage('ModelBound: your saved API key is no longer valid. Please sign in again.');
    return promptSignIn();
  }

  // Transient — keep the existing key, log only. This is the critical fix
  // for the re-prompt loop: a flaky network or a 5xx must NOT clear the key.
  log(`Skipping re-validation (${check.reason}); using stored key.`);
  return storedKey;
}
