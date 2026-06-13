// CodeLens above every skill file: Optimize · Pipeline · Versions.
// Cheap to compute — one lens object pinned to line 0.
import * as vscode from "vscode";
import { isSkillFile } from "./skillDetect.js";

export class SkillCodeLensProvider implements vscode.CodeLensProvider {
  private _emitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this._emitter.event;

  refresh(): void { this._emitter.fire(); }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("modelbound").get<boolean>("showCodeLens", true)) {
      return [];
    }
    if (!isSkillFile(document.uri)) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    const args = [document.uri];
    return [
      new vscode.CodeLens(range, { title: "$(zap) Optimize", command: "modelbound.optimize", arguments: args }),
      new vscode.CodeLens(range, { title: "$(rocket) Pipeline", command: "modelbound.pipeline", arguments: args }),
      new vscode.CodeLens(range, { title: "$(history) Versions", command: "modelbound.versions", arguments: args }),
    ];
  }
}
