// Persistent status bar for ModelBound health and last sync.
import * as vscode from 'vscode';

export class ModelBoundStatusBar {
  private item: vscode.StatusBarItem;
  private apiKey: string;
  private mcpUrl: string;
  private timer?: NodeJS.Timeout;

  constructor(apiKey: string, mcpUrl: string) {
    this.apiKey = apiKey;
    this.mcpUrl = mcpUrl;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'modelbound.showHealth';
    this.item.tooltip = 'ModelBound: Click for project health';
    this.update('$(sync~spin) ModelBound', 'Initializing...');
    this.item.show();
    this.startPolling();
  }

  update(text: string, tooltip: string): void {
    this.item.text = text;
    this.item.tooltip = tooltip;
  }

  refreshKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.startPolling();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }

  private startPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.poll();
    this.timer = setInterval(() => this.poll(), 30_000);
  }

  private async poll(): Promise<void> {
    if (!this.apiKey) {
      this.update('$(circle-slash) ModelBound', 'Not signed in');
      return;
    }
    try {
      const res = await fetch(this.mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: 'pipeline.status', arguments: { source: 'cursor-extension' } },
        }),
      });
      if (!res.ok) { this.update('$(warning) ModelBound', 'Health check failed'); return; }
      const body = await res.text();
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { return; }
      const data = parsed?.result?.structuredContent ?? parsed?.result ?? null;
      const score = data?.overallScore ?? '—';
      const budgets = data?.budgets as Array<{ status: string }> | undefined;
      const warn = budgets?.some((b) => b.status === 'warning');
      const bad = budgets?.some((b) => b.status !== 'ok' && b.status !== 'warning');
      const icon = bad ? '$(error)' : warn ? '$(warning)' : '$(check)';
      this.update(`${icon} MB ${score}/100`, `Score: ${score}/100 · ${budgets?.length ?? 0} budgets tracked`);
    } catch {
      this.update('$(warning) ModelBound', 'Health check unreachable');
    }
  }
}
