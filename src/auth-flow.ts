// Unified ModelBound credential request flow for sync, sign-in command, and
// MCP auth recovery. Collapses the old multi-step prompts into one choice, then
// either opens the browser immediately or accepts a pasted API key.

import * as vscode from 'vscode';
import { runBrowserSignIn } from './device-auth';

export type AuthRequestReason = 'missing' | 'invalid' | 'sync' | 'manual';

const REASON_TEXT: Record<AuthRequestReason, string> = {
  missing: 'ModelBound needs an API key before it can sync.',
  invalid: 'Your ModelBound API key is no longer valid.',
  sync: 'Sign in to sync this skill or context file.',
  manual: 'Connect ModelBound to this workspace.',
};

export async function requestModelBoundCredentials(opts: {
  reason?: AuthRequestReason;
  log?: (msg: string) => void;
  onKeySaved?: (key: string) => void | Promise<void>;
}): Promise<string | undefined> {
  const reason = opts.reason ?? 'missing';
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(globe) Sign in with Browser',
        description: 'Recommended — opens ModelBound to approve and issue a new key',
        value: 'browser' as const,
      },
      {
        label: '$(key) Paste API Key',
        description: 'Use an existing mb_live_… key from modelbound.co/settings',
        value: 'paste' as const,
      },
    ],
    {
      title: 'ModelBound',
      placeHolder: REASON_TEXT[reason],
      ignoreFocusOut: true,
    },
  );
  if (!pick) return undefined;

  if (pick.value === 'browser') {
    try {
      const { apiKey, email } = await runBrowserSignIn(opts.log);
      await opts.onKeySaved?.(apiKey);
      vscode.window.showInformationMessage(
        email ? `ModelBound: Signed in as ${email}. Sync is ready.` : 'ModelBound: Signed in. Sync is ready.',
      );
      return apiKey;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.(`Browser sign-in failed: ${msg}`);
      if (msg !== 'Sign-in cancelled') {
        vscode.window.showErrorMessage(`ModelBound sign-in failed: ${msg}`);
      }
      return undefined;
    }
  }

  return promptPasteApiKey(opts.onKeySaved);
}

async function promptPasteApiKey(
  onKeySaved?: (key: string) => void | Promise<void>,
): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: 'Paste your ModelBound API key',
    placeHolder: 'mb_live_...',
    password: true,
    ignoreFocusOut: true,
  });
  if (!input?.trim()) return undefined;

  const key = input.trim();
  await vscode.workspace.getConfiguration('modelbound').update('apiKey', key, vscode.ConfigurationTarget.Global);
  await onKeySaved?.(key);
  vscode.window.showInformationMessage('ModelBound: API key saved. Sync is ready.');
  return key;
}
