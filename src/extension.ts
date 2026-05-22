import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const WATCH_GLOBS = [
  '.modelbound/**/*.{md,json}',
  '.kiro/skills/**/*.md',
  '.cursor/rules/**/*.md',
  '.claude/**/*.md',
];

const watchers: vscode.FileSystemWatcher[] = [];

type RepoInfo = { repoUrl: string | null; branch: string | null };

function getRepoInfo(workspaceRoot: string): RepoInfo {
  try {
    const run = (cmd: string) =>
      execSync(cmd, { cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    const remote = run('git config --get remote.origin.url');
    const branch = run('git rev-parse --abbrev-ref HEAD');
    const repoUrl = remote
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/\.git$/, '');
    return { repoUrl, branch };
  } catch {
    return { repoUrl: null, branch: null };
  }
}

function detectIde(): string {
  const app = (process.env.TERM_PROGRAM || '').toLowerCase();
  if (process.env.CURSOR_TRACE_ID || app.includes('cursor')) return 'cursor';
  if (process.env.KIRO_SESSION) return 'kiro';
  if (process.env.CLAUDE_CODE) return 'claude';
  if (process.env.VSCODE_PID) return 'vscode';
  return 'unknown';
}

function relPath(workspaceRoot: string, fsPath: string): string {
  return path.relative(workspaceRoot, fsPath).split(path.sep).join('/');
}

/**
 * Call an MCP tool over Streamable HTTP. The spec requires
 * Accept: application/json, text/event-stream — without it,
 * compliant servers respond with 406.
 */
async function callMcpTool(
  mcpUrl: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>
): Promise<void> {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MCP ${name} failed: ${res.status} ${body}`);
  }
}

function getSkillOutputPaths(workspaceRoot: string, skillId: string): string[] {
  const paths: string[] = [];

  const modelboundDir = path.join(workspaceRoot, '.modelbound');
  if (!fs.existsSync(modelboundDir)) fs.mkdirSync(modelboundDir, { recursive: true });
  paths.push(path.join(modelboundDir, `${skillId}.md`));

  const kiroDir = path.join(workspaceRoot, '.kiro');
  if (fs.existsSync(kiroDir)) {
    const kiroSkills = path.join(kiroDir, 'skills');
    if (!fs.existsSync(kiroSkills)) fs.mkdirSync(kiroSkills, { recursive: true });
    paths.push(path.join(kiroSkills, `${skillId}.md`));
  }

  const cursorDir = path.join(workspaceRoot, '.cursor');
  if (fs.existsSync(cursorDir)) {
    const cursorRules = path.join(cursorDir, 'rules');
    if (!fs.existsSync(cursorRules)) fs.mkdirSync(cursorRules, { recursive: true });
    paths.push(path.join(cursorRules, `${skillId}.md`));
  }

  const claudeDir = path.join(workspaceRoot, '.claude');
  if (fs.existsSync(claudeDir)) {
    paths.push(path.join(claudeDir, `${skillId}.md`));
  }

  return paths;
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;
  const workspaceRoot = workspaceFolder.uri.fsPath;

  const config = vscode.workspace.getConfiguration('modelbound');
  let apiKey = config.get<string>('apiKey');
  const autoSync = config.get<boolean>('autoSync');
  const mcpUrl =
    config.get<string>('mcpUrl') || 'https://mcp.modelbound.co/mcp';

  // 0. Onboarding: prompt for API key if missing
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
        ignoreFocusOut: true,
      });
      if (input) {
        await config.update('apiKey', input, vscode.ConfigurationTarget.Global);
        apiKey = input;
        vscode.window.showInformationMessage('ModelBound: API key saved.');
      }
    }
  }

  // 1. Ensure canonical .modelbound/ exists
  const localFolder = path.join(workspaceRoot, '.modelbound');
  if (!fs.existsSync(localFolder)) fs.mkdirSync(localFolder, { recursive: true });

  // 2. Set up file watchers (add/change/delete) for every glob
  if (autoSync && apiKey) {
    const { repoUrl, branch } = getRepoInfo(workspaceRoot);
    const ide = detectIde();

    if (!repoUrl) {
      vscode.window.showInformationMessage(
        'ModelBound: no git remote detected — skills will sync without repo association.'
      );
    }

    const syncFile = async (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      if (!filePath.endsWith('.md') && !filePath.endsWith('.json')) return;
      const skillId = path.basename(filePath, path.extname(filePath));
      vscode.window.setStatusBarMessage(`$(sync~spin) ModelBound: Syncing ${skillId}...`);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        await callMcpTool(mcpUrl, apiKey!, 'sync_skill_from_ide', {
          repo_url: repoUrl,
          branch,
          ide,
          relative_path: relPath(workspaceRoot, filePath),
          content,
        });
        vscode.window.setStatusBarMessage(`$(check) ModelBound: Synced ${skillId}`, 3000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`ModelBound sync failed for ${skillId}: ${msg}`);
      }
    };

    const deleteFile = async (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      const skillId = path.basename(filePath, path.extname(filePath));
      try {
        await callMcpTool(mcpUrl, apiKey!, 'delete_skill_from_ide', {
          repo_url: repoUrl,
          relative_path: relPath(workspaceRoot, filePath),
        });
        vscode.window.setStatusBarMessage(`$(trash) ModelBound: Removed ${skillId}`, 3000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`ModelBound delete failed for ${skillId}: ${msg}`);
      }
    };

    for (const glob of WATCH_GLOBS) {
      const pattern = new vscode.RelativePattern(workspaceFolder, glob);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(syncFile);
      watcher.onDidChange(syncFile);
      watcher.onDidDelete(deleteFile);
      watchers.push(watcher);
      context.subscriptions.push(watcher);
    }
  }

  // 3. Manual pull command (still uses REST GET — read-only, keeps existing behavior)
  const pullCommand = vscode.commands.registerCommand('modelbound.pullSkill', async () => {
    const skillId = await vscode.window.showInputBox({
      prompt: 'Enter ModelBound Skill ID',
    });
    if (!skillId || !apiKey) return;

    try {
      const res = await fetch(`https://api.modelbound.co/v1/skills/${skillId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { content: string };

      const outputPaths = getSkillOutputPaths(workspaceRoot, skillId);
      for (const destPath of outputPaths) {
        fs.writeFileSync(destPath, data.content, 'utf8');
      }
      const locations = outputPaths.map((p) => path.relative(workspaceRoot, p)).join(', ');
      vscode.window.showInformationMessage(`Pulled ${skillId} → ${locations}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to pull context: ${msg}`);
    }
  });

  // 4. Set/Update API Key
  const setKeyCommand = vscode.commands.registerCommand('modelbound.setApiKey', async () => {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter your ModelBound.co API Key',
      placeHolder: 'mb_live_...',
      password: true,
      ignoreFocusOut: true,
    });
    if (input) {
      const cfg = vscode.workspace.getConfiguration('modelbound');
      await cfg.update('apiKey', input, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        'ModelBound: API key updated. Reload window to apply.'
      );
    }
  });

  context.subscriptions.push(pullCommand, setKeyCommand);
}

export function deactivate() {
  for (const w of watchers) w.dispose();
}
