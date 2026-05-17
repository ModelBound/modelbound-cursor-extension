import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import chokidar from 'chokidar';
import axios from 'axios';

let fileWatcher: chokidar.FSWatcher | null = null;

/**
 * Detects which IDE-native context directories exist in the workspace
 * and returns all paths that should be watched for bi-directional sync.
 */
function getWatchedFolders(workspaceRoot: string): string[] {
  const folders: string[] = [];

  // ModelBound canonical folder (always included)
  folders.push(path.join(workspaceRoot, '.modelbound'));

  // Kiro skills directory
  const kiroSkills = path.join(workspaceRoot, '.kiro', 'skills');
  if (fs.existsSync(kiroSkills)) {
    folders.push(kiroSkills);
  }

  // Cursor rules directory
  const cursorRules = path.join(workspaceRoot, '.cursor', 'rules');
  if (fs.existsSync(cursorRules)) {
    folders.push(cursorRules);
  }

  // Claude directory
  const claudeDir = path.join(workspaceRoot, '.claude');
  if (fs.existsSync(claudeDir)) {
    folders.push(claudeDir);
  }

  return folders;
}

/**
 * When pulling a skill from ModelBound, write it to all detected IDE-native
 * locations so each tool can discover it natively.
 */
function getSkillOutputPaths(workspaceRoot: string, skillId: string): string[] {
  const paths: string[] = [];

  // Always write to .modelbound/
  const modelboundDir = path.join(workspaceRoot, '.modelbound');
  if (!fs.existsSync(modelboundDir)) {
    fs.mkdirSync(modelboundDir, { recursive: true });
  }
  paths.push(path.join(modelboundDir, `${skillId}.md`));

  // Write to .kiro/skills/ if .kiro/ exists
  const kiroDir = path.join(workspaceRoot, '.kiro');
  if (fs.existsSync(kiroDir)) {
    const kiroSkills = path.join(kiroDir, 'skills');
    if (!fs.existsSync(kiroSkills)) {
      fs.mkdirSync(kiroSkills, { recursive: true });
    }
    paths.push(path.join(kiroSkills, `${skillId}.md`));
  }

  // Write to .cursor/rules/ if .cursor/ exists
  const cursorDir = path.join(workspaceRoot, '.cursor');
  if (fs.existsSync(cursorDir)) {
    const cursorRules = path.join(cursorDir, 'rules');
    if (!fs.existsSync(cursorRules)) {
      fs.mkdirSync(cursorRules, { recursive: true });
    }
    paths.push(path.join(cursorRules, `${skillId}.md`));
  }

  // Write to .claude/ if it exists
  const claudeDir = path.join(workspaceRoot, '.claude');
  if (fs.existsSync(claudeDir)) {
    paths.push(path.join(claudeDir, `${skillId}.md`));
  }

  return paths;
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const config = vscode.workspace.getConfiguration('modelbound');
  let apiKey = config.get<string>('apiKey');
  const autoSync = config.get<boolean>('autoSync');
  const localFolder = path.join(workspaceRoot, '.modelbound');

  // 0. Onboarding: Prompt for API key if not configured
  if (!apiKey) {
    const action = await vscode.window.showInformationMessage(
      'ModelBound: No API key configured. Would you like to set one now?',
      'Enter API Key',
      'Later'
    );

    if (action === 'Enter API Key') {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your ModelBound.co API Key',
        placeHolder: 'mb_live_...',
        password: true,
        ignoreFocusOut: true
      });

      if (input) {
        await config.update('apiKey', input, vscode.ConfigurationTarget.Global);
        apiKey = input;
        vscode.window.showInformationMessage('ModelBound: API key saved successfully.');
      }
    }
  }

  // 1. Ensure workspace isolation directory exists
  if (!fs.existsSync(localFolder)) {
    fs.mkdirSync(localFolder, { recursive: true });
  }

  // 2. File System Watcher: Watch all IDE-native context directories
  if (autoSync && apiKey) {
    const watchedFolders = getWatchedFolders(workspaceRoot);

    fileWatcher = chokidar.watch(watchedFolders, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true
    });

    // Track syncing state to prevent echo loops when we write to multiple dirs
    let isSyncing = false;

    fileWatcher.on('change', async (filePath) => {
      if (isSyncing) return;
      if (!filePath.endsWith('.md') && !filePath.endsWith('.json')) return;

      const fileContent = fs.readFileSync(filePath, 'utf8');
      const skillId = path.basename(filePath, path.extname(filePath));

      vscode.window.setStatusBarMessage(`$(sync~spin) ModelBound: Syncing ${skillId}...`);

      try {
        isSyncing = true;
        await axios.patch(
          `https://api.modelbound.co/v1/skills/${skillId}`,
          { content: fileContent },
          { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        vscode.window.setStatusBarMessage(`$(check) ModelBound: Synced ${skillId}`, 3000);
      } catch (error) {
        vscode.window.showErrorMessage(`ModelBound Sync Failed for ${skillId}`);
      } finally {
        // Small delay to let file system events settle before re-enabling
        setTimeout(() => { isSyncing = false; }, 1000);
      }
    });
  }

  // 3. Command Palette Route: Manual Force-Pull (writes to all IDE-native locations)
  let pullCommand = vscode.commands.registerCommand('modelbound.pullSkill', async () => {
    const skillId = await vscode.window.showInputBox({ prompt: 'Enter ModelBound Skill ID' });
    if (!skillId || !apiKey) return;

    try {
      const response = await axios.get(
        `https://api.modelbound.co/v1/skills/${skillId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );

      const outputPaths = getSkillOutputPaths(workspaceRoot, skillId);
      for (const destPath of outputPaths) {
        fs.writeFileSync(destPath, response.data.content, 'utf8');
      }

      const locations = outputPaths.map(p => path.relative(workspaceRoot, p)).join(', ');
      vscode.window.showInformationMessage(`Pulled ${skillId} → ${locations}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to pull context: ${error}`);
    }
  });

  // 4. Command Palette Route: Set/Update API Key
  let setKeyCommand = vscode.commands.registerCommand('modelbound.setApiKey', async () => {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter your ModelBound.co API Key',
      placeHolder: 'mb_live_...',
      password: true,
      ignoreFocusOut: true
    });

    if (input) {
      const cfg = vscode.workspace.getConfiguration('modelbound');
      await cfg.update('apiKey', input, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('ModelBound: API key updated. Reload window to apply.');
    }
  });

  context.subscriptions.push(pullCommand, setKeyCommand);
}

export function deactivate() {
  if (fileWatcher) fileWatcher.close();
}
