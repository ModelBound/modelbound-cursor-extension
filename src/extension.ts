import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { requestModelBoundCredentials } from './auth-flow';
import { ensureUsableApiKey, isAuthFailureMessage, prepareSyncAuth, writeAuthCache } from './auth-validate';
import { RealtimeSync } from './realtime-sync';
import { getCtx, api, ApiCtx, setToken, clearToken } from './api';
import { isSkillFile } from './skillDetect';
import { SkillCodeLensProvider } from './skill-lens';
import { registerSkillTrustCommands } from './skill-trust';

const WATCH_GLOBS = [
  '.modelbound/**/*.md',
  '.modelbound/**/*.json',
  '.kiro/skills/**/*.md',
  '.cursor/rules/**/*.md',
  '.cursor/rules/**/*.mdc',
  '.claude/**/*.md',
  '.modelbound/skills/**/*.md',
  '.agents/skills/**/SKILL.md',
];

const WATCH_ROOTS = [
  '.modelbound/',
  '.kiro/skills/',
  '.cursor/rules/',
  '.claude/',
  '.agents/skills/',
];

const SELF_WRITE_SUPPRESS_MS = 30_000;
const RECENT_LOCAL_PUSH_SUPPRESS_MS = 45_000;
const DEBOUNCE_MS = 1200;

const watchers: vscode.FileSystemWatcher[] = [];
let outputChannel: vscode.OutputChannel | undefined;
const recentSelfWrites = new Map<string, number>();
const recentLocalPushes = new Map<string, number>();
const inFlightPathSyncs = new Set<string>();
const inFlightOpenReconciles = new Set<string>();
const pendingSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Persistent registry of skills this workspace has touched (pushed or pulled).
// Key: skill UUID. Value: { slug, paths: absolute file paths }.
// Used by the realtime watcher to decide whether an MB-side change should
// land on disk. Without this, MB→IDE pulls get filtered out whenever the
// local filename doesn't follow `<slug>.md` exactly.
type SkillRegistryEntry = { slug?: string | null; paths: string[] };
const REGISTRY_KEY = 'modelbound.skillRegistry.v1';
const LAST_SYNCED_KEY = 'modelbound.lastSyncedContent.v1';
let skillRegistry: Record<string, SkillRegistryEntry> = {};
let extensionContext: vscode.ExtensionContext | null = null;

type LastSyncedEntry = { hash: string; skillId?: string; at: number };

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function getLastSyncedHash(filePath: string): LastSyncedEntry | undefined {
  if (!extensionContext) return undefined;
  const map = extensionContext.workspaceState.get<Record<string, LastSyncedEntry>>(LAST_SYNCED_KEY, {}) ?? {};
  return map[path.resolve(filePath)];
}

function markLastSynced(filePath: string, content: string, skillId?: string): void {
  if (!extensionContext) return;
  const map = extensionContext.workspaceState.get<Record<string, LastSyncedEntry>>(LAST_SYNCED_KEY, {}) ?? {};
  map[path.resolve(filePath)] = { hash: hashContent(content), skillId, at: Date.now() };
  void extensionContext.workspaceState.update(LAST_SYNCED_KEY, map);
}

function resolveCloudSkillId(filePath: string, fallbackSlug: string): string {
  const abs = path.resolve(filePath);
  const lastSynced = getLastSyncedHash(filePath);
  if (lastSynced?.skillId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lastSynced.skillId)) {
    return lastSynced.skillId;
  }
  for (const [key, entry] of Object.entries(skillRegistry)) {
    if (!entry.paths.includes(abs) && !entry.paths.some((p) => path.resolve(p) === abs)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return key;
  }
  return fallbackSlug;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SkillTarget = {
  /** Best MCP identifier — UUID when synced, otherwise filename slug. */
  skillId: string;
  slug: string;
  relativePath: string;
  filePath: string;
  label: string;
};

function forEachWatchableFile(workspaceRoot: string, fn: (absPath: string) => void): void {
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) fn(abs);
    }
  };
  for (const root of WATCH_ROOTS) {
    const absRoot = path.join(workspaceRoot, root);
    if (fs.existsSync(absRoot)) walk(absRoot);
  }
}

function resolveSkillFromPath(workspaceRoot: string, filePath: string): SkillTarget | null {
  if (!isWatchablePath(workspaceRoot, filePath)) return null;
  const abs = path.resolve(filePath);
  const slug = skillIdFromPath(workspaceRoot, abs);
  const relativePath = relPath(workspaceRoot, abs);
  const skillId = resolveCloudSkillId(abs, slug);
  const entry = lookupRegistry(skillId, slug);
  const displaySlug = entry?.slug ?? slug;
  const label = displaySlug !== slug ? `${displaySlug} · ${relativePath}` : relativePath;
  return { skillId, slug: displaySlug, relativePath, filePath: abs, label };
}

