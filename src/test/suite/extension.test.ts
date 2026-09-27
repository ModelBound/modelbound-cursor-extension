import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
    await ext!.activate();

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
});
