// Version webview + 60-second undo toast after restore.
import * as vscode from 'vscode';

export function versionWebviewHtml(skillId: string, versions: Array<{ id: string; createdAt: string; score?: number; label?: string; sizeBytes: number }>): string {
  const rows = versions.map((v) => {
    const score = v.score != null ? `<span class="score">${v.score}</span>` : '';
    const label = v.label ? `<span class="label">${v.label}</span>` : '';
    return `<tr data-id="${v.id}">
      <td>${v.createdAt}</td>
      <td>${v.id.slice(0, 8)}…</td>
      <td>${score}</td>
      <td>${label}</td>
      <td>${v.sizeBytes} B</td>
      <td><button class="btn-restore">Restore</button> <button class="btn-diff">Diff</button></td>
    </tr>`;
  }).join('');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 14px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h2 { margin: 0 0 4px; font-size: 14px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); }
  .score { background: rgba(46,160,67,0.18); color: #3fb950; padding: 1px 6px; border-radius: 4px; font-size: 10px; }
  .label { background: rgba(88,166,255,0.18); color: #58a6ff; padding: 1px 6px; border-radius: 4px; font-size: 10px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<h2>${skillId}</h2>
<div class="sub">${versions.length} version${versions.length === 1 ? '' : 's'}</div>
<table>
  <thead><tr><th>Date</th><th>ID</th><th>Score</th><th>Label</th><th>Size</th><th>Actions</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<script>
  const vscodeApi = acquireVsCodeApi();
  document.querySelectorAll('.btn-restore').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('tr').dataset.id;
      vscodeApi.postMessage({ type: 'restore', versionId: id });
    });
  });
  document.querySelectorAll('.btn-diff').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('tr').dataset.id;
      vscodeApi.postMessage({ type: 'diff', versionId: id });
    });
  });
</script>
</body>
</html>`;
}

export async function showUndoToast(editor: vscode.TextEditor, restoredPath: string): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    `ModelBound: restored ${restoredPath}. Undo available for 60s.`,
    { modal: false },
    'Undo Restore',
  );
  if (action === 'Undo Restore') {
    await vscode.commands.executeCommand('undo');
    vscode.window.showInformationMessage('ModelBound: restore undone.');
  }
}
