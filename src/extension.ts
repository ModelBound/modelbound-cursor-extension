import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { runSignIn } from './device-auth';
import { ensureUsableApiKey } from './auth-validate';
import { RealtimeSync } from './realtime-sync';

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
];

const SELF_WRITE_SUPPRESS_MS = 30_000;
const RECENT_LOCAL_PUSH_SUPPRESS_MS = 45_000;
const DEBOUNCE_MS = 1200;

const watchers: vscode.FileSystemWatcher[] = [];
let outputChannel: vscode.OutputChannel | undefined;
const recentSelfWrites = new Map<string, number>();
const recentLocalPushes = new Map<string, number>();
const inFlightPathSyncs = new Set<string>();
const pendingSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Persistent registry of skills this workspace has touched (pushed or pulled).
// Key: skill UUID. Value: { slug, paths: absolute file paths }.
// Used by the realtime watcher to decide whether an MB-side change should
// land on disk. Without this, MB→IDE pulls get filtered out whenever the
// local filename doesn't follow `<slug>.md` exactly.
type SkillRegistryEntry = { slug?: string | null; paths: string[] };
const REGISTRY_KEY = 'modelbound.skillRegistry.v1';
let skillRegistry: Record<string, SkillRegistryEntry> = {};
let extensionContext: vscode.ExtensionContext | null = null;

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
  if (rel.startsWith('.modelbound/')) return 'modelbound';
  return fallback;
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
  if (result.structuredContent) return result.structuredContent;
  const txt = result.content?.[0]?.text;
  if (typeof txt === 'string') {
    try {
      return JSON.parse(txt);
    } catch {
      return { text: txt };
    }
  }
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

