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
  // Quick path-based heuristic so we don't pay a glob match on every selection change.
  const base = path.basename(rel);
  if (base === "SKILL.md") return true;
  return /(^|\/)(skills|\.cursor\/skills|\.agents\/skills|\.workspace\/skills)\//.test(rel);
}
