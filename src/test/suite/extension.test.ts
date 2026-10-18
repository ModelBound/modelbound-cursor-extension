import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerTokenStatus } from '../../token-status';
import { isSkillFile } from '../../skillDetect';

function paletteCommandsFromPackage(): string[] {
  const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    contributes?: { commands?: Array<{ command: string }> };
  };
  return (pkg.contributes?.commands ?? []).map((c) => c.command);
}

suite('ModelBound extension smoke', () => {
  test('registers all contributed commands', async () => {
    const ext = vscode.extensions.getExtension('ModelBound.modelbound-cursor-extension');
    assert.ok(ext, 'extension not found');
    if (!ext) throw new Error('extension not found');
    await ext.activate();

    const expected = paletteCommandsFromPackage();
    assert.ok(expected.length >= 20, 'expected package.json command list');
    const all = await vscode.commands.getCommands(true);
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `missing command: ${cmd}`);
    }
  });

  test('contributes modelbound configuration keys', () => {
    const config = vscode.workspace.getConfiguration('modelbound');
    assert.ok(config.has('apiKey'));
    assert.ok(config.has('mcpUrl'));
    assert.ok(config.has('autoSync'));
  });

  test('updates estimated tokens from unsaved edits and editor switching without authentication', async () => {
    const subscriptions: vscode.Disposable[] = [];
    const item = registerTokenStatus({ subscriptions } as vscode.ExtensionContext);
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error('test workspace missing');
      const file = vscode.Uri.file(path.join(root, 'CLAUDE.md'));
      await vscode.workspace.fs.writeFile(file, Buffer.from('a'.repeat(400)));
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.ok(item.text.includes('~100 tokens'), item.text);
      await editor.edit(edit => edit.insert(new vscode.Position(0, 400), 'a'.repeat(400)));
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.ok(doc.isDirty);
      assert.ok(item.text.includes('~200 tokens'), item.text);
      const rule = vscode.Uri.file(path.join(root, '.cursor', 'rules', 'test.mdc'));
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(rule.fsPath)));
      await vscode.workspace.fs.writeFile(rule, Buffer.from('a'.repeat(80)));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(rule));
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.ok(item.text.includes('~20 tokens'), item.text);
      assert.equal(isSkillFile(vscode.Uri.file(path.join(root, 'source.ts'))), false);
      assert.equal(isSkillFile(vscode.Uri.file(path.join(root, '.github', 'copilot-instructions.md'))), true);
      assert.equal(isSkillFile(vscode.Uri.file(path.join(root, '.claude', 'commands', 'review.md'))), true);
    } finally {
      subscriptions.forEach(d => d.dispose());
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