function pipelineHtml(skillId: string): string {
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
<div class="sub">Skill: <code>${skillId}</code></div>
<div id="root"><div class="meta">Loading status…</div></div>
<script>
  const vscodeApi = acquireVsCodeApi();
  function render(state) {
    const root = document.getElementById('root');
    if (!state) { root.innerHTML = '<div class="meta">No runs yet. Commit a change in the ModelBound editor or call run_skill_pipeline.</div>'; return; }
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

  const config = vscode.workspace.getConfiguration('modelbound');
  let apiKey = config.get<string>('apiKey');
  const autoSync = config.get<boolean>('autoSync', true);
  const mcpUrl =
    config.get<string>('mcpUrl') || 'https://mcp.modelbound.co/mcp';

  // 0. Onboarding: validate any stored API key before prompting. Avoids
  // re-prompting users on every reload when a valid key is already saved.
  const promptSignIn = async (): Promise<string | undefined> => {
    const action = await vscode.window.showInformationMessage(
      'ModelBound: Sign in to start syncing your AI context, skills, and rules.',
      'Sign In with Browser',
      'Paste API Key',
      'Later',
    );
    if (action === 'Sign In with Browser') {
      try {
        const email = await runSignIn();
        const fresh = vscode.workspace.getConfiguration('modelbound').get<string>('apiKey');
        vscode.window.showInformationMessage(
          email ? `ModelBound: Signed in as ${email}.` : 'ModelBound: Signed in successfully.',
        );
        return fresh;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Sign-in failed: ${msg}`);
        vscode.window.showErrorMessage(`ModelBound sign-in failed: ${msg}`);
        return undefined;
      }
    } else if (action === 'Paste API Key') {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your ModelBound.co API Key',
        placeHolder: 'mb_live_...',
        password: true,
        ignoreFocusOut: true,
      });
      if (input) {
        await config.update('apiKey', input, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('ModelBound: API key saved.');
        return input;
      }
    }
    return undefined;
  };

  apiKey = await ensureUsableApiKey({
    mcpUrl,
    storedKey: apiKey,
    log,
    clearStoredKey: async () => {
      await config.update('apiKey', '', vscode.ConfigurationTarget.Global);
    },
    promptSignIn,
  });


  // 1. Ensure canonical .modelbound/ exists
  const localFolder = path.join(workspaceRoot, '.modelbound');
  if (!fs.existsSync(localFolder)) fs.mkdirSync(localFolder, { recursive: true });

  // 2. Set up file watchers (add/change/delete) for every glob
  if (autoSync && apiKey) {
    const ide = detectIde();
    const initial = getRepoInfo(workspaceRoot);
    log(`Activated. ide=${ide} workspace=${workspaceRoot} repo=${initial.repoUrl ?? 'none'} branch=${initial.branch ?? 'none'}`);
    if (!initial.repoUrl) {
      vscode.window.showInformationMessage(
        'ModelBound: no git remote detected — skills will sync without repo association. Run "git remote add origin <url>" and save a skill to re-detect. See the ModelBound output channel for details.'
      );
    }

    const syncFileNow = async (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      if (!isWatchablePath(workspaceRoot, filePath)) return;
      if (shouldSuppressSelfWrite(filePath)) {
        log(`Skipped self-originated sync for ${relPath(workspaceRoot, filePath)}`);
        return;
      }
      const pathKey = path.resolve(filePath);
      if (inFlightPathSyncs.has(pathKey)) {
        log(`Skipped already-running sync for ${relPath(workspaceRoot, filePath)}`);
        return;
      }
      const skillId = path.basename(filePath, path.extname(filePath));
      inFlightPathSyncs.add(pathKey);
      vscode.window.setStatusBarMessage(`$(sync~spin) ModelBound: Syncing ${skillId}...`);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const { repoUrl, branch } = getRepoInfo(workspaceRoot);
        const relativePath = relPath(workspaceRoot, filePath);
        const syncResult = await callMcpTool(mcpUrl, apiKey!, 'modelbound.callTool', {
          tool_name: 'skills.syncFromIde',
          arguments: {
            repo_url: repoUrl,
            branch,
            source_ide: sourceIdeFromPath(workspaceRoot, filePath, ide),
            source_path: relativePath,
            body_md: content,
          },
        });
        const returnedId = (syncResult as any)?.skill_id || skillId;
        const returnedSlug = (syncResult as any)?.slug || skillId;
        markLocalPush(returnedId);
        registerSkill(returnedId, returnedSlug, filePath);
        log(`Synced ${relativePath} → skill=${returnedId} slug=${returnedSlug} (repo=${repoUrl ?? 'none'})`);
        vscode.window.setStatusBarMessage(`$(check) ModelBound: Synced ${skillId}`, 3000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Sync failed for ${skillId}: ${msg}`);
        vscode.window.showErrorMessage(`ModelBound sync failed for ${skillId}: ${msg}`);
      } finally {
        inFlightPathSyncs.delete(pathKey);
      }
    };

    const syncFile = (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      if (!isWatchablePath(workspaceRoot, filePath)) return;
      scheduleDebounced(`sync:${path.resolve(filePath)}`, () => {
        syncFileNow(uri).catch((err) => log(`Unhandled sync error: ${(err as Error).message ?? String(err)}`));
      });
    };

    const deleteFile = async (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      const skillId = path.basename(filePath, path.extname(filePath));
      try {
        const { repoUrl } = getRepoInfo(workspaceRoot);
        await callMcpTool(mcpUrl, apiKey!, 'modelbound.callTool', {
          tool_name: 'skills.deleteFromIde',
          arguments: {
            repo_url: repoUrl,
            source_path: relPath(workspaceRoot, filePath),
          },
        });
        vscode.window.setStatusBarMessage(`$(trash) ModelBound: Removed ${skillId}`, 3000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Delete failed for ${skillId}: ${msg}`);
        vscode.window.showErrorMessage(`ModelBound delete failed for ${skillId}: ${msg}`);
      }
    };

    for (const glob of WATCH_GLOBS) {
      const pattern = new vscode.RelativePattern(workspaceFolder, glob);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(syncFile);
      watcher.onDidChange(syncFile);
      watcher.onDidDelete(deleteFile);
      watchers.push(watcher);
      context.subscriptions.push(watcher);
    }

    const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') syncFile(doc.uri);
    });
    context.subscriptions.push(saveListener);
  }

  // Reusable: fetch a skill from MCP and write it to every relevant local
  // location. Used by both the manual pull command and the realtime watcher.
  const pullSkillToDisk = async (skillId: string): Promise<{ paths: string[] }> => {
    if (!apiKey) throw new Error('Not signed in.');
    log(`Pulling skill ${skillId} from ModelBound…`);
    const data = await callMcpTool(mcpUrl, apiKey, 'skills.get', {
      file_id: skillId,
      skill_id: skillId,
    });
    const content: string =
      (data && typeof data === 'object' && 'text' in data && typeof (data as any).text === 'string'
        ? (data as any).text
        : typeof data === 'string'
          ? data
          : '') || '';
    if (!content) throw new Error('Skill not found or empty');

    const returnedSlug = data && typeof data === 'object' ? (data as any).slug ?? null : null;
    const returnedId = data && typeof data === 'object' ? (data as any).skill_id ?? (data as any).id ?? skillId : skillId;

    const registryEntry = lookupRegistry(returnedId, returnedSlug) || lookupRegistry(skillId, null);
    const outputPaths: string[] = registryEntry ? [...registryEntry.paths] : getSkillOutputPaths(workspaceRoot, returnedSlug || skillId);

    const sourcePath = data && typeof data === 'object' ? (data as any).source_path : null;
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
    }
    log(`Pulled ${returnedId} → ${outputPaths.map((p) => path.relative(workspaceRoot, p)).join(', ')}`);
    return { paths: outputPaths };
  };

  // 3. Manual pull command — routes through MCP `get_skill` so usage is tracked
  // server-side (powers per-skill invocation_count / last_invoked_at metrics).
  const pullCommand = vscode.commands.registerCommand('modelbound.pullSkill', async () => {
    const skillId = await vscode.window.showInputBox({
      prompt: 'Enter ModelBound Skill ID',
    });
    if (!skillId || !apiKey) return;
    try {
      const { paths: outputPaths } = await pullSkillToDisk(skillId);
      const locations = outputPaths.map((p) => path.relative(workspaceRoot, p)).join(', ');
      vscode.window.showInformationMessage(`Pulled ${skillId} → ${locations}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to pull context: ${msg}`);
    }
  });

  // 3b. Realtime push — subscribe to Supabase Realtime so cloud edits land in
  // this workspace automatically.
  if (apiKey && autoSync) {
    log(`Starting realtime subscription (registered skills: ${Object.keys(skillRegistry).length})`);
    const realtime = new RealtimeSync({
      apiKey,
      workspaceRoot,
      log,
      shouldSkipPull: (skillId, row) => shouldSuppressRecentLocalPush(skillId, row),
      hasLocalCopy: (slug, skillId) => {
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
      },
      pullSkillToDisk: async (skillId) => {
        await pullSkillToDisk(skillId);
      },
    });
    realtime.start();
    context.subscriptions.push({ dispose: () => realtime.stop() });
  }

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
      vscode.window.showInformationMessage(
        'ModelBound: API key updated. Reload window to apply.'
      );
    }
  });

  // 5. Run Skill Development Pipeline
  const runPipelineCommand = vscode.commands.registerCommand('modelbound.runSkillPipeline', async () => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }

    let skillId = detectActiveSkillId(workspaceRoot);
    if (!skillId) {
      const entered = await vscode.window.showInputBox({
        prompt: 'Enter the ModelBound Skill ID (UUID or slug) to run the pipeline against',
        placeHolder: 'e.g. my-deploy-skill or 8f3b...',
        ignoreFocusOut: true,
      });
      if (!entered) return;
      skillId = entered.trim();
    }

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
      `ModelBound Pipeline · ${skillId}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = pipelineHtml(skillId);

    let polling = true;
    let lastRunId: string | null = null;

    panel.onDidDispose(() => {
      polling = false;
    });

    vscode.window.setStatusBarMessage(`$(rocket) ModelBound: Pipeline starting for ${skillId}...`, 4000);

    try {
      const start = await callMcpTool(mcpUrl, apiKey, 'run_skill_pipeline', {
        skill_id: skillId,
        stage: stage.value,
        targets,
      });
      lastRunId = start?.run_id || start?.id || null;
      log(`Pipeline started for ${skillId} (run=${lastRunId ?? 'unknown'})`);
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
        const status = await callMcpTool(mcpUrl, apiKey, 'skills.getPipelineStatus', {
          skill_id: skillId,
          limit: 1,
        });
        const latest = status?.runs?.[0] || null;
        panel.webview.postMessage({ type: 'state', state: latest });
        if (latest && TERMINAL.has(latest.status)) {
          vscode.window.setStatusBarMessage(
            `$(${latest.status === 'passed' || latest.status === 'completed' ? 'check' : 'error'}) ModelBound: Pipeline ${latest.status}`,
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
      const email = await runSignIn();
      vscode.window.showInformationMessage(
        email ? `ModelBound: Signed in as ${email}. Reload window to start syncing.` : 'ModelBound: Signed in. Reload window to start syncing.',
        'Reload Window',
      ).then((choice) => {
        if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Sign-in failed: ${msg}`);
      vscode.window.showErrorMessage(`ModelBound sign-in failed: ${msg}`);
    }
  });

  const signOutCommand = vscode.commands.registerCommand('modelbound.signOut', async () => {
    const cfg = vscode.workspace.getConfiguration('modelbound');
    await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
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

  context.subscriptions.push(pullCommand, setKeyCommand, runPipelineCommand, signInCommand, signOutCommand, browseTreeCommand, filterSkillsCommand);
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
