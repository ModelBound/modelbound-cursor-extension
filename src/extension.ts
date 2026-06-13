// Extension entry — wires up commands, status bar, CodeLens, context keys.
//
// Design: every command is a thin shell around the same ModelBound API that
// powers the CLI, MCP server, and Claude Code plugin. We avoid embedding
// business logic in the extension so behavior stays consistent across
// surfaces.
import * as vscode from "vscode";
import * as path from "node:path";
import { api, ApiCtx, clearToken, getCtx, setToken } from "./api.js";
import { isSkillFile } from "./skillDetect.js";
import { registerStatusBar } from "./statusBar.js";
import { SkillCodeLensProvider } from "./codeLens.js";
import { openVersionsWebview } from "./versionsWebview.js";
import { showUndoToast } from "./undo.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const getApi = (): Promise<ApiCtx> => getCtx(context.secrets);

  // Context key for menu visibility.
  const updateCtx = () => {
    const editor = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand(
      "setContext",
      "modelbound.isSkillFile",
      isSkillFile(editor?.document.uri),
    );
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

  // Commands -------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("modelbound.login", async () => {
      const ax = await getApi();
      const start = await api<{ user_code: string; verification_uri: string; device_code: string; interval: number; expires_in: number }>(
        ax,
        "/api/cli/device/start",
        { method: "POST", anonymous: true, body: { client: "modelbound-vscode", version: "0.3.0" } },
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
    }),
  );
}

export function deactivate(): void { /* no-op */ }
