import * as assert from 'assert';
import * as vscode from 'vscode';

suite('ModelBound extension smoke', () => {
  test('registers core commands', async () => {
    const ext = vscode.extensions.getExtension('ModelBound.modelbound-cursor-extension');
    assert.ok(ext, 'extension not found');
    await ext!.activate();

    const expected = [
      'modelbound.pullSkill',
      'modelbound.syncCurrentFile',
      'modelbound.runSkillPipeline',
      'modelbound.runSkillTest',
      'modelbound.showSkillVersions',
      'modelbound.optimize',
      'modelbound.showHealth',
    ];
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