function listWorkspaceSkillTargets(workspaceRoot: string): SkillTarget[] {
  const byPath = new Map<string, SkillTarget>();
  forEachWatchableFile(workspaceRoot, (absPath) => {
    const target = resolveSkillFromPath(workspaceRoot, absPath);
    if (target) byPath.set(target.filePath, target);
  });
  return [...byPath.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function skillTargetFromHint(workspaceRoot: string, hint: string): SkillTarget | null {
  const trimmed = hint.trim();
  if (!trimmed) return null;
  for (const target of listWorkspaceSkillTargets(workspaceRoot)) {
    if (
      target.skillId === trimmed ||
      target.slug === trimmed ||
      target.relativePath === trimmed ||
      skillIdFromPath(workspaceRoot, target.filePath) === trimmed
    ) {
      return target;
    }
  }
  return null;
}

async function pickSkillTarget(
  workspaceRoot: string,
  opts: { preferUri?: vscode.Uri; hint?: string; purpose?: string } = {},
): Promise<SkillTarget | undefined> {
  const purpose = opts.purpose ?? 'continue';

  if (opts.hint) {
    const fromHint = skillTargetFromHint(workspaceRoot, opts.hint);
    if (fromHint) return fromHint;
  }

  const preferPath = opts.preferUri?.scheme === 'file' ? opts.preferUri.fsPath : undefined;
  const activePath =
    preferPath ??
    (vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined);
  if (activePath) {
    const fromActive = resolveSkillFromPath(workspaceRoot, activePath);
    if (fromActive) return fromActive;
  }

  const candidates = listWorkspaceSkillTargets(workspaceRoot);
  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    const picked = await vscode.window.showQuickPick(
      candidates.map((target) => ({
        label: target.label,
        description: target.relativePath,
        detail: UUID_RE.test(target.skillId) ? 'Synced with ModelBound' : 'Save once to link with ModelBound',
        target,
      })),
      { placeHolder: `Choose a skill file to ${purpose}` },
    );
    return (picked as { target?: SkillTarget } | undefined)?.target;
  }

  const entered = await vscode.window.showInputBox({
    prompt: `Enter a skill name (filename without .md, e.g. prompt-pr-contributor) to ${purpose}.`,
    placeHolder: 'prompt-pr-contributor',
    ignoreFocusOut: true,
  });
  if (!entered?.trim()) return undefined;
  const slug = entered.trim();
  return { skillId: slug, slug, relativePath: slug, filePath: '', label: slug };
}

function repoFullNameFromRepoUrl(repoUrl: string | null): string | undefined {
  if (!repoUrl) return undefined;
  try {
    const parts = new URL(repoUrl.replace(/^git@([^:]+):/, 'https://$1/'))
      .pathname.replace(/^\//, '')
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    /* ignore malformed remotes */
  }
  return undefined;
}

async function setModelBoundWorkspaceContext(
  mcpUrl: string,
  apiKey: string,
  workspaceRoot: string,
  logFn?: (msg: string) => void,
): Promise<void> {
  const { repoUrl } = getRepoInfo(workspaceRoot);
  const repoFullName = repoFullNameFromRepoUrl(repoUrl);
  try {
    await callMcpTool(mcpUrl, apiKey, 'set_workspace_context', {
      workspace_path: workspaceRoot,
      repo_full_name: repoFullName,
      file_hints: ['.modelbound', '.cursor/rules', '.kiro/skills', '.claude'],
    });
    logFn?.(`Workspace context set (repo=${repoFullName ?? 'none'})`);
  } catch (err) {
    logFn?.(`Workspace context failed: ${(err as Error).message ?? String(err)}`);
  }
}

function throwIfMcpErrorPayload(name: string, payload: unknown): void {
  if (!payload) return;
  if (typeof payload === 'object' && payload !== null) {
    const obj = payload as Record<string, unknown>;
    if (obj.error && !obj.runs && !obj.run && !obj.stage_results && obj.success !== true) {
      throw new Error(String(obj.message || obj.error));
    }
    if (typeof obj.text === 'string') {
      const text = obj.text.trim();
      if (text.includes('[MCP_ERROR]') || text.startsWith('Pipeline failed:') || text.startsWith('Lookup failed:')) {
        throw new Error(text.split('\n').pop()?.trim() || text);
      }
    }
  }
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (text.includes('[MCP_ERROR]') || text.startsWith('Pipeline failed:') || text.startsWith('Lookup failed:')) {
      throw new Error(text);
    }
  }
}

function parsePipelineLatest(status: unknown): Record<string, unknown> | null {
  if (!status || typeof status !== 'object') return null;
  const data = status as Record<string, unknown>;
  if (data.error) return null;
  if (Array.isArray(data.runs) && data.runs[0] && typeof data.runs[0] === 'object') {
    return data.runs[0] as Record<string, unknown>;
  }
  if (data.run && typeof data.run === 'object') return data.run as Record<string, unknown>;
  if (data.status && data.stage_results) return data;
  return null;
}

async function ensureSkillSyncedForMcp(
  mcpUrl: string,
  apiKey: string,
  workspaceRoot: string,
  target: SkillTarget,
  logFn?: (msg: string) => void,
): Promise<string> {
  await setModelBoundWorkspaceContext(mcpUrl, apiKey, workspaceRoot, logFn);

  if (target.filePath) {
    const content = fs.readFileSync(target.filePath, 'utf8');
    const { repoUrl, branch } = getRepoInfo(workspaceRoot);
    const sync = await callMcpTool(mcpUrl, apiKey, 'sync_skill_from_ide', {
      repo_url: repoUrl,
      branch,
      source_ide: sourceIdeFromPath(workspaceRoot, target.filePath, detectIde()),
      source_path: target.relativePath,
      body_md: content,
    });
    const syncedId = typeof sync?.skill_id === 'string' ? sync.skill_id : undefined;
    if (syncedId && UUID_RE.test(syncedId)) {
      registerSkill(syncedId, (sync?.slug as string | undefined) ?? target.slug, target.filePath);
      markLastSynced(target.filePath, content, syncedId);
      logFn?.(`Linked ${target.relativePath} → skill ${syncedId} (${String(sync?.action ?? 'synced')})`);
      return syncedId;
    }
  }

  if (UUID_RE.test(target.skillId)) return target.skillId;

  return ensureSkillUuid(mcpUrl, apiKey, target, logFn);
}

async function ensureSkillUuid(
  mcpUrl: string,
  apiKey: string,
  target: SkillTarget,
  logFn?: (msg: string) => void,
): Promise<string> {
  if (UUID_RE.test(target.skillId)) return target.skillId;

  if (target.filePath) {
    const last = getLastSyncedHash(target.filePath);
    if (last?.skillId && UUID_RE.test(last.skillId)) return last.skillId;
  }

  try {
    const parsed = await fetchSkillViaMcp(mcpUrl, apiKey, target.skillId, logFn);
    if (parsed.id && UUID_RE.test(parsed.id)) {
      if (target.filePath) registerSkill(parsed.id, parsed.slug, target.filePath);
      return parsed.id;
    }
  } catch {
    /* slug lookup failed — fall through */
  }

  if (target.filePath) {
    throw new Error(
      `"${target.label}" is not linked to ModelBound yet. Save the file once to sync it, then retry.`,
    );
  }
  throw new Error(`Could not find "${target.label}" in ModelBound. Check the skill name or sync the file first.`);
}

function loadRegistry(ctx: vscode.ExtensionContext): void {
  extensionContext = ctx;
  skillRegistry = ctx.workspaceState.get<Record<string, SkillRegistryEntry>>(REGISTRY_KEY, {}) ?? {};
}

function saveRegistry(): void {
  if (!extensionContext) return;
  void extensionContext.workspaceState.update(REGISTRY_KEY, skillRegistry);
}

function registerSkill(skillId: string | null | undefined, slug: string | null | undefined, filePath?: string | null): void {
  if (!skillId) return;
  const entry = skillRegistry[skillId] ?? { slug: slug ?? null, paths: [] };
  if (slug && !entry.slug) entry.slug = slug;
  if (filePath) {
    const abs = path.resolve(filePath);
    if (!entry.paths.includes(abs)) entry.paths.push(abs);
  }
  skillRegistry[skillId] = entry;
  // Also alias by slug for lookups that only know the slug.
  if (slug && slug !== skillId) {
    const slugEntry = skillRegistry[slug] ?? { slug, paths: [] };
    for (const p of entry.paths) if (!slugEntry.paths.includes(p)) slugEntry.paths.push(p);
    skillRegistry[slug] = slugEntry;
  }
  saveRegistry();
}

function lookupRegistry(skillId: string | null | undefined, slug: string | null | undefined): SkillRegistryEntry | null {
  for (const key of [skillId, slug]) {
    if (key && skillRegistry[key]) {
      const entry = skillRegistry[key];
      // Drop stale paths
      const live = entry.paths.filter((p) => {
        try { return fs.existsSync(p); } catch { return false; }
      });
      if (live.length !== entry.paths.length) {
        entry.paths = live;
        saveRegistry();
      }
      if (live.length > 0) return entry;
    }
  }
  return null;
}

function log(msg: string): void {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('ModelBound');
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

type RepoInfo = { repoUrl: string | null; branch: string | null };

/**
 * Resolve git repo metadata from a workspace folder.
 */
function getRepoInfo(workspaceRoot: string): RepoInfo {
  const run = (args: string[]): string => {
    return execSync(`git ${args.join(' ')}`, {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  };

  let toplevel = workspaceRoot;
  try {
    toplevel = run(['-C', JSON.stringify(workspaceRoot), 'rev-parse', '--show-toplevel']) || workspaceRoot;
  } catch (err) {
    log(`getRepoInfo: not a git repo at ${workspaceRoot} (${(err as Error).message?.split('\n')[0] ?? 'unknown'})`);
    return { repoUrl: null, branch: null };
  }

  const runIn = (args: string[]): string =>
    execSync(`git ${['-C', JSON.stringify(toplevel), ...args].join(' ')}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();

  let branch: string | null = null;
  try {
    branch = runIn(['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  } catch {
    branch = null;
  }

  let remote = '';
  try {
    remote = runIn(['config', '--get', 'remote.origin.url']);
  } catch {
    try {
      const remotes = runIn(['remote']).split(/\s+/).filter(Boolean);
      if (remotes.length > 0) {
        remote = runIn(['remote', 'get-url', remotes[0]]);
      }
    } catch (err) {
      log(`getRepoInfo: no usable remote at ${toplevel} (${(err as Error).message?.split('\n')[0] ?? 'unknown'})`);
    }
  }

  if (!remote) return { repoUrl: null, branch };

  const repoUrl = remote
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
  return { repoUrl, branch };
}

function detectIde(): string {
  const app = (process.env.TERM_PROGRAM || '').toLowerCase();
  if (process.env.CURSOR_TRACE_ID || app.includes('cursor')) return 'cursor';
  if (process.env.KIRO_SESSION) return 'kiro';
  if (process.env.CLAUDE_CODE) return 'claude';
  if (process.env.VSCODE_PID) return 'vscode';
  return 'unknown';
}

function relPath(workspaceRoot: string, fsPath: string): string {
  return path.relative(workspaceRoot, fsPath).split(path.sep).join('/');
}


function isWatchablePath(workspaceRoot: string, fsPath: string): boolean {
  const rel = relPath(workspaceRoot, fsPath);
  if (!rel || rel.startsWith('..')) return false;
  if (!rel.endsWith('.md') && !rel.endsWith('.mdc') && !rel.endsWith('.json')) return false;
  return WATCH_ROOTS.some((root) => rel === root.replace(/\/$/, '') || rel.startsWith(root));
}


function isSafeRelativePath(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const normalized = rel.split(path.sep).join('/');
  return !normalized.split('/').includes('..');
}

function sourceIdeFromPath(workspaceRoot: string, fsPath: string, fallback: string): string {
  const rel = relPath(workspaceRoot, fsPath);
  if (rel.startsWith('.cursor/')) return 'cursor';
  if (rel.startsWith('.kiro/')) return 'kiro';
  if (rel.startsWith('.claude/')) return 'claude';
  if (rel.startsWith('.agents/')) return 'agents';
  if (rel.startsWith('.modelbound/')) return 'modelbound';
  return fallback;
}

function skillIdFromPath(workspaceRoot: string, fsPath: string): string {
  const rel = relPath(workspaceRoot, fsPath);
  const nativeSkillFile = rel.match(/^(?:\.agents\/skills|\.kiro\/skills|\.claude\/skills)\/([^/]+)\/SKILL\.md$/);
  if (nativeSkillFile) return nativeSkillFile[1];
  return path.basename(fsPath, path.extname(fsPath));
}

function isModelBoundErrorContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return (
    /^skill not found\b/.test(normalized) ||
    /^not found\b/.test(normalized) ||
    /^error[:\s]/.test(normalized)
  );
}

type ParsedSkillPayload = {
  content: string;
  id: string;
  slug: string | null;
  sourcePath: string | null;
};

function parseSkillMcpPayload(data: unknown, skillId: string): ParsedSkillPayload | null {
  if (!data) return null;
  const content =
    (typeof data === 'object' &&
    data !== null &&
    'text' in data &&
    typeof (data as { text?: unknown }).text === 'string'
      ? (data as { text: string }).text
      : typeof data === 'string'
        ? data
        : '') || '';
  if (!content) return null;
  const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
  const id = String(obj?.skill_id ?? obj?.id ?? skillId);
  const slug = typeof obj?.slug === 'string' ? obj.slug : null;
  const sourcePath = typeof obj?.source_path === 'string' ? obj.source_path : null;
  return { content, id, slug, sourcePath };
}

async function fetchSkillViaMcp(
  mcpUrl: string,
  activeApiKey: string,
  skillId: string,
  logFn?: (msg: string) => void,
): Promise<ParsedSkillPayload> {
  const attempts: Array<{ label: string; call: () => Promise<unknown> }> = [
    {
      label: 'get_skill',
      call: () => callMcpTool(mcpUrl, activeApiKey, 'get_skill', { skill_id: skillId, file_id: skillId }),
    },
    {
      label: 'skills.get',
      call: () => callMcpTool(mcpUrl, activeApiKey, 'skills.get', { skill_id: skillId, file_id: skillId }),
    },
    {
      label: 'modelbound.callTool/skills.get',
      call: () =>
        callMcpTool(mcpUrl, activeApiKey, 'modelbound.callTool', {
          tool_name: 'skills.get',
          arguments: { skill_id: skillId, file_id: skillId },
        }),
    },
  ];

  let lastErr: Error | undefined;
  for (const attempt of attempts) {
    try {
      const data = await attempt.call();
      const parsed = parseSkillMcpPayload(data, skillId);
      if (parsed && !isModelBoundErrorContent(parsed.content)) {
        logFn?.(`Fetched skill ${skillId} via ${attempt.label}`);
        return parsed;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      logFn?.(`Fetch ${skillId} via ${attempt.label} failed: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error(`Skill not found or empty (${skillId})`);
}

function bootstrapSkillRegistryFromWorkspace(workspaceRoot: string): void {
  forEachWatchableFile(workspaceRoot, (absPath) => {
    if (!isWatchablePath(workspaceRoot, absPath)) return;
    const slug = skillIdFromPath(workspaceRoot, absPath);
    registerSkill(slug, slug, absPath);
  });
}

function markSelfWrite(fsPath: string): void {
  recentSelfWrites.set(path.resolve(fsPath), Date.now());
}

function shouldSuppressSelfWrite(fsPath: string): boolean {
  const key = path.resolve(fsPath);
  const ts = recentSelfWrites.get(key);
  if (!ts) return false;
  if (Date.now() - ts <= SELF_WRITE_SUPPRESS_MS) {
    recentSelfWrites.delete(key);
    return true;
  }
  recentSelfWrites.delete(key);
  return false;
}

function markLocalPush(skillId: string | null | undefined): void {
  if (!skillId) return;
  recentLocalPushes.set(skillId, Date.now());
}

function shouldSuppressRecentLocalPush(skillId: string | null | undefined, row?: { updated_at?: string | null; last_ide_sync_at?: string | null }): boolean {
  if (!skillId) return false;
  const ts = recentLocalPushes.get(skillId);
  if (!ts) return false;
  if (Date.now() - ts > RECENT_LOCAL_PUSH_SUPPRESS_MS) {
    recentLocalPushes.delete(skillId);
    return false;
  }

  const updatedAt = row?.updated_at ? new Date(row.updated_at).getTime() : 0;
  const lastIdeSyncAt = row?.last_ide_sync_at ? new Date(row.last_ide_sync_at).getTime() : 0;
  if (!updatedAt || !lastIdeSyncAt) return false;

  const isIdeEcho = Math.abs(updatedAt - lastIdeSyncAt) <= 5000 && lastIdeSyncAt >= ts - 15000;
  if (isIdeEcho) return true;
  return false;
}

function scheduleDebounced(key: string, fn: () => void): void {
  const existing = pendingSyncTimers.get(key);
  if (existing) clearTimeout(existing);
  pendingSyncTimers.set(key, setTimeout(() => {
    pendingSyncTimers.delete(key);
    fn();
  }, DEBOUNCE_MS));
}

/**
 * Call an MCP tool over Streamable HTTP. The spec requires
 * Accept: application/json, text/event-stream — without it,
 * compliant servers respond with 406.
 *
 * Returns the parsed JSON-RPC `result` payload (or null if the
 * server returned no result, e.g. for fire-and-forget calls).
 */
async function callMcpTool(
  mcpUrl: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>
): Promise<any> {
  // `fetch failed` from undici is a generic wrapper that hides the real
  // network cause (DNS, IPv6 happy-eyeballs, proxy, TLS, etc.).
  // We unwrap `err.cause` and retry once on transient network failures so
  // users get actionable errors instead of a bare "fetch failed".
  const TRANSIENT = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
  ]);

  const describeNetworkError = (err: unknown): string => {
    const e = err as any;
    const cause = e?.cause ?? e;
    const parts: string[] = [];
    if (cause?.code) parts.push(`code=${cause.code}`);
    if (cause?.errno) parts.push(`errno=${cause.errno}`);
    if (cause?.syscall) parts.push(`syscall=${cause.syscall}`);
    if (cause?.address) parts.push(`address=${cause.address}`);
    if (cause?.port) parts.push(`port=${cause.port}`);
    const msg = cause?.message || e?.message || String(err);
    const detail = parts.length ? ` (${parts.join(', ')})` : '';
    let host = mcpUrl;
    try { host = new URL(mcpUrl).host; } catch { /* noop */ }
    return `Network error contacting ${host}: ${msg}${detail}. Check internet/VPN/proxy and that ${host} is reachable.`;
  };

  const attempt = async (): Promise<Response> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      return await fetch(mcpUrl, {
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
          params: { name, arguments: args },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res: Response;
  try {
    res = await attempt();
  } catch (err) {
    const code = (err as any)?.cause?.code || (err as any)?.code;
    if (code && TRANSIENT.has(code)) {
      log(`MCP ${name}: transient ${code}, retrying once...`);
      await new Promise((r) => setTimeout(r, 1000));
      try {
        res = await attempt();
      } catch (err2) {
        const detailed = describeNetworkError(err2);
        log(`MCP ${name} failed after retry: ${detailed}`);
        throw new Error(detailed);
      }
    } else {
      const detailed = describeNetworkError(err);
      log(`MCP ${name} failed: ${detailed}`);
      throw new Error(detailed);
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MCP ${name} failed: ${res.status} ${body}`);
  }

  const contentType = res.headers.get('content-type') || '';
  let body = '';
  if (contentType.includes('text/event-stream')) {
    // Take the last data: line of the SSE stream.
    const raw = await res.text();
    const dataLines = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    body = dataLines[dataLines.length - 1] || '';
  } else {
    body = await res.text();
  }

  if (!body) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed?.error) {
    throw new Error(`MCP ${name} error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  // tools/call results follow `{ content: [{ type, text }], structuredContent? }`.
  // Prefer structuredContent if present, otherwise try to JSON-parse the first text block.
  const result = parsed?.result ?? null;
  if (!result) return null;
  if (result.structuredContent) {
    throwIfMcpErrorPayload(name, result.structuredContent);
    return result.structuredContent;
  }
  const txt = result.content?.[0]?.text;
  if (typeof txt === 'string') {
    if (txt.includes('[MCP_ERROR]') || txt.startsWith('Pipeline failed:') || txt.startsWith('Lookup failed:')) {
      throw new Error(txt.split('\n').pop()?.trim() || txt.trim());
    }
    try {
      const parsedTxt = JSON.parse(txt);
      throwIfMcpErrorPayload(name, parsedTxt);
      return parsedTxt;
    } catch (err) {
      if (err instanceof Error && !(err instanceof SyntaxError)) throw err;
      return { text: txt };
    }
  }
  throwIfMcpErrorPayload(name, result);
  return result;
}

function getSkillOutputPaths(workspaceRoot: string, skillId: string): string[] {
  const paths: string[] = [];

  const modelboundDir = path.join(workspaceRoot, '.modelbound');
  if (!fs.existsSync(modelboundDir)) fs.mkdirSync(modelboundDir, { recursive: true });
  paths.push(path.join(modelboundDir, `${skillId}.md`));

  const kiroDir = path.join(workspaceRoot, '.kiro');
  if (fs.existsSync(kiroDir)) {
    const kiroSkills = path.join(kiroDir, 'skills');
    if (!fs.existsSync(kiroSkills)) fs.mkdirSync(kiroSkills, { recursive: true });
    paths.push(path.join(kiroSkills, `${skillId}.md`));
  }

  const agentsDir = path.join(workspaceRoot, '.agents', 'skills', skillId);
  if (fs.existsSync(path.join(workspaceRoot, '.agents'))) {
    fs.mkdirSync(agentsDir, { recursive: true });
    paths.push(path.join(agentsDir, 'SKILL.md'));
  }

  const cursorDir = path.join(workspaceRoot, '.cursor');
  if (fs.existsSync(cursorDir)) {
    const cursorRules = path.join(cursorDir, 'rules');
    if (!fs.existsSync(cursorRules)) fs.mkdirSync(cursorRules, { recursive: true });
    paths.push(path.join(cursorRules, `${skillId}.md`));
  }

  const claudeDir = path.join(workspaceRoot, '.claude');
  if (fs.existsSync(claudeDir)) {
    paths.push(path.join(claudeDir, `${skillId}.md`));
  }

  return paths;
}

/**
 * Try to infer a ModelBound skill identifier (UUID or slug) from the active
 * editor file path. Supports `.agents/skills/<slug>/SKILL.md`,
 * `.modelbound/<id>.md`, `.kiro/skills/<id>.md`, `.cursor/rules/<id>.md`,
 * and `.claude/<id>.md`.
 *
 * The MCP server resolves slugs to skill UUIDs server-side.
 */
function detectActiveSkillId(workspaceRoot: string): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const rel = relPath(workspaceRoot, editor.document.uri.fsPath);

  const agents = rel.match(/^\.agents\/skills\/([^/]+)\/SKILL\.md$/);
  if (agents) return agents[1];

  const generic = rel.match(/^(?:\.modelbound|\.kiro\/skills|\.cursor\/rules|\.claude)\/([^/]+)\.(?:md|json)$/);
  if (generic) return generic[1];

  return null;
}

function pipelineHtml(skillLabel: string): string {
  // Minimal, theme-aware status panel. Polls every 2s via postMessage.
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 14px; color: var(--vscode-foreground); }
  h2 { margin: 0 0 4px; font-size: 14px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--vscode-panel-border); font-size: 12px; }
  .badge { padding: 1px 6px; border-radius: 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  .b-pass { background: rgba(46, 160, 67, 0.18); color: #3fb950; }
  .b-fail { background: rgba(248, 81, 73, 0.18); color: #f85149; }
  .b-run  { background: rgba(56, 139, 253, 0.18); color: #58a6ff; }
  .b-idle { background: rgba(139, 148, 158, 0.18); color: #8b949e; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
</style>
</head>
<body>
<h2>Skill Development Pipeline</h2>
<div class="sub">Skill: <code>${skillLabel}</code></div>
<div id="root"><div class="meta">Loading status…</div></div>
<script>
  const vscodeApi = acquireVsCodeApi();
  function render(state) {
    const root = document.getElementById('root');
    if (!state) { root.innerHTML = '<div class="meta">Waiting for pipeline status…</div>'; return; }
    const stages = state.stage_results || {};
    const stageRow = (key, label) => {
      const s = stages[key];
      const status = s?.status || 'idle';
      const cls = status === 'passed' ? 'b-pass' : status === 'failed' ? 'b-fail' : status === 'running' ? 'b-run' : 'b-idle';
      const detail = s?.summary || s?.failed_reason || '';
      return '<div class="row"><span class="badge ' + cls + '">' + status + '</span><strong>' + label + '</strong><span class="meta" style="margin-left:auto">' + (detail || '') + '</span></div>';
    };
    root.innerHTML =
      '<div class="meta">Run ' + (state.id || '').slice(0,8) + ' · v' + (state.version || '—') + ' · ' + (state.status || 'unknown') + '</div>' +
      stageRow('test_optimize', 'Test & Optimize') +
      stageRow('production', 'Production') +
      '<pre>' + JSON.stringify(state.stage_results || {}, null, 2) + '</pre>';
  }
  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'state') render(ev.data.state);
    if (ev.data?.type === 'error') {
      document.getElementById('root').innerHTML = '<div class="meta" style="color:#f85149">' + ev.data.message + '</div>';
    }
  });
  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

export async function activate(context: vscode.ExtensionContext) {
  loadRegistry(context);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;
  const workspaceRoot = workspaceFolder.uri.fsPath;
  bootstrapSkillRegistryFromWorkspace(workspaceRoot);

  const config = vscode.workspace.getConfiguration('modelbound');
  const workspaceFolderUri = workspaceFolder.uri;
  const readConfigKey = (cfg: vscode.WorkspaceConfiguration): string | undefined => {
    const value = cfg.get<string>('apiKey');
    return value?.trim() ? value.trim() : undefined;
  };
  const getConfiguredApiKey = (): string | undefined => {
    // Read global first so an empty workspace override cannot hide a valid user key.
    const globalKey = readConfigKey(vscode.workspace.getConfiguration('modelbound', null));
    if (globalKey) return globalKey;

    const rootGlobal = vscode.workspace.getConfiguration(undefined, null).get<string>('modelbound.apiKey')?.trim();
    if (rootGlobal) return rootGlobal;

    const folderKey = readConfigKey(vscode.workspace.getConfiguration('modelbound', workspaceFolderUri));
    if (folderKey) return folderKey;

    const inspected = vscode.workspace.getConfiguration(undefined, null).inspect<string>('modelbound.apiKey');
    for (const value of [inspected?.globalValue, inspected?.workspaceValue, inspected?.workspaceFolderValue]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  const resolveActiveApiKey = async (): Promise<string | undefined> => {
    const configured = getConfiguredApiKey();
    if (configured) {
      const stored = await context.secrets.get('modelbound.token');
      if (stored !== configured) {
        await setToken(context.secrets, configured);
      }
      return configured;
    }
    const secret = (await context.secrets.get('modelbound.token'))?.trim();
    if (secret) return secret;
    const env = process.env.MODELBOUND_API_KEY?.trim();
    if (env) return env;
    const ctx = await getCtx(context.secrets);
    return ctx.token?.trim() || undefined;
  };
  const autoSync = config.get<boolean>('autoSync', true);
  const mcpUrl =
    config.get<string>('mcpUrl') || 'https://mcp.modelbound.co';
  let apiKey: string | undefined = await resolveActiveApiKey();
  let cloudPullWatcher: RealtimeSync | undefined;
  let restartCloudPullWatcher: (() => void) | undefined;

  const saveAuthKey = async (key: string) => {
    apiKey = key;
    await setToken(context.secrets, key);
    await writeAuthCache(context.globalState, key);
    restartCloudPullWatcher?.();
  };

  const requireApiKeyForSync = async (source: string): Promise<string | undefined> => {
    const resolved = await resolveActiveApiKey();
    const auth = await prepareSyncAuth({
      apiKey: resolved,
      mcpUrl,
      globalState: context.globalState,
      log,
    });
    if (auth.ok) {
      apiKey = auth.apiKey;
      return auth.apiKey;
    }
    const reason = auth.reason === 'invalid' ? 'invalid' : 'missing';
    log(`${source}: auth required (${reason}).`);
    const key = await requestModelBoundCredentials({
      reason,
      log,
      onKeySaved: saveAuthKey,
    });
    if (key) {
      apiKey = key;
      restartCloudPullWatcher?.();
      return key;
    }
    return undefined;
  };

  // 0. Onboarding: validate stored keys silently on startup. Only prompt when
  // the user explicitly signs in or a sync/MCP call proves auth failed.
  const promptSignIn = async (): Promise<string | undefined> =>
    requestModelBoundCredentials({ reason: 'manual', log, onKeySaved: saveAuthKey });

  const handleAuthFailure = async (source: string, message: string): Promise<boolean> => {
    if (!isAuthFailureMessage(message)) return false;
    log(`Auth failure during ${source}: ${message}`);
    const key = await requestModelBoundCredentials({
      reason: 'invalid',
      log,
      onKeySaved: saveAuthKey,
    });
    if (key) {
      apiKey = key;
      return true;
    }
    return false;
  };

  // 0a. Status bar & CodeLens for pipeline/versions/health
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarItem.text = '$(sync) ModelBound Sync';
  statusBarItem.command = 'modelbound.syncCurrentFile';
  statusBarItem.tooltip = 'ModelBound — sync the current skill/context file';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  const statusBar = { dispose: () => statusBarItem.dispose() };
  const skillLens = new SkillCodeLensProvider(apiKey || '', mcpUrl, (document) => {
    const target = resolveSkillFromPath(workspaceRoot, document.uri.fsPath);
    return target ? { skillId: target.skillId, label: target.label } : null;
  });
  const codeLensSelector: vscode.DocumentSelector = [
    { pattern: '**/.modelbound/**/*.md' },
    { pattern: '**/.modelbound/**/*.json' },
    { pattern: '**/.kiro/skills/**/*.md' },
    { pattern: '**/.cursor/rules/**/*.md' },
    { pattern: '**/.cursor/rules/**/*.mdc' },
    { pattern: '**/.claude/**/*.md' },
    { pattern: '**/.agents/skills/**/SKILL.md' },
    { pattern: '**/SKILL.md' },
  ];
  vscode.languages.registerCodeLensProvider(codeLensSelector, skillLens);

  // 1. Ensure canonical .modelbound/ exists
  const localFolder = path.join(workspaceRoot, '.modelbound');
  if (!fs.existsSync(localFolder)) fs.mkdirSync(localFolder, { recursive: true });

  const ide = detectIde();
  log(`Activated. ide=${ide} workspace=${workspaceRoot} autoSync=${autoSync ? 'on' : 'off'} signedIn=${apiKey ? 'yes' : 'no'}`);
  const configListener = vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (!event.affectsConfiguration('modelbound.apiKey') && !event.affectsConfiguration('modelbound.mcpUrl')) return;
    apiKey = await resolveActiveApiKey();
    skillLens.setAuth(apiKey || '', mcpUrl);
    log(`Configuration changed: ModelBound API key is ${apiKey ? 'available' : 'not configured'}.`);
    restartCloudPullWatcher?.();
  });
  context.subscriptions.push(configListener);

  const fetchSkillFromCloud = async (skillId: string, activeApiKey: string): Promise<{ content: string; id: string; slug: string | null }> => {
    const parsed = await fetchSkillViaMcp(mcpUrl, activeApiKey, skillId, log);
    return { content: parsed.content, id: parsed.id, slug: parsed.slug };
  };

  const writeCloudSkillToPath = (cloud: { content: string; id: string; slug: string | null }, destPath: string): void => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    markSelfWrite(destPath);
    fs.writeFileSync(destPath, cloud.content, 'utf8');
    registerSkill(cloud.id, cloud.slug, destPath);
    markLastSynced(destPath, cloud.content, cloud.id);
  };

  type SyncConflictArgs = {
    filePath: string;
    relativePath: string;
    skillId: string;
    content: string;
    sourceIdeName: string;
    activeApiKey: string;
    conflictSkillId: string | undefined;
    message?: string;
  };

  let handleSyncConflict: (args: SyncConflictArgs) => Promise<void>;

  const handleProtectedSyncRejection = async (
    message: string,
    localUri: vscode.Uri,
    localSkillId: string,
    activeApiKey: string,
  ): Promise<boolean> => {
    if (!message.includes('Refusing to write skill body_md')) return false;
    const rejectedSkillId = message.match(/skill_id=([^) ,]+)/)?.[1] || localSkillId;
    const relativePath = relPath(workspaceRoot, localUri.fsPath);
    log(`Protected sync rejection for ${relativePath}; cloud skill=${rejectedSkillId}`);

    const pick = await vscode.window.showWarningMessage(
      `ModelBound rejected "${relativePath}" because the local file looks like an error response. Compare with the cloud copy before choosing what to keep.`,
      { modal: false },
      'Compare with Cloud',
      'Pull Cloud Version',
      'Open in ModelBound',
      'Stop',
    );

    if (!pick || pick === 'Stop') return true;
    if (pick === 'Open in ModelBound') {
      vscode.env.openExternal(vscode.Uri.parse(`https://modelbound.co/skills/${rejectedSkillId}`));
      return true;
    }

    try {
      const cloud = await fetchSkillFromCloud(rejectedSkillId, activeApiKey);
      if (pick === 'Compare with Cloud') {
        const doc = await vscode.workspace.openTextDocument({
          content: cloud.content,
          language: 'markdown',
        });
        await vscode.commands.executeCommand(
          'vscode.diff',
          doc.uri,
          localUri,
          `ModelBound cloud ↔ ${relativePath}`,
        );
        const afterCompare = await vscode.window.showWarningMessage(
          `Compared cloud copy with ${relativePath}.`,
          { modal: false },
          'Pull Cloud Version',
          'Keep Local for Now',
        );
        if (afterCompare !== 'Pull Cloud Version') return true;
      }

      writeCloudSkillToPath(cloud, localUri.fsPath);
      vscode.window.setStatusBarMessage(`$(cloud-download) ModelBound: Pulled cloud version for ${localSkillId}`, 3000);
      vscode.window.showInformationMessage(`ModelBound: restored ${relativePath} from the cloud copy.`);
      return true;
    } catch (cloudErr) {
      const cloudMsg = cloudErr instanceof Error ? cloudErr.message : String(cloudErr);
      log(`Unable to recover ${relativePath} from cloud: ${cloudMsg}`);
      vscode.window.showErrorMessage(
        `ModelBound could not find a usable cloud copy for ${localSkillId}. You can recreate the skill or keep editing locally.`
      );
      return true;
    }
  };

  const syncFileNow = async (uri: vscode.Uri, manual = false) => {
    const filePath = uri.fsPath;
    const relativePath = relPath(workspaceRoot, filePath);
    if (!isWatchablePath(workspaceRoot, filePath)) {
      log(`Ignored ${manual ? 'manual sync' : 'save'} for non-watchable path ${relativePath}`);
      if (manual) {
        vscode.window.showWarningMessage(`ModelBound: ${relativePath} is not in a watched context directory.`);
      }
      return;
    }
    const activeApiKey = await requireApiKeyForSync(`sync ${relativePath}`);
    if (!activeApiKey) return;
    if (shouldSuppressSelfWrite(filePath)) {
      log(`Skipped self-originated sync for ${relativePath}`);
      return;
    }
    const pathKey = path.resolve(filePath);
    if (inFlightPathSyncs.has(pathKey)) {
      log(`Skipped already-running sync for ${relativePath}`);
      return;
    }
    const skillId = skillIdFromPath(workspaceRoot, filePath);
    inFlightPathSyncs.add(pathKey);
    vscode.window.setStatusBarMessage(`$(sync~spin) ModelBound: Syncing ${skillId}...`);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { repoUrl, branch } = getRepoInfo(workspaceRoot);
      const sourceIdeName = sourceIdeFromPath(workspaceRoot, filePath, ide);
      log(`Syncing ${relativePath} → ModelBound (source=${sourceIdeName}, repo=${repoUrl ?? 'none'}, branch=${branch ?? 'none'})`);
      const syncResult = await callMcpTool(mcpUrl, activeApiKey, 'modelbound.callTool', {
        tool_name: 'skills.syncFromIde',
        arguments: {
          repo_url: repoUrl,
          branch,
          source_ide: sourceIdeName,
          source_path: relativePath,
          body_md: content,
        },
      });

        // Server returns a JSON-encoded action payload. Handle conflict locally
        // by offering the user an in-IDE force-resolve, rather than just dying.
        if ((syncResult as any)?.action === 'conflict') {
          await handleSyncConflict({
            filePath,
            relativePath,
            skillId,
            content,
            sourceIdeName,
            activeApiKey,
            conflictSkillId: (syncResult as any)?.skill_id as string | undefined,
            message: (syncResult as any)?.message,
          });
          return;
        }

        const returnedId = (syncResult as any)?.skill_id || skillId;
        const returnedSlug = (syncResult as any)?.slug || skillId;
        markLocalPush(returnedId);
        if (returnedSlug && returnedSlug !== returnedId) markLocalPush(returnedSlug);
        registerSkill(returnedId, returnedSlug, filePath);
        markLastSynced(filePath, content, returnedId);
        await writeAuthCache(context.globalState, activeApiKey);
        log(`Synced ${relativePath} → skill=${returnedId} slug=${returnedSlug} action=${(syncResult as any)?.action ?? 'updated'}`);
        vscode.window.setStatusBarMessage(`$(check) ModelBound: Synced ${skillId}`, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Sync failed for ${skillId}: ${msg}`);
      if (await handleProtectedSyncRejection(msg, uri, skillId, activeApiKey)) return;
      if (await handleAuthFailure(`sync ${relativePath}`, msg)) return;
      vscode.window.showErrorMessage(`ModelBound sync failed for ${skillId}: ${msg}`);
    } finally {
      inFlightPathSyncs.delete(pathKey);
    }
  };

  const syncFile = (uri: vscode.Uri) => {
    const filePath = uri.fsPath;
    const relativePath = relPath(workspaceRoot, filePath);
    if (!isWatchablePath(workspaceRoot, filePath)) return;
    if (!autoSync) {
      log(`Skipped auto-sync for ${relativePath}: modelbound.autoSync is off.`);
      return;
    }
    log(`Queued auto-sync for ${relativePath}`);
    scheduleDebounced(`sync:${path.resolve(filePath)}`, () => {
      syncFileNow(uri).catch((err) => log(`Unhandled sync error: ${(err as Error).message ?? String(err)}`));
    });
  };

  const deleteFile = async (uri: vscode.Uri) => {
    const filePath = uri.fsPath;
    const relativePath = relPath(workspaceRoot, filePath);
    if (!isWatchablePath(workspaceRoot, filePath)) return;
    if (!autoSync) {
      log(`Skipped delete sync for ${relativePath}: modelbound.autoSync is off.`);
      return;
    }
    const activeApiKey = await requireApiKeyForSync(`delete ${relativePath}`);
    if (!activeApiKey) return;
    const skillId = skillIdFromPath(workspaceRoot, filePath);
    try {
      const { repoUrl } = getRepoInfo(workspaceRoot);
      log(`Deleting ${relativePath} from ModelBound (repo=${repoUrl ?? 'none'})`);
      await callMcpTool(mcpUrl, activeApiKey, 'modelbound.callTool', {
        tool_name: 'skills.deleteFromIde',
        arguments: {
          repo_url: repoUrl,
          source_path: relativePath,
        },
      });
      vscode.window.setStatusBarMessage(`$(trash) ModelBound: Removed ${skillId}`, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Delete failed for ${skillId}: ${msg}`);
      vscode.window.showErrorMessage(`ModelBound delete failed for ${skillId}: ${msg}`);
    }
  };

  // 2. Set up file watchers (add/change/delete) for every glob. Keep them
  // registered even when auth is missing so users get a visible reason instead
  // of silent no-ops when editing watched files.
  if (autoSync) {
    for (const glob of WATCH_GLOBS) {
      const pattern = new vscode.RelativePattern(workspaceFolder, glob);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(syncFile);
      watcher.onDidChange(syncFile);
      watcher.onDidDelete(deleteFile);
      watchers.push(watcher);
      context.subscriptions.push(watcher);
    }
    log(`Watching ${WATCH_GLOBS.length} ModelBound glob(s).`);
  } else {
    log('Auto-sync is disabled; file watchers were not started.');
  }

  const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme === 'file') syncFile(doc.uri);
  });
  context.subscriptions.push(saveListener);

  // Reusable: fetch a skill from MCP and write it to every relevant local
  // location. Used by both the manual pull command and the realtime watcher.
  const pullSkillToDisk = async (skillId: string): Promise<{ paths: string[] }> => {
    const activeApiKey = apiKey || (await resolveActiveApiKey());
    if (!activeApiKey) throw new Error('Not signed in.');
    apiKey = activeApiKey;
    log(`Pulling skill ${skillId} from ModelBound…`);
    const parsed = await fetchSkillViaMcp(mcpUrl, activeApiKey, skillId, log);
    if (isModelBoundErrorContent(parsed.content)) {
      throw new Error(`ModelBound returned error content for "${skillId}", so it was not written locally.`);
    }

    const { content, id: returnedId, slug: returnedSlug, sourcePath } = parsed;
    const registryEntry = lookupRegistry(returnedId, returnedSlug) || lookupRegistry(skillId, null);
    const outputPaths: string[] = registryEntry ? [...registryEntry.paths] : getSkillOutputPaths(workspaceRoot, returnedSlug || skillId);

    if (typeof sourcePath === 'string' && isSafeRelativePath(sourcePath)) {
      const sourceAbs = path.join(workspaceRoot, sourcePath);
      if (isWatchablePath(workspaceRoot, sourceAbs) && !outputPaths.includes(sourceAbs)) {
        outputPaths.unshift(sourceAbs);
      }
    }
    for (const destPath of outputPaths) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      markSelfWrite(destPath);
      fs.writeFileSync(destPath, content, 'utf8');
      registerSkill(returnedId, returnedSlug, destPath);
      markLastSynced(destPath, content, returnedId);
    }
    log(`Pulled ${returnedId} → ${outputPaths.map((p) => path.relative(workspaceRoot, p)).join(', ')}`);
    return { paths: outputPaths };
  };

  handleSyncConflict = async ({
    filePath,
    relativePath,
    skillId,
    content,
    sourceIdeName,
    activeApiKey,
    conflictSkillId,
    message,
  }: SyncConflictArgs): Promise<void> => {
    registerSkill(conflictSkillId, null, filePath);
    log(`Conflict for ${relativePath}: ${message ?? 'ModelBound has unsynced edits.'}`);
    const pick = await vscode.window.showWarningMessage(
      `ModelBound: "${skillId}" has unsynced edits on ModelBound. Choose how to resolve.`,
      { modal: false },
      'Keep my IDE version',
      'Use ModelBound version',
      'Open in ModelBound',
    );
    if (pick === 'Keep my IDE version' && conflictSkillId) {
      try {
        await callMcpTool(mcpUrl, activeApiKey, 'modelbound.callTool', {
          tool_name: 'skills.resolveConflict',
          arguments: {
            skill_id: conflictSkillId,
            resolution: 'keep_ide',
            body_md: content,
            source_ide: sourceIdeName,
          },
        });
        markLocalPush(conflictSkillId);
        markLastSynced(filePath, content, conflictSkillId);
        vscode.window.setStatusBarMessage(`$(check) ModelBound: Overwrote MB with IDE version`, 3000);
        log(`Force-resolved ${relativePath} → kept IDE version.`);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to force-resolve: ${m}`);
      }
    } else if (pick === 'Use ModelBound version' && conflictSkillId) {
      try {
        await callMcpTool(mcpUrl, activeApiKey, 'modelbound.callTool', {
          tool_name: 'skills.resolveConflict',
          arguments: {
            skill_id: conflictSkillId,
            resolution: 'keep_modelbound',
            source_ide: sourceIdeName,
          },
        });
        await pullSkillToDisk(conflictSkillId);
        vscode.window.setStatusBarMessage(`$(check) ModelBound: Pulled MB version`, 3000);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to pull MB version: ${m}`);
      }
    } else if (pick === 'Open in ModelBound' && conflictSkillId) {
      vscode.env.openExternal(vscode.Uri.parse(`https://modelbound.co/skills/${conflictSkillId}`));
    }
  };

  const reconcileSkillOnOpen = async (uri: vscode.Uri): Promise<void> => {
    if (!config.get<boolean>('syncOnOpen', true)) return;

    const filePath = uri.fsPath;
    const relativePath = relPath(workspaceRoot, filePath);
    if (!isWatchablePath(workspaceRoot, filePath)) return;
    if (!autoSync) return;
    if (shouldSuppressSelfWrite(filePath)) return;

    const pathKey = path.resolve(filePath);
    if (inFlightOpenReconciles.has(pathKey) || inFlightPathSyncs.has(pathKey)) return;

    const resolved = await resolveActiveApiKey();
    const auth = await prepareSyncAuth({
      apiKey: resolved,
      mcpUrl,
      globalState: context.globalState,
      log,
    });
    if (!auth.ok) {
      log(`Open reconcile: skipped ${relativePath} (${auth.reason ?? 'not signed in'})`);
      return;
    }
    const activeApiKey = auth.apiKey;
    apiKey = activeApiKey;

    const skillId = skillIdFromPath(workspaceRoot, filePath);
    inFlightOpenReconciles.add(pathKey);
    try {
      log(`Open reconcile: checking ${relativePath} against ModelBound…`);
      const localContent = fs.readFileSync(filePath, 'utf8');
      const localHash = hashContent(localContent);
      const lastSynced = getLastSyncedHash(filePath);
      const cloudSkillId = resolveCloudSkillId(filePath, skillId);

      let cloud: ParsedSkillPayload;
      try {
        cloud = await fetchSkillViaMcp(mcpUrl, activeApiKey, cloudSkillId, log);
      } catch (err) {
        log(`Open reconcile: no cloud copy for ${skillId} (${(err as Error).message})`);
        return;
      }
      registerSkill(cloud.id, cloud.slug, filePath);

      const cloudHash = hashContent(cloud.content);
      if (cloudHash === localHash) {
        markLastSynced(filePath, localContent, cloud.id);
        log(`Open reconcile: ${relativePath} already matches cloud`);
        return;
      }

      if (lastSynced && lastSynced.hash === localHash) {
        log(`Open reconcile: pulling cloud update for ${relativePath}`);
        writeCloudSkillToPath(cloud, filePath);
        vscode.window.setStatusBarMessage(
          `$(cloud-download) ModelBound: Pulled latest for ${cloud.slug ?? skillId}`,
          3000,
        );
        return;
      }

      log(`Open reconcile: ${relativePath} differs from cloud; checking sync status…`);
      const { repoUrl, branch } = getRepoInfo(workspaceRoot);
      const sourceIdeName = sourceIdeFromPath(workspaceRoot, filePath, ide);
      const syncResult = await callMcpTool(mcpUrl, activeApiKey, 'modelbound.callTool', {
        tool_name: 'skills.syncFromIde',
        arguments: {
          repo_url: repoUrl,
          branch,
          source_ide: sourceIdeName,
          source_path: relativePath,
          body_md: localContent,
        },
      });

      if ((syncResult as any)?.action === 'conflict') {
        await handleSyncConflict({
          filePath,
          relativePath,
          skillId,
          content: localContent,
          sourceIdeName,
          activeApiKey,
          conflictSkillId: (syncResult as any)?.skill_id as string | undefined,
          message: (syncResult as any)?.message,
        });
        return;
      }

      const returnedId = (syncResult as any)?.skill_id || cloud.id;
      const returnedSlug = (syncResult as any)?.slug || cloud.slug || skillId;
      markLocalPush(returnedId);
      if (returnedSlug && returnedSlug !== returnedId) markLocalPush(returnedSlug);
      registerSkill(returnedId, returnedSlug, filePath);
      markLastSynced(filePath, localContent, returnedId);
      log(`Open reconcile: synced ${relativePath} → ${(syncResult as any)?.action ?? 'updated'}`);
    } catch (err) {
      log(`Open reconcile failed for ${relativePath}: ${(err as Error).message ?? String(err)}`);
    } finally {
      inFlightOpenReconciles.delete(pathKey);
    }
  };

  const scheduleOpenReconcile = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return;
    scheduleDebounced(`open:${path.resolve(uri.fsPath)}`, () => {
      reconcileSkillOnOpen(uri).catch((err) =>
        log(`Unhandled open reconcile error: ${(err as Error).message ?? String(err)}`),
      );
    });
  };

  const openListener = vscode.workspace.onDidOpenTextDocument((doc) => {
    scheduleOpenReconcile(doc.uri);
  });
  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor?.document.uri.scheme === 'file') scheduleOpenReconcile(editor.document.uri);
  });
  context.subscriptions.push(openListener, activeEditorListener);

  // Reconcile any skill files already open when the extension activates.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file') scheduleOpenReconcile(doc.uri);
  }

  const skillHasLocalCopy = (slug: string | null | undefined, skillId: string): boolean => {
    if (lookupRegistry(skillId, slug ?? null)) {
      log(`Realtime: ${slug ?? skillId} matched registry — will pull.`);
      return true;
    }
    const candidates = [slug, skillId].filter(Boolean) as string[];
    for (const id of candidates) {
      const probes = [
        path.join(workspaceRoot, '.modelbound', `${id}.md`),
        path.join(workspaceRoot, '.kiro', 'skills', `${id}.md`),
        path.join(workspaceRoot, '.kiro', 'skills', id, 'SKILL.md'),
        path.join(workspaceRoot, '.cursor', 'rules', `${id}.md`),
        path.join(workspaceRoot, '.cursor', 'rules', `${id}.mdc`),
        path.join(workspaceRoot, '.claude', `${id}.md`),
        path.join(workspaceRoot, '.claude', 'skills', id, 'SKILL.md'),
        path.join(workspaceRoot, '.agents', 'skills', id, 'SKILL.md'),
      ];
      if (probes.some((p) => fs.existsSync(p))) {
        log(`Realtime: ${id} matched probe — will pull.`);
        return true;
      }
    }
    log(`Realtime: skill ${slug ?? skillId} has no local copy in this workspace — ignoring event.`);
    return false;
  };

  const stopCloudPullWatcher = () => {
    cloudPullWatcher?.stop();
    cloudPullWatcher = undefined;
  };

  const startCloudPullWatcher = () => {
    stopCloudPullWatcher();
    if (!apiKey || !autoSync) {
      log(`Cloud pull watcher not started (signedIn=${apiKey ? 'yes' : 'no'}, autoSync=${autoSync ? 'on' : 'off'})`);
      return;
    }
    log(`Starting cloud pull watcher (registered skills: ${Object.keys(skillRegistry).length})`);
    cloudPullWatcher = new RealtimeSync({
      apiKey,
      workspaceRoot,
      log,
      shouldSkipPull: (id, row) => shouldSuppressRecentLocalPush(id, row),
      hasLocalCopy: skillHasLocalCopy,
      pullSkillToDisk: async (id) => {
        await pullSkillToDisk(id);
      },
    });
    void cloudPullWatcher.start();
  };

  restartCloudPullWatcher = startCloudPullWatcher;
  // Start once after auth validation finishes to avoid racing two token mints.
  void ensureUsableApiKey({
    mcpUrl,
    storedKey: apiKey,
    globalState: context.globalState,
    interactive: false,
    log,
    clearStoredKey: async () => {
      await config.update('apiKey', '', vscode.ConfigurationTarget.Global);
      await clearToken(context.secrets);
    },
    promptSignIn,
  })
    .then((usableKey) => {
      apiKey = usableKey ?? apiKey;
      log(`Auth ${apiKey ? 'ready' : 'not configured'} after startup validation.`);
    })
    .catch((err) => {
      log(`Auth validation failed during startup: ${(err as Error).message ?? String(err)}`);
    })
    .finally(() => {
      restartCloudPullWatcher?.();
    });
  context.subscriptions.push({ dispose: () => stopCloudPullWatcher() });

  // 3. Manual pull command — routes through MCP `get_skill` so usage is tracked
  // server-side (powers per-skill invocation_count / last_invoked_at metrics).
  const pullCommand = vscode.commands.registerCommand('modelbound.pullSkill', async () => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }
    const target = await pickSkillTarget(workspaceRoot, { purpose: 'pull from ModelBound' });
    if (!target) return;
    try {
      await setModelBoundWorkspaceContext(mcpUrl, apiKey, workspaceRoot, log);
      const skillUuid = await ensureSkillUuid(mcpUrl, apiKey, target, log);
      const { paths: outputPaths } = await pullSkillToDisk(skillUuid);
      const locations = outputPaths.map((p) => path.relative(workspaceRoot, p)).join(', ');
      vscode.window.showInformationMessage(`Pulled ${target.label} → ${locations}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to pull context: ${msg}`);
    }
  });

  const syncCurrentFileCommand = vscode.commands.registerCommand('modelbound.syncCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      vscode.window.showWarningMessage('ModelBound: open a local skill/context file to sync.');
      return;
    }
    await syncFileNow(editor.document.uri, true);
  });

  // 4. Set/Update API Key
  const setKeyCommand = vscode.commands.registerCommand('modelbound.setApiKey', async () => {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter your ModelBound.co API Key',
      placeHolder: 'mb_live_...',
      password: true,
      ignoreFocusOut: true,
    });
    if (input) {
      const cfg = vscode.workspace.getConfiguration('modelbound');
      await cfg.update('apiKey', input, vscode.ConfigurationTarget.Global);
      apiKey = input.trim();
      await setToken(context.secrets, apiKey);
      vscode.window.showInformationMessage(
        'ModelBound: API key updated. Sync is ready.'
      );
    }
  });

  // 5. Run Skill Development Pipeline
  const runPipelineCommand = vscode.commands.registerCommand('modelbound.runSkillPipeline', async (argHint?: string) => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }

    const target = await pickSkillTarget(workspaceRoot, {
      hint: typeof argHint === 'string' ? argHint : undefined,
      purpose: 'run the pipeline against',
    });
    if (!target) return;

    const stage = await vscode.window.showQuickPick(
      [
        { label: 'Full pipeline', description: 'Test & Optimize, then Production', value: 'full' },
        { label: 'Test & Optimize only', description: 'Run gates without publishing', value: 'test_optimize' },
        { label: 'Production only', description: 'Skip gates and publish', value: 'production' },
      ],
      { placeHolder: 'Select pipeline stage' }
    );
    if (!stage) return;

    let targets: string[] = ['save'];
    if (stage.value !== 'test_optimize') {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Save new version', value: 'save', picked: true },
          { label: 'Publish to Marketplace', value: 'marketplace' },
          { label: 'Export to Claude', value: 'claude_export' },
        ],
        { placeHolder: 'Production targets', canPickMany: true }
      );
      if (!picked || picked.length === 0) return;
      targets = picked.map((p) => (p as any).value);
    }

    const panel = vscode.window.createWebviewPanel(
      'modelboundPipeline',
      `ModelBound Pipeline · ${target.label}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = pipelineHtml(target.label);

    let polling = true;
    let lastRunId: string | null = null;

    panel.onDidDispose(() => {
      polling = false;
    });

    vscode.window.setStatusBarMessage(`$(rocket) ModelBound: Pipeline starting for ${target.label}...`, 4000);

    let skillUuid: string;
    try {
      skillUuid = await ensureSkillSyncedForMcp(mcpUrl, apiKey, workspaceRoot, target, log);
      const start = await callMcpTool(mcpUrl, apiKey, 'run_skill_pipeline', {
        skill_id: skillUuid,
        stage: stage.value,
        targets,
      });
      lastRunId = (start?.run_id as string | undefined) || (start?.id as string | undefined) || null;
      log(`Pipeline started for ${target.label} (${skillUuid}) run=${lastRunId ?? 'unknown'}`);
      const initial = parsePipelineLatest(start) || (start?.status ? start : null);
      if (initial) panel.webview.postMessage({ type: 'state', state: initial });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      panel.webview.postMessage({ type: 'error', message: msg });
      vscode.window.showErrorMessage(`ModelBound pipeline failed to start: ${msg}`);
      return;
    }

    // Poll every 2s until status is terminal or the panel is closed.
    const TERMINAL = new Set(['passed', 'failed', 'completed', 'errored', 'skipped']);
    while (polling) {
      try {
        const status = await callMcpTool(mcpUrl, apiKey, 'get_skill_pipeline_status', {
          skill_id: skillUuid,
          limit: 1,
        });
        const latest = parsePipelineLatest(status);
        panel.webview.postMessage({ type: 'state', state: latest });
        if (latest && TERMINAL.has(String(latest.status))) {
          vscode.window.setStatusBarMessage(
            `$(${String(latest.status) === 'passed' || String(latest.status) === 'completed' ? 'check' : 'error'}) ModelBound: Pipeline ${latest.status}`,
            5000
          );
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({ type: 'error', message: msg });
        log(`Pipeline poll failed: ${msg}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  });

  // 6. Sign in / Sign out (Device Authorization Grant)
  const signInCommand = vscode.commands.registerCommand('modelbound.signIn', async () => {
    // Avoid wastefully minting a new key when one is already configured.
    // Re-signing in revokes the existing key server-side, so warn first.
    const existing = vscode.workspace.getConfiguration('modelbound').get<string>('apiKey');
    if (existing && existing.trim()) {
      const masked = existing.slice(0, 12) + '…';
      const choice = await vscode.window.showWarningMessage(
        `ModelBound: You're already signed in (${masked}). Signing in again will revoke the existing key and issue a new one. Continue?`,
        { modal: false },
        'Sign In Again',
        'Cancel',
      );
      if (choice !== 'Sign In Again') return;
    }
    try {
      const key = await requestModelBoundCredentials({ reason: 'manual', log, onKeySaved: saveAuthKey });
      if (key) apiKey = key;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Sign-in failed: ${msg}`);
      vscode.window.showErrorMessage(`ModelBound sign-in failed: ${msg}`);
    }
  });

  const signOutCommand = vscode.commands.registerCommand('modelbound.signOut', async () => {
    const cfg = vscode.workspace.getConfiguration('modelbound');
    await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
    await clearToken(context.secrets);
    apiKey = undefined;
    vscode.window.showInformationMessage('ModelBound: Signed out. Reload window to stop syncing.');
  });

  // 7. Browse Resource Tree — visualise platform → folder → files using get_resource_tree.
  const browseTreeCommand = vscode.commands.registerCommand('modelbound.browseResourceTree', async () => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }
    try {
      const data = await callMcpTool(mcpUrl, apiKey, 'get_resource_tree', {});
      const tree = normalizeTree(data);
      const platforms = Object.keys(tree).sort();
      if (platforms.length === 0) {
        vscode.window.showInformationMessage('ModelBound: No resources found yet. Push a skill or rule first.');
        return;
      }
      // Two-step quick-pick: pick a platform, then a file, then preview via get_skill.
      const platform = await vscode.window.showQuickPick(platforms, { placeHolder: 'Pick a platform' });
      if (!platform) return;
      const roots = tree[platform];
      const items: vscode.QuickPickItem[] = [];
      for (const root of Object.keys(roots).sort()) {
        for (const file of roots[root]) {
          const label = file.path || file.name || file.id || '(unnamed)';
          items.push({
            label,
            description: file.ai_type ? `[${file.ai_type}]` : undefined,
            detail: `${root}${file.id ? `  ·  ${file.id}` : ''}`,
          });
        }
      }
      if (items.length === 0) {
        vscode.window.showInformationMessage(`ModelBound: No files under ${platform}.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: `${platform} — pick a file to preview` });
      if (!picked) return;
      const skillId = (picked.detail?.split('·').pop() ?? '').trim() || picked.label;
      try {
        const skill = await callMcpTool(mcpUrl, apiKey, 'get_skill', { skill_id: skillId, file_id: skillId });
        const body: string =
          (skill && typeof skill === 'object' && 'text' in skill && typeof (skill as any).text === 'string'
            ? (skill as any).text
            : typeof skill === 'string' ? skill : JSON.stringify(skill, null, 2)) || '';
        const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        vscode.window.showErrorMessage(`ModelBound preview failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`ModelBound resource tree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 8. Filter Skills — quick-pick source_platform then ai_type, then list_skills with filters.
  const filterSkillsCommand = vscode.commands.registerCommand('modelbound.filterSkills', async () => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }
    const PLATFORMS = ['(any)', 'claude-code', 'cursor', 'kiro', 'amazon-q', 'copilot', 'windsurf', 'codex', 'modelbound'];
    const TYPES = ['(any)', 'skill', 'hook', 'steering', 'system-prompt', 'rule', 'agent', 'memory', 'spec', 'instructions', 'prompt'];
    const platform = await vscode.window.showQuickPick(PLATFORMS, { placeHolder: 'Filter by source_platform' });
    if (!platform) return;
    const aiType = await vscode.window.showQuickPick(TYPES, { placeHolder: 'Filter by ai_type' });
    if (!aiType) return;
    const args: Record<string, string> = {};
    if (platform !== '(any)') args.source_platform = platform;
    if (aiType !== '(any)') args.ai_type = aiType;
    try {
      const data = await callMcpTool(mcpUrl, apiKey, 'list_skills', args);
      const rows: any[] = (data && (data as any).skills) || (data && (data as any).items) || [];
      if (rows.length === 0) {
        vscode.window.showInformationMessage('ModelBound: No skills matched those filters.');
        return;
      }
      const items: vscode.QuickPickItem[] = rows.map((r) => ({
        label: r.name || r.slug || r.id || '(unnamed)',
        description: [r.ai_type, r.source_platform].filter(Boolean).map((s) => `[${s}]`).join(' '),
        detail: [r.repo, r.source_path].filter(Boolean).join(' · ') || undefined,
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: `${rows.length} skill(s) — pick to preview` });
      if (!picked) return;
      const id = rows.find((r) => (r.name || r.slug || r.id) === picked.label)?.id ?? picked.label;
      const skill = await callMcpTool(mcpUrl, apiKey, 'get_skill', { skill_id: id, file_id: id });
      const body: string =
        (skill && typeof skill === 'object' && 'text' in skill && typeof (skill as any).text === 'string'
          ? (skill as any).text
          : typeof skill === 'string' ? skill : JSON.stringify(skill, null, 2)) || '';
      const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(`ModelBound filter skills failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 9. Run Skill Test
  const runTestCommand = vscode.commands.registerCommand('modelbound.runSkillTest', async (argHint?: string) => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }
    const target = await pickSkillTarget(workspaceRoot, {
      hint: typeof argHint === 'string' ? argHint : undefined,
      purpose: 'run tests against',
    });
    if (!target) return;
    vscode.window.setStatusBarMessage(`$(loading~spin) ModelBound: Testing ${target.label}...`, 4000);
    try {
      const skillUuid = await ensureSkillSyncedForMcp(mcpUrl, apiKey, workspaceRoot, target, log);
      const result = await callMcpTool(mcpUrl, apiKey, 'skill.test', { skillId: skillUuid, source: 'cursor-extension' });
      const res = result as any;
      const total = (res?.passed || 0) + (res?.failed || 0) + (res?.skipped || 0);
      const icon = res?.failed ? '$(error)' : '$(check)';
      vscode.window.showInformationMessage(`${icon} ${target.label}: ${res?.passed ?? 0}/${total} passed, ${res?.failed ?? 0} failed, ${res?.skipped ?? 0} skipped`);
    } catch (err) {
      vscode.window.showErrorMessage(`ModelBound test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 10. Show Skill Versions (webview)
  const showVersionsCommand = vscode.commands.registerCommand('modelbound.showSkillVersions', async (argHint?: string) => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }
    const target = await pickSkillTarget(workspaceRoot, {
      hint: typeof argHint === 'string' ? argHint : undefined,
      purpose: 'view versions for',
    });
    if (!target) return;
    const activeApiKey = apiKey;
    try {
      const skillUuid = await ensureSkillUuid(mcpUrl, activeApiKey, target, log);
      const result = await callMcpTool(mcpUrl, activeApiKey, 'skill.versions', { skillId: skillUuid, source: 'cursor-extension' });
      const versions = (result as any)?.versions || [];
      const panel = vscode.window.createWebviewPanel('modelboundVersions', `ModelBound Versions · ${target.label}`, vscode.ViewColumn.Beside, { enableScripts: true });
      const rows = versions.map((v: any) => `<tr><td><code>${(v.id || '').slice(0,10)}</code></td><td>${v.created_at || ''}</td><td>${v.tokens || ''}</td><td><button data-act="diff" data-v="${v.id}">Diff</button> <button data-act="restore" data-v="${v.id}">Restore</button></td></tr>`).join('');
      panel.webview.html = `<!DOCTYPE html><html><body><h2>Versions: ${target.label}</h2><table><thead><tr><th>ID</th><th>Created</th><th>Tokens</th><th></th></tr></thead><tbody>${rows}</tbody></table><script>const vscode=acquireVsCodeApi();document.body.addEventListener('click',e=>{const t=e.target;if(!(t instanceof HTMLButtonElement))return;const act=t.dataset.act,v=t.dataset.v;vscode.postMessage({type:act,versionId:v})});</script></body></html>`;
      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'restore' && msg.versionId) {
          try {
            const restored = await callMcpTool(mcpUrl, activeApiKey, 'skill.diff', { skillId: skillUuid, versionA: msg.versionId, action: 'restore', source: 'cursor-extension' });
            const content = (restored as any)?.content || '';
            const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: false });
            vscode.window.showInformationMessage(`ModelBound: Restored ${target.label} to version ${msg.versionId.slice(0, 8)}.`);
          } catch (err) {
            vscode.window.showErrorMessage(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (msg.type === 'diff' && msg.versionId) {
          try {
            const diffResult = await callMcpTool(mcpUrl, activeApiKey, 'skill.diff', { skillId: skillUuid, versionA: msg.versionId, versionB: 'current', source: 'cursor-extension' });
            const diffText = (diffResult as any)?.diff || 'No diff available.';
            const doc = await vscode.workspace.openTextDocument({ content: diffText, language: 'diff' });
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (err) {
            vscode.window.showErrorMessage(`Diff failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
    } catch (err) {
      vscode.window.showErrorMessage(`ModelBound versions failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 11. Diff Skill Versions
  const diffVersionsCommand = vscode.commands.registerCommand('modelbound.diffSkillVersions', async () => {
    if (!apiKey) { vscode.window.showWarningMessage('ModelBound: Set your API key first.'); return; }
    const target = await pickSkillTarget(workspaceRoot, { purpose: 'compare versions for' });
    if (!target) return;
    const fromVersion = await vscode.window.showInputBox({ prompt: 'From version (or "latest")', value: 'latest', ignoreFocusOut: true });
    if (!fromVersion) return;
    const toVersion = await vscode.window.showInputBox({ prompt: 'To version (or "current")', value: 'current', ignoreFocusOut: true });
    if (!toVersion) return;
    try {
      const skillUuid = await ensureSkillSyncedForMcp(mcpUrl, apiKey, workspaceRoot, target, log);
      const diffResult = await callMcpTool(mcpUrl, apiKey, 'skill.diff', { skillId: skillUuid, versionA: fromVersion, versionB: toVersion, source: 'cursor-extension' });
      const diffText = (diffResult as any)?.diff || 'No diff available.';
      const doc = await vscode.workspace.openTextDocument({ content: diffText, language: 'diff' });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(`ModelBound diff failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 12. Show Health
  const showHealthCommand = vscode.commands.registerCommand('modelbound.showHealth', async () => {
    if (!apiKey) { vscode.window.showWarningMessage('ModelBound: Set your API key first.'); return; }
    vscode.window.setStatusBarMessage(`$(loading~spin) ModelBound: Checking health...`, 3000);
    try {
      const result = await callMcpTool(mcpUrl, apiKey, 'pipeline.status', { source: 'cursor-extension' });
      const data = result as any;
      const score = data?.overallScore ?? '—';
      const budgets = (data?.budgets || []).map((b: any) => `${b.name}: ${b.used}/${b.limit} (${b.status})`).join('\n  ');
      const suggestions = (data?.suggestions || []).map((s: string) => `• ${s}`).join('\n');
      const msg = `Health Score: ${score}/100\n\nBudgets:\n  ${budgets || 'None tracked'}\n\nSuggestions:\n${suggestions || 'None'}`;
      vscode.window.showInformationMessage(msg, { modal: false }, 'OK');
    } catch (err) {
      vscode.window.showErrorMessage(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  registerSkillTrustCommands(context, {
    getApiKey: () => apiKey,
    getMcpUrl: () => mcpUrl,
    workspaceRoot,
    pickSkillTarget,
    ensureSkillUuid,
    ensureSkillSynced: ensureSkillSyncedForMcp,
    callMcp: (name, args) => {
      if (!apiKey) throw new Error('ModelBound API key is not configured.');
      return callMcpTool(mcpUrl, apiKey, name, args);
    },
    log,
  });

  context.subscriptions.push(pullCommand, syncCurrentFileCommand, setKeyCommand, runPipelineCommand, signInCommand, signOutCommand, browseTreeCommand, filterSkillsCommand, runTestCommand, showVersionsCommand, diffVersionsCommand, showHealthCommand, statusBar, { dispose: () => skillLens.refresh() });
}

// Normalise the various shapes get_resource_tree may return into
// `{ platform: { rootDir: [{ id, path, ai_type, name }] } }`.
function normalizeTree(data: any): Record<string, Record<string, Array<{ id?: string; path?: string; name?: string; ai_type?: string }>>> {
  if (!data || typeof data !== 'object') return {};
  const src = data.platforms ?? data.tree ?? data;
  const out: Record<string, Record<string, any[]>> = {};
  for (const [platform, roots] of Object.entries(src)) {
    if (!roots || typeof roots !== 'object') continue;
    out[platform] = {};
    for (const [root, val] of Object.entries(roots as Record<string, unknown>)) {
      if (Array.isArray(val)) out[platform][root] = val;
      else if (val && typeof val === 'object' && Array.isArray((val as any).files)) out[platform][root] = (val as any).files;
      else out[platform][root] = [];
    }
  }
  return out;
}

export function deactivate() {
  for (const timer of pendingSyncTimers.values()) clearTimeout(timer);
  pendingSyncTimers.clear();
  for (const w of watchers) w.dispose();
}
