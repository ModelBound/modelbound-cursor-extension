// 60-second undo toast shown after an Optimize or Restore.
//
// Mechanism: every cloud write returns a `previous_version_id` and a
// `new_version_id`. We surface a non-blocking notification with an
// "Undo" action that, when clicked, calls `skill.restore` with the
// previous version — non-destructive (creates yet another version on top
// of history). After `modelbound.undoToastSeconds` the toast auto-dismisses.
import * as vscode from "vscode";
import { ApiCtx, api } from "./api.js";

export interface UndoContext {
  slug: string;
  previous_version_id: string;
  new_version_id: string;
  /** Human label for the toast body (e.g. "optimization", "restore"). */
  action: string;
}

export async function showUndoToast(
  getApi: () => Promise<ApiCtx>,
  c: UndoContext,
): Promise<void> {
  const secs =
    vscode.workspace.getConfiguration("modelbound").get<number>("undoToastSeconds", 60);

  let dismissed = false;
  const timer = setTimeout(() => { dismissed = true; }, secs * 1000);

  const pick = await vscode.window.showInformationMessage(
    `ModelBound: ${c.action} saved as ${c.new_version_id.slice(0, 7)}. Undo within ${secs}s?`,
    { modal: false },
    "Undo",
    "Dismiss",
  );
  clearTimeout(timer);
  if (dismissed || pick !== "Undo") return;

  try {
    const ax = await getApi();
    const res = await api<{ new_version_id: string }>("/api/cli/skill/restore" as any, {
      method: "POST",
      body: { slug: c.slug, version_id: c.previous_version_id },
    } as any).catch(async () => {
      // Fallback when the helper isn't passed (e.g. tests).
      return await api<{ new_version_id: string }>(ax, "/api/cli/skill/restore", {
        method: "POST",
        body: { slug: c.slug, version_id: c.previous_version_id },
      });
    });
    vscode.window.showInformationMessage(
      `ModelBound: undone. Restored as ${res.new_version_id.slice(0, 7)}.`,
    );
  } catch (e) {
    vscode.window.showErrorMessage(`ModelBound: undo failed — ${(e as Error).message}`);
  }
}
