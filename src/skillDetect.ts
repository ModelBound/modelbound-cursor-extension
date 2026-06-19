// Determine whether a file URI looks like an agent-skill file. Used by:
//   - the "modelbound.isSkillFile" context key (menu visibility)
//   - the status bar visibility
//   - the CodeLens provider's gating
import * as vscode from "vscode";
import * as path from "node:path";

export function getSkillGlobs(): string[] {
  return (
    vscode.workspace.getConfiguration("modelbound").get<string[]>("skillGlobs") ?? []
  );
}

export function isSkillFile(uri: vscode.Uri | undefined): boolean {
  if (!uri || uri.scheme !== "file") return false;
  const rel = vscode.workspace.asRelativePath(uri, false);
  const base = path.basename(rel);
  if (base === "SKILL.md") return true;
  if (/^\.modelbound\/[^/]+\.(md|json)$/i.test(rel)) return true;
  if (/^\.kiro\/skills\/[^/]+\.md$/i.test(rel)) return true;
  if (/^\.cursor\/rules\/[^/]+\.(md|mdc)$/i.test(rel)) return true;
  if (/^\.claude\/[^/]+\.md$/i.test(rel)) return true;
  return /(^|\/)(skills|\.cursor\/skills|\.agents\/skills|\.workspace\/skills)\//.test(rel);
}
