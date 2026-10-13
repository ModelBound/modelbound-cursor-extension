import * as vscode from 'vscode';
import { staticScan } from './flightCheckRules';

const SKILL_FILE = /(SKILL\.md|CLAUDE\.md|AGENTS\.md|\.cursorrules|\.mdc)$|[\\/](\.cursor[\\/]rules|\.claude|\.kiro|skills)[\\/].*\.md$/i;

/** Flight Check: offline safety scan shown as editor diagnostics. Zero network, zero AI cost. */
export function registerFlightCheck(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('modelbound-flight-check');
  context.subscriptions.push(diagnostics);

  const scan = (doc: vscode.TextDocument): number => {
    const r = staticScan(doc.getText());
    diagnostics.set(doc.uri, r.findings.map((f) => {
      const line = Math.max(0, (f.line ?? 1) - 1);
      const range = doc.lineAt(Math.min(line, doc.lineCount - 1)).range;
      const d = new vscode.Diagnostic(range, `${f.title} — ${f.fix}`,
        f.severity === 'blocking' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'ModelBound Flight Check';
      d.code = f.id;
      return d;
    }));
    return r.blocking;
  };

  const auto = (doc: vscode.TextDocument) => { if (SKILL_FILE.test(doc.uri.fsPath)) scan(doc); };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(auto),
    vscode.workspace.onDidSaveTextDocument(auto),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
  );
  vscode.workspace.textDocuments.forEach(auto);

  context.subscriptions.push(vscode.commands.registerCommand('modelbound.flightCheck', async () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) { vscode.window.showInformationMessage('Open a skill or prompt file to run Flight Check.'); return; }
    const r = staticScan(doc.getText());
    scan(doc);
    const msg = r.blocking
      ? `Flight Check: ${r.blocking} blocking, ${r.warnings} warnings. See the Problems panel.`
      : r.warnings ? `Flight Check: no blocking issues, ${r.warnings} warnings.` : 'Flight Check: all clear.';
    const pick = await vscode.window.showInformationMessage(msg, 'Measure Skill Lift');
    if (pick) vscode.env.openExternal(vscode.Uri.parse('https://modelbound.co/flight-check'));
  }));
}
