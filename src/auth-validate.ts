// Validates a stored ModelBound API key against the cloud MCP server before
// the extension prompts for a fresh sign-in. Avoids the annoyance of being
// re-prompted on every window reload when an existing key is already valid.

import * as vscode from 'vscode';

export type ValidateResult =
  | { valid: true; user_email?: string | null; team_id?: string | null }
  | { valid: false; reason: 'unauthorized' | 'network' | 'unknown'; detail?: string };

/**
 * Lightweight `auth_whoami` round-trip. The hosted MCP server exposes this
 * as a no-op tool whose only purpose is cheap token validation.
 */
export async function validateApiKey(
  mcpUrl: string,
  apiKey: string,
  log: (msg: string) => void,
): Promise<ValidateResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: 'auth_whoami', arguments: {} },
      }),
    });

    if (res.status === 401 || res.status === 403) {
      return { valid: false, reason: 'unauthorized', detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      log(`auth_whoami: HTTP ${res.status} — treating as transient`);
      return { valid: false, reason: 'unknown', detail: `HTTP ${res.status}` };
    }

    const ctype = res.headers.get('content-type') || '';
    let body = '';
    if (ctype.includes('text/event-stream')) {
      const raw = await res.text();
      const lines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
      body = lines[lines.length - 1] || '';
    } else {
      body = await res.text();
    }

    if (!body) return { valid: true };
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { return { valid: true }; }

    // JSON-RPC error path — MCP returns errors inside `error` or surfaces
    // unauthorized as `error.code === -32001` in some implementations.
    if (parsed?.error) {
      const msg = String(parsed.error.message || '').toLowerCase();
      if (msg.includes('unauthor') || msg.includes('invalid api key') || msg.includes('invalid_api_key')) {
        return { valid: false, reason: 'unauthorized', detail: parsed.error.message };
      }
      return { valid: false, reason: 'unknown', detail: parsed.error.message };
    }

    const result = parsed?.result;
    const structured = result?.structuredContent;
    if (structured) {
      return { valid: true, user_email: structured.user_email ?? null, team_id: structured.team_id ?? null };
    }
    return { valid: true };
  } catch (err) {
    log(`auth_whoami: network error — ${(err as Error).message ?? String(err)}`);
    return { valid: false, reason: 'network', detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether the stored API key is usable. Returns the key on success.
 * On a confirmed 401 it clears storage and runs `promptSignIn`. On a
 * transient/network failure it returns the existing key unchanged so the
 * extension can keep working offline (file writes will simply fail until
 * connectivity returns).
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
  if (check.valid) return storedKey;

  if (check.reason === 'unauthorized') {
    log('Stored API key rejected by server — clearing and prompting sign-in.');
    await clearStoredKey();
    vscode.window.showWarningMessage('ModelBound: your saved API key is no longer valid. Please sign in again.');
    return promptSignIn();
  }

  // Transient — keep the existing key, log only.
  log(`Skipping re-validation (${check.reason}); using stored key.`);
  return storedKey;
}
