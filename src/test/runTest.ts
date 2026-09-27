import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

/** VS Code 1.139+ macOS builds ship `Code` only; @vscode/test-electron still points at `Electron`. */
function resolveVscodeExecutable(defaultPath: string): string {
  if (fs.existsSync(defaultPath)) return defaultPath;
  if (process.platform === 'darwin') {
    const code = path.join(path.dirname(defaultPath), 'Code');
    if (fs.existsSync(code)) return code;
  }
  return defaultPath;
}

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const testWorkspace = path.resolve(__dirname, '../../test-workspace');
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-vsc-'));
    const launchArgs = [
      testWorkspace,
      '--disable-extensions',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${userDataDir}`,
    ];

    const runOptions = { extensionDevelopmentPath, extensionTestsPath, launchArgs };
    const vscodeExecutablePath = resolveVscodeExecutable(await downloadAndUnzipVSCode(runOptions));

    await runTests({
      ...runOptions,
      vscodeExecutablePath,
    });
  } catch (err) {
    console.error('Failed to run extension tests', err);
    process.exit(1);
  }
}

main();
