import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { runSignIn } from './device-auth';
import { ensureUsableApiKey } from './auth-validate';
import { RealtimeSync } from './realtime-sync';
import { SkillCodeLensProvider } from './skill-lens';
import { ModelBoundStatusBar } from './status-bar';
import { versionWebviewHtml, showUndoToast } from './version-webview';

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

let globalChannelDispose: (() => void) | undefined;

// pending-echo suppression (non DB-write approach)
const pendingUpdates = new Map<string, string>();

function contentHash(obj: any) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
  } catch {
    return String(Math.random());
  }
}

/**
 * Mark an outgoing update as "pending" so the realtime echo can be ignored.
 * Call this immediately before you send an update to the DB.
 * rowId: id of the row being updated
 * payload: { body?, frontmatter? } - whatever is used to compute equality with incoming payloads
 */
export function markPendingUpdate(rowId: string, payload: { body?: string; frontmatter?: any }) {
  const sig = contentHash({ body: payload.body ?? null, frontmatter: payload.frontmatter ?? null });
  pendingUpdates.set(rowId, sig);
  // keep pending for a short window to ignore the echo
  setTimeout(() => pendingUpdates.delete(rowId), 15_000);
  return sig;
}

// Example helper to use when performing an update from the extension:
// Call markPendingUpdate BEFORE you call supabase.from('skills').update(...)
export async function updateSkillAndMark(supabaseClient: any, rowId: string, patch: any) {
  try {
    markPendingUpdate(rowId, { body: patch.body, frontmatter: patch.frontmatter });
    await supabaseClient.from('skills').update(patch).eq('id', rowId);
  } catch (e) {
    throw e;
  }
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
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateCtx),
    vscode.workspace.onDidOpenTextDocument(updateCtx),
  );
  updateCtx();

  // CodeLens (markdown only — skill files are .md / SKILL.md).
  const lensProvider = new SkillCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "markdown" }, lensProvider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("modelbound.showCodeLens")) lensProvider.refresh();
    }),
  );

  // Status bar.
  registerStatusBar(context, getApi);

  // Helpers --------------------------------------------------------------
  const activeSkillUri = (arg?: vscode.Uri | { uri?: vscode.Uri }): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) return arg;
    if (arg && typeof arg === "object" && "uri" in arg && arg.uri instanceof vscode.Uri) return arg.uri;
    const editor = vscode.window.activeTextEditor;
    return editor?.document.uri;
  };

  const slugFromUri = (uri: vscode.Uri): string => {
    // Heuristic: use the file basename without extension as a default slug.
    // The server resolves slug ambiguity (and the user can re-bind via UI).
    return path.basename(uri.fsPath).replace(/\.(md|mdx|mdc)$/i, "");
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
    config.get<string>('mcpUrl') || 'https://mcp.modelbound.co';

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

  // 0a. Status bar & CodeLens for pipeline/versions/health
  const statusBar = new ModelBoundStatusBar(apiKey || '', mcpUrl);
  const skillLens = new SkillCodeLensProvider(apiKey || '', mcpUrl);
  vscode.languages.registerCodeLensProvider({ pattern: '**/SKILL.md' }, skillLens);

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
      const url = `${start.verification_uri}?code=${encodeURIComponent(start.user_code)}`;
      vscode.env.openExternal(vscode.Uri.parse(url));
      vscode.window.showInformationMessage(`Enter code ${start.user_code} in your browser.`);

      const deadline = Date.now() + start.expires_in * 1000;
      const interval = Math.max(1, start.interval) * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        try {
          const poll = await api<{ status: string; token?: string; user?: { email?: string } }>(
            ax,
            "/api/cli/device/poll",
            { method: "POST", anonymous: true, body: { device_code: start.device_code } },
          );
          if (poll.status === "approved" && poll.token) {
            await setToken(context.secrets, poll.token);
            vscode.window.showInformationMessage(`ModelBound: logged in as ${poll.user?.email ?? "user"}.`);
            return;
          }
          if (poll.status === "denied" || poll.status === "expired") {
            vscode.window.showErrorMessage(`ModelBound: login ${poll.status}.`);
            return;
          }
        } catch { /* keep polling */ }
      }
      vscode.window.showErrorMessage("ModelBound: login timed out.");
    }),

    vscode.commands.registerCommand("modelbound.logout", async () => {
      await clearToken(context.secrets);
      vscode.window.showInformationMessage("ModelBound: logged out.");
    }),

    vscode.commands.registerCommand("modelbound.whoami", async () => {
      const ax = await getApi();
      try {
        const me = await api<{ id: string; email?: string; team_id?: string }>(ax, "/api/cli/whoami");
        vscode.window.showInformationMessage(`ModelBound: ${me.email ?? me.id}`);
      } catch {
        vscode.window.showWarningMessage("Not authenticated. Run `ModelBound: Login`.");
      }
    }),

    vscode.commands.registerCommand("modelbound.optimize", async (arg?: vscode.Uri) => {
      const uri = activeSkillUri(arg);
      if (!uri) return;
      const doc = await vscode.workspace.openTextDocument(uri);
      const apply = (await vscode.window.showQuickPick(
        [
          { label: "Preview diff", value: false },
          { label: "Apply & save new version", value: true },
        ],
        { placeHolder: "Optimize how?" },
      ))?.value ?? false;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "ModelBound: optimizing…" },
        async () => {
          const ax = await getApi();
          const res = await api<{
            tokens_saved: number;
            savings_pct: number;
            diff?: string;
            version_id?: string;
            previous_version_id?: string;
          }>(ax, "/api/cli/optimize", {
            method: "POST",
            body: { content: doc.getText(), filename: vscode.workspace.asRelativePath(uri), apply },
          });
          if (res.tokens_saved <= 0) {
            vscode.window.showInformationMessage("Already optimized — no significant savings.");
            return;
          }
          if (res.diff && !apply) {
            const out = await vscode.workspace.openTextDocument({ content: res.diff, language: "diff" });
            await vscode.window.showTextDocument(out, { preview: true, viewColumn: vscode.ViewColumn.Beside });
          }
          if (apply && res.version_id && res.previous_version_id) {
            await showUndoToast(getApi, {
              slug: slugFromUri(uri),
              previous_version_id: res.previous_version_id,
              new_version_id: res.version_id,
              action: "optimization",
            });
          }
          vscode.window.showInformationMessage(
            `Saved ${res.tokens_saved.toLocaleString()} tokens (${res.savings_pct}%).`,
          );
        },
      );
    }),

    vscode.commands.registerCommand("modelbound.pipeline", async (arg?: vscode.Uri) => {
      const uri = activeSkillUri(arg);
      if (!uri) return;
      const slug = slugFromUri(uri);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `ModelBound: pipeline ${slug}…` },
        async () => {
          const ax = await getApi();
          const run = await api<{ pipeline_run_id: string }>(ax, "/api/cli/pipeline/run", {
            method: "POST",
            body: { slug },
          });
          let status: any = { status: "queued" };
          while (status.status === "queued" || status.status === "running") {
            await new Promise((r) => setTimeout(r, 2000));
            status = await api(ax, `/api/cli/pipeline/status?id=${encodeURIComponent(run.pipeline_run_id)}`);
          }
          const ch = vscode.window.createOutputChannel("ModelBound — Pipeline");
          ch.show(true);
          ch.appendLine(JSON.stringify(status, null, 2));
          (status.status === "passed" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(
            `Pipeline ${status.status}.`,
          );
        },
      );
    }),

    vscode.commands.registerCommand("modelbound.test", async (arg?: vscode.Uri) => {
      const uri = activeSkillUri(arg);
      if (!uri) return;
      const ax = await getApi();
      const res = await api<{ pass_rate: number; passed: number; failed: number; cost_usd: number; tokens: number }>(
        ax,
        "/api/cli/skill/test",
        { method: "POST", body: { slug: slugFromUri(uri) } },
      );
      vscode.window.showInformationMessage(
        `Tests: ${res.passed}/${res.passed + res.failed} pass (${(res.pass_rate * 100).toFixed(1)}%, ${res.tokens} tok, $${res.cost_usd.toFixed(4)}).`,
      );
    }),

    vscode.commands.registerCommand(
      "modelbound.benchmark",
      async (arg?: { slug?: string; a?: string; b?: string } | vscode.Uri) => {
        const slug =
          arg && typeof arg === "object" && "slug" in arg && arg.slug
            ? arg.slug
            : slugFromUri(activeSkillUri(arg as vscode.Uri | undefined)!);
        const a =
          (arg && typeof arg === "object" && "a" in arg && arg.a) ||
          (await vscode.window.showInputBox({ prompt: "Version A (id or 'current')" }));
        if (!a) return;
        const b =
          (arg && typeof arg === "object" && "b" in arg && arg.b) ||
          (await vscode.window.showInputBox({ prompt: "Version B (id or 'baseline')" }));
        if (!b) return;
        const ax = await getApi();
        const res = await api<any>(ax, "/api/cli/skill/benchmark", {
          method: "POST",
          body: { slug, version_a: a, version_b: b },
        });
        const ch = vscode.window.createOutputChannel("ModelBound — Benchmark");
        ch.show(true);
        ch.appendLine(JSON.stringify(res, null, 2));
      },
    ),

    vscode.commands.registerCommand("modelbound.versions", async (arg?: vscode.Uri) => {
      const uri = activeSkillUri(arg);
      if (!uri) return;
      await openVersionsWebview(getApi, slugFromUri(uri));
    }),

    vscode.commands.registerCommand(
      "modelbound.restore",
      async (arg?: { slug?: string; versionId?: string } | vscode.Uri) => {
        const slug =
          arg && typeof arg === "object" && "slug" in arg && arg.slug
            ? arg.slug
            : slugFromUri(activeSkillUri(arg as vscode.Uri | undefined)!);
        const versionId =
          (arg && typeof arg === "object" && "versionId" in arg && arg.versionId) ||
          (await vscode.window.showInputBox({ prompt: "Version ID to restore" }));
        if (!versionId) return;
        const ax = await getApi();
        const res = await api<{ new_version_id: string; previous_version_id: string }>(
          ax,
          "/api/cli/skill/restore",
          { method: "POST", body: { slug, version_id: versionId } },
        );
        await showUndoToast(getApi, {
          slug,
          previous_version_id: res.previous_version_id,
          new_version_id: res.new_version_id,
          action: "restore",
        });
      },
    ),

    vscode.commands.registerCommand(
      "modelbound.diff",
      async (arg?: { slug?: string; from?: string; to?: string } | vscode.Uri) => {
        const slug =
          arg && typeof arg === "object" && "slug" in arg && arg.slug
            ? arg.slug
            : slugFromUri(activeSkillUri(arg as vscode.Uri | undefined)!);
        const from =
          (arg && typeof arg === "object" && "from" in arg && arg.from) ||
          (await vscode.window.showInputBox({ prompt: "From version (id, 'baseline', 'previous')" }));
        if (!from) return;
        const to =
          (arg && typeof arg === "object" && "to" in arg && arg.to) || "current";
        const ax = await getApi();
        const res = await api<{ diff: string }>(
          ax,
          `/api/cli/skill/diff?slug=${encodeURIComponent(slug)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        );
        const doc = await vscode.workspace.openTextDocument({ content: res.diff, language: "diff" });
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      },
    ),

    vscode.commands.registerCommand("modelbound.health", async () => {
      const ax = await getApi();
      try {
        await api(ax, "/api/cli/health");
        vscode.window.showInformationMessage(`ModelBound API reachable at ${ax.baseUrl}.`);
      } catch (e) {
        vscode.window.showErrorMessage(`ModelBound health check failed: ${(e as Error).message}`);
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
  const runTestCommand = vscode.commands.registerCommand('modelbound.runSkillTest', async (argSkillId?: string) => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }
    let skillId = argSkillId || detectActiveSkillId(workspaceRoot);
    if (!skillId) {
      const entered = await vscode.window.showInputBox({ prompt: 'Enter the ModelBound Skill ID to test', placeHolder: 'e.g. my-deploy-skill', ignoreFocusOut: true });
      if (!entered) return;
      skillId = entered.trim();
    }
    vscode.window.setStatusBarMessage(`$(loading~spin) ModelBound: Testing ${skillId}...`, 4000);
    try {
      const result = await callMcpTool(mcpUrl, apiKey, 'skill.test', { skillId, source: 'cursor-extension' });
      const res = result as any;
      const total = (res?.passed || 0) + (res?.failed || 0) + (res?.skipped || 0);
      const icon = res?.failed ? '$(error)' : '$(check)';
      vscode.window.showInformationMessage(`${icon} ${skillId}: ${res?.passed ?? 0}/${total} passed, ${res?.failed ?? 0} failed, ${res?.skipped ?? 0} skipped`);
    } catch (err) {
      vscode.window.showErrorMessage(`ModelBound test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 10. Show Skill Versions (webview)
  const showVersionsCommand = vscode.commands.registerCommand('modelbound.showSkillVersions', async (argSkillId?: string) => {
    if (!apiKey) {
      vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
      return;
    }
    let skillId = argSkillId || detectActiveSkillId(workspaceRoot);
    if (!skillId) {
      const entered = await vscode.window.showInputBox({ prompt: 'Enter the ModelBound Skill ID', placeHolder: 'e.g. my-deploy-skill', ignoreFocusOut: true });
      if (!entered) return;
      skillId = entered.trim();
    }
    try {
      const result = await callMcpTool(mcpUrl, apiKey, 'skill.versions', { skillId, source: 'cursor-extension' });
      const versions = (result as any)?.versions || [];
      const panel = vscode.window.createWebviewPanel('modelboundVersions', `ModelBound Versions · ${skillId}`, vscode.ViewColumn.Beside, { enableScripts: true });
      panel.webview.html = versionWebviewHtml(skillId, versions);
      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'restore' && msg.versionId) {
          try {
            const restored = await callMcpTool(mcpUrl, apiKey, 'skill.diff', { skillId, versionA: msg.versionId, action: 'restore', source: 'cursor-extension' });
            const content = (restored as any)?.content || '';
            const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            await showUndoToast(editor, `${skillId}@${msg.versionId}`);
          } catch (err) {
            vscode.window.showErrorMessage(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (msg.type === 'diff' && msg.versionId) {
          try {
            const diffResult = await callMcpTool(mcpUrl, apiKey, 'skill.diff', { skillId, versionA: msg.versionId, versionB: 'current', source: 'cursor-extension' });
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
    let skillId = detectActiveSkillId(workspaceRoot);
    if (!skillId) {
      const entered = await vscode.window.showInputBox({ prompt: 'Enter the ModelBound Skill ID', placeHolder: 'e.g. my-deploy-skill', ignoreFocusOut: true });
      if (!entered) return;
      skillId = entered.trim();
    }
    const fromVersion = await vscode.window.showInputBox({ prompt: 'From version (or "latest")', value: 'latest', ignoreFocusOut: true });
    if (!fromVersion) return;
    const toVersion = await vscode.window.showInputBox({ prompt: 'To version (or "current")', value: 'current', ignoreFocusOut: true });
    if (!toVersion) return;
    try {
      const diffResult = await callMcpTool(mcpUrl, apiKey, 'skill.diff', { skillId, versionA: fromVersion, versionB: toVersion, source: 'cursor-extension' });
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

  context.subscriptions.push(pullCommand, setKeyCommand, runPipelineCommand, signInCommand, signOutCommand, browseTreeCommand, filterSkillsCommand, runTestCommand, showVersionsCommand, diffVersionsCommand, showHealthCommand, statusBar, { dispose: () => skillLens.refresh() });
}

export function deactivate(): void { /* no-op */ }
