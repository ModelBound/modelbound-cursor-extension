// Validates a stored ModelBound API key against the lightweight
// `extension-auth-check` edge function before the extension prompts for a
// fresh sign-in. Avoids the annoyance of being re-prompted on every window
// reload when an existing key is still valid.
//
// Previously this round-tripped through MCP `auth_whoami`, but that path is
// heavier and conflated transient MCP/SSE failures with auth failures. The
// dedicated check endpoint returns a clear JSON verdict.

import * as crypto from 'crypto';
import * as vscode from 'vscode';

const AUTH_CHECK_URL =
  'https://qwqfoyhnhszqqplsavxk.supabase.co/functions/v1/extension-auth-check';
const AUTH_CACHE_KEY = 'modelbound.authCheckCache.v1';
// Device tokens last ~7 days — cache successful checks for 6 days.
const AUTH_CACHE_TTL_MS = 6 * 24 * 60 * 60 * 1000;

type AuthCacheEntry = { fingerprint: string; validatedAt: number; teamId?: string | null };

export type ValidateResult =
  | { valid: true; user_email?: string | null; team_id?: string | null }
  | { valid: false; reason: 'unauthorized' | 'network' | 'unknown'; detail?: string };

function keyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 16);
}

export function getRecentAuthCache(globalState: vscode.Memento | undefined): AuthCacheEntry | null {
  if (!globalState) return null;
  const cached = globalState.get<AuthCacheEntry>(AUTH_CACHE_KEY);
  if (!cached) return null;
  if (Date.now() - cached.validatedAt > AUTH_CACHE_TTL_MS) return null;
  return cached;
}

function readAuthCache(globalState: vscode.Memento | undefined, apiKey: string): AuthCacheEntry | null {
  if (!globalState) return null;
  const cached = globalState.get<AuthCacheEntry>(AUTH_CACHE_KEY);
  if (!cached) return null;
  if (cached.fingerprint !== keyFingerprint(apiKey)) return null;
  if (Date.now() - cached.validatedAt > AUTH_CACHE_TTL_MS) return null;
  return cached;
}

export type SyncAuthResult =
  | { ok: true; apiKey: string; fromCache: boolean }
  | { ok: false; reason: 'missing' | 'invalid' };

/**
 * Prepare auth immediately before a sync/delete operation.
 * Uses the 6-day cache when present; otherwise performs a live auth-check.
 */
export async function prepareSyncAuth(opts: {
  apiKey: string | undefined;
  mcpUrl: string;
  globalState?: vscode.Memento;
  log: (msg: string) => void;
}): Promise<SyncAuthResult> {
  const key = opts.apiKey?.trim();
  if (!key) return { ok: false, reason: 'missing' };

  const cached = readAuthCache(opts.globalState, key);
  if (cached) {
    opts.log(`Sync auth: using cached validation (team=${cached.teamId ?? 'n/a'})`);
    return { ok: true, apiKey: key, fromCache: true };
  }

  opts.log('Sync auth: no cache — validating API key with ModelBound…');
  const check = await validateApiKey(opts.mcpUrl, key, opts.log);
  if (check.valid) {
    await writeAuthCache(opts.globalState, key, check.team_id);
    opts.log(`Sync auth: live validation passed (team=${check.team_id ?? 'n/a'})`);
    return { ok: true, apiKey: key, fromCache: false };
  }

  if (check.reason === 'unauthorized') {
    opts.log(`Sync auth: live validation rejected key (${check.detail ?? 'unknown'})`);
    return { ok: false, reason: 'invalid' };
  }

  // Auth-check can be wrong/stale while MCP still accepts the key — try sync anyway.
  opts.log(`Sync auth: live validation inconclusive (${check.reason}); proceeding with MCP.`);
  return { ok: true, apiKey: key, fromCache: false };
}

export async function writeAuthCache(
  globalState: vscode.Memento | undefined,
  apiKey: string,
  teamId?: string | null,
): Promise<void> {
  if (!globalState) return;
  await globalState.update(AUTH_CACHE_KEY, {
    fingerprint: keyFingerprint(apiKey),
    validatedAt: Date.now(),
    teamId: teamId ?? null,
  } satisfies AuthCacheEntry);
}

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
    // Definitive rejections from the auth-check service.
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
 * Decide whether the stored API key is usable.
 *
 * By default this is silent on startup: it validates in the background, caches
 * successful checks, and never clears or re-prompts unless `interactive` is
 * true (for example after a sync/MCP auth failure).
 */
export async function ensureUsableApiKey(opts: {
  mcpUrl: string;
  storedKey: string | undefined;
  log: (msg: string) => void;
  clearStoredKey: () => Promise<void>;
  promptSignIn: () => Promise<string | undefined>;
  globalState?: vscode.Memento;
  interactive?: boolean;
}): Promise<string | undefined> {
  const {
    mcpUrl,
    storedKey,
    log,
    clearStoredKey,
    promptSignIn,
    globalState,
    interactive = false,
  } = opts;

  if (!storedKey || !storedKey.trim()) {
    if (interactive) return promptSignIn();
    log('No ModelBound API key configured.');
    return undefined;
  }

  const cached = readAuthCache(globalState, storedKey);
  if (cached) {
    log(`Stored API key validated from cache (team=${cached.teamId ?? 'n/a'})`);
    return storedKey;
  }

  const check = await validateApiKey(mcpUrl, storedKey, log);
  if (check.valid) {
    log(`Stored API key validated (team=${check.team_id ?? 'n/a'})`);
    await writeAuthCache(globalState, storedKey, check.team_id);
    return storedKey;
  }

  if (check.reason === 'unauthorized') {
    log(`Stored API key rejected by auth-check (${check.detail ?? 'unknown'})`);
    if (!interactive) {
      // Keep the saved key — MCP sync is the source of truth. The lightweight
      // auth-check endpoint can lag behind newly issued device tokens.
      log('Keeping stored key; will only prompt if sync/MCP rejects it.');
      return storedKey;
    }
    await clearStoredKey();
    vscode.window.showWarningMessage('ModelBound: your saved API key is no longer valid. Please sign in again.');
    return promptSignIn();
  }

  // Transient — keep the existing key, log only.
  log(`Skipping re-validation (${check.reason}); using stored key.`);
  return storedKey;
}

export function isAuthFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key') ||
    lower.includes('invalid_api_key') ||
    lower.includes('revoked') ||
    lower.includes('expired')
  );
}
