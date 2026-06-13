// Skill CodeLens provider — shows version count, score, and quick actions on SKILL.md files.
import * as vscode from 'vscode';

export class SkillCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private apiKey: string;
  private mcpUrl: string;
  private cache = new Map<string, { versions: number; score?: number; ts: number }>();
  private cacheTtlMs = 60_000;

  constructor(apiKey: string, mcpUrl: string) {
    this.apiKey = apiKey;
    this.mcpUrl = mcpUrl;
  }

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
    const fileName = document.fileName;
    if (!fileName.endsWith('SKILL.md')) return [];

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const skillId = this.inferSkillId(document, workspaceRoot);
    if (!skillId) return [];

    const cached = this.cache.get(skillId);
    const lenses: vscode.CodeLens[] = [];

    // Header lens — version count & score
    const headerLine = this.findFrontmatterEnd(document);
    const scoreText = cached?.score != null ? ` · score ${cached.score}/100` : '';
    const versionsText = cached ? `📦 ${cached.versions} version${cached.versions === 1 ? '' : 's'}${scoreText}` : 'ModelBound: loading…';
    lenses.push(
      new vscode.CodeLens(new vscode.Range(headerLine, 0, headerLine, 0), {
        title: versionsText,
        command: 'modelbound.showSkillVersions',
        arguments: [skillId],
      })
    );

    // Quick action lenses
    lenses.push(
      new vscode.CodeLens(new vscode.Range(headerLine, 0, headerLine, 0), {
        title: '$(rocket) Pipeline',
        command: 'modelbound.runSkillPipeline',
        arguments: [skillId],
      }),
      new vscode.CodeLens(new vscode.Range(headerLine, 0, headerLine, 0), {
        title: '$(debug-start) Test',
        command: 'modelbound.runSkillTest',
        arguments: [skillId],
      })
    );

    this.fetchAsync(skillId);
    return lenses;
  }

  private inferSkillId(document: vscode.TextDocument, workspaceRoot: string): string | null {
    const rel = vscode.workspace.asRelativePath(document.uri);
    const agents = rel.match(/^\.agents\/skills\/([^/]+)\/SKILL\.md$/);
    if (agents) return agents[1];
    const basename = rel.split('/').pop()?.replace(/\.md$/, '') ?? '';
    return basename || null;
  }

  private findFrontmatterEnd(document: vscode.TextDocument): number {
    if (document.lineAt(0).text !== '---') return 0;
    for (let i = 1; i < Math.min(document.lineCount, 40); i++) {
      if (document.lineAt(i).text === '---') return i + 1;
    }
    return 0;
  }

  private async fetchAsync(skillId: string): Promise<void> {
    const cached = this.cache.get(skillId);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return;
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
          params: { name: 'skill.versions', arguments: { skillId, source: 'cursor-extension' } },
        }),
      });
      if (!res.ok) return;
      const body = await res.text();
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { return; }
      const result = parsed?.result?.structuredContent ?? null;
      if (!result?.versions) return;
      const versions = result.versions as Array<{ score?: number }>;
      const score = versions[0]?.score;
      this.cache.set(skillId, { versions: versions.length, score, ts: Date.now() });
      this._onDidChangeCodeLenses.fire();
    } catch { /* silent */ }
  }
}
