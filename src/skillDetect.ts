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
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  const base = path.basename(rel);
  if (/^(SKILL\.md|CLAUDE\.md|AGENTS\.md|\.cursorrules|copilot-instructions\.md)$/i.test(base)) return true;
  if (base.toLowerCase().endsWith('.mdc')) return true;
  if (/^\.github\/instructions\/.*\.instructions\.md$/i.test(rel)) return true;
  if (getSkillGlobs().some(glob => globMatches(rel, glob))) return true;
  if (/^\.modelbound\/.*\.(md|json)$/i.test(rel)) return true;
  if (/^\.kiro\/skills\/.*\.md$/i.test(rel)) return true;
  if (/^\.cursor\/rules\/[^/]+\.(md|mdc)$/i.test(rel)) return true;
  if (/^\.claude\/.*\.md$/i.test(rel)) return true;
  return /(^|\/)(skills|\.cursor\/skills|\.agents\/skills|\.workspace\/skills)\//.test(rel);
}

function globMatches(value: string, glob: string): boolean {
  const normalized = glob.replace(/\\/g, '/');
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^${pattern}$`, 'i').test(value);
}
