import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import chokidar from 'chokidar';
import axios from 'axios';
import { startMcpServer, stopMcpServer } from './mcpServer';

let fileWatcher: chokidar.FSWatcher | null = null;

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const config = vscode.workspace.getConfiguration('modelbound');
  const apiKey = config.get<string>('apiKey');
  const autoSync = config.get<boolean>('autoSync');
  const localFolder = path.join(workspaceRoot, '.modelbound');

  // 1. Ensure workspace isolation directory exists
  if (!fs.existsSync(localFolder)) {
    fs.mkdirSync(localFolder, { recursive: true });
  }

  // 2. Spin up the native, in-process MCP Server for AI Agent routing
  if (apiKey) {
    try {
      startMcpServer(apiKey, localFolder);
      console.log('ModelBound MCP Server activated.');
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to start ModelBound MCP: ${err}`);
    }
  }

  // 3. File System Watcher: Silent push modifications back to Cloud
  if (autoSync && apiKey) {
    fileWatcher = chokidar.watch(localFolder, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true
    });

    fileWatcher.on('change', async (filePath) => {
      if (!filePath.endsWith('.md') && !filePath.endsWith('.json')) return;

      const fileContent = fs.readFileSync(filePath, 'utf8');
      const skillId = path.basename(filePath, path.extname(filePath));

      vscode.window.setStatusBarMessage(`$(sync~spin) ModelBound: Syncing ${skillId}...`);

      try {
        await axios.patch(
          `https://api.modelbound.co/v1/skills/${skillId}`,
          { content: fileContent },
          { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        vscode.window.setStatusBarMessage(`$(check) ModelBound: Synced ${skillId}`, 3000);
      } catch (error) {
        vscode.window.showErrorMessage(`ModelBound Sync Failed for ${skillId}`);
      }
    });
  }

  // 4. Command Palette Route: Manual Force-Pull
  let pullCommand = vscode.commands.registerCommand('modelbound.pullSkill', async () => {
    const skillId = await vscode.window.showInputBox({ prompt: 'Enter ModelBound Skill ID' });
    if (!skillId || !apiKey) return;

    try {
      const response = await axios.get(
        `https://api.modelbound.co/v1/skills/${skillId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );

      const destPath = path.join(localFolder, `${skillId}.md`);
      fs.writeFileSync(destPath, response.data.content, 'utf8');
      vscode.window.showInformationMessage(`Successfully pulled ${skillId} to local workspace.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to pull context: ${error}`);
    }
  });

  context.subscriptions.push(pullCommand);
}

export function deactivate() {
  if (fileWatcher) fileWatcher.close();
  stopMcpServer();
}
