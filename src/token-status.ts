import * as vscode from 'vscode';
import { isSkillFile } from './skillDetect';
import { tokenProfile } from './tokenProfile';

/** Updates from the editor buffer (including unsaved text). No API, login or AI. */
export function registerTokenStatus(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem('modelbound.tokenFootprint', vscode.StatusBarAlignment.Right, 100);
  item.name = 'ModelBound instruction tokens';
  item.command = 'modelbound.showTokenProfile';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !isSkillFile(doc.uri)) { item.hide(); return; }
    const p = tokenProfile(doc.getText());
    item.text = `$(symbol-number) ~${p.tokens.toLocaleString()} tokens`;
    item.tooltip = `ModelBound: estimated tokens in this instruction file, including unsaved edits. Not actual agent usage. ${p.blocking} blocking, ${p.warnings} warnings. Click for findings. Computed locally; no AI cost.`;
    item.show();
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, 120);
  };
  context.subscriptions.push(item,
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === vscode.window.activeTextEditor?.document) schedule();
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('modelbound.skillGlobs')) update(); }),
    { dispose: () => { if (timer) clearTimeout(timer); } },
  );
  // A second controller may be mounted by editor-host tests; register the command once per host.
  if (!commandRegistered) context.subscriptions.push(vscode.commands.registerCommand('modelbound.showTokenProfile', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !isSkillFile(doc.uri)) return;
      const p = tokenProfile(doc.getText());
      const selected = await vscode.window.showQuickPick([
        { label: `~${p.tokens.toLocaleString()} estimated tokens`, description: 'Current file · local estimate, not billed usage' },
        ...p.findings.map(f => ({ label: f.title, description: `${f.id}${f.line ? ` · line ${f.line}` : ''}`, detail: f.fix, line: f.line })),
      ], { title: 'ModelBound · instruction footprint' });
      if (selected && 'line' in selected && typeof selected.line === 'number') {
        const line = Math.min(Math.max(0, selected.line - 1), doc.lineCount - 1);
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(line, 0, line, 0);
        editor.revealRange(doc.lineAt(line).range);
      }
    }), { dispose: () => { commandRegistered = false; } });
  commandRegistered = true;
  update();
  return item;
}

let commandRegistered = false;