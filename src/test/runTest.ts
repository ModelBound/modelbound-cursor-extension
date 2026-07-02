import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const testWorkspace = path.resolve(__dirname, '../../test-workspace');
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-vsc-'));

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [testWorkspace, '--disable-extensions', `--user-data-dir=${userDataDir}`],
    });
  } catch (err) {
    console.error('Failed to run extension tests', err);
    process.exit(1);
  }
}

main();
