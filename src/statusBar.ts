// Status bar entry for the active skill file.
//
// Shows live token count + trust score, color-coded against the project's
// memory thresholds (System 5k, Skill files generally < 4k). Clicking opens
// the Skill Development Pipeline for the current file.
import * as vscode from "vscode";
import { ApiCtx, api } from "./api.js";
import { isSkillFile } from "./skillDetect.js";

interface SkillSummary {
  slug?: string;
  tokens?: number;
  trust_score?: number; // 0..10
  version_id?: string;
}

export function registerStatusBar(
  ctx: vscode.ExtensionContext,
  getApi: () => Promise<ApiCtx>,
): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.command = "modelbound.pipeline";
  ctx.subscriptions.push(item);

  let inFlight = 0;
  const refresh = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSkillFile(editor.document.uri)) {
      item.hide();
      return;
    }
    const myReq = ++inFlight;
    item.text = "$(sync~spin) ModelBound";
    item.show();
    try {
      const ax = await getApi();
      // Best-effort lookup; if the file isn't in the cloud yet we still want a
      // local token count so the badge is never empty.
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      const text = editor.document.getText();
      const summary = await api<SkillSummary>(ax, "/api/cli/skill/summary", {
        method: "POST",
        body: { path: rel, content: text },
      }).catch(() => ({ tokens: estimateTokens(text) }));
      if (myReq !== inFlight) return; // a newer call has superseded us
      const tok = summary.tokens ?? estimateTokens(text);
      const trust = typeof summary.trust_score === "number" ? `· ${summary.trust_score.toFixed(1)}` : "";
      item.text = `$(symbol-misc) ${tok.toLocaleString()} tok ${trust}`.trim();
      item.tooltip = "ModelBound — click to run the Skill Development Pipeline.";
      // Soft warning if the file is heavy.
      item.backgroundColor =
        tok > 4000
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    } catch {
      item.text = "$(warning) ModelBound";
      item.tooltip = "ModelBound API unreachable. Click to run health check.";
      item.command = "modelbound.health";
    }
  };

  const sub = vscode.Disposable.from(
    vscode.window.onDidChangeActiveTextEditor(() => void refresh()),
    vscode.workspace.onDidSaveTextDocument(() => void refresh()),
  );
  ctx.subscriptions.push(sub);
  void refresh();
  return sub;
}

// Rough char-based fallback when the API is offline. Real token counts come
// from the server. ~3.5 chars/token is a reasonable estimate for English
// markdown skill files.
function estimateTokens(s: string): number {
  return Math.max(0, Math.round(s.length / 3.5));
}
