// Skill CodeLens provider — trust score, versions, and Test & Optimize quick actions.
import * as vscode from 'vscode';
import { isSkillFile } from './skillDetect';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SkillLensTarget = {
  skillId: string;
  label: string;
};

export class SkillCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private apiKey: string;
  private mcpUrl: string;
  private resolveTarget: (document: vscode.TextDocument) => SkillLensTarget | null;
  private cache = new Map<string, { trust?: number; critical?: number; ts: number }>();
  private cacheTtlMs = 60_000;

  constructor(
    apiKey: string,
    mcpUrl: string,
    resolveTarget: (document: vscode.TextDocument) => SkillLensTarget | null,
  ) {
    this.apiKey = apiKey;
    this.mcpUrl = mcpUrl;
    this.resolveTarget = resolveTarget;
  }

  setAuth(apiKey: string, mcpUrl: string): void {
    this.apiKey = apiKey;
    this.mcpUrl = mcpUrl;
    this.cache.clear();
    this._onDidChangeCodeLenses.fire();
  }

  refresh(): void {
    this.cache.clear();
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
    if (!isSkillFile(document.uri)) return [];

    const target = this.resolveTarget(document);
    if (!target) return [];

    const cached = this.cache.get(target.skillId);
    const headerLine = this.findHeaderLine(document);
    const lenses: vscode.CodeLens[] = [];
    const range = new vscode.Range(headerLine, 0, headerLine, 0);

    const trustText =
      cached?.trust != null
        ? `$(shield) Trust ${cached.trust}/100${cached.critical ? ` · ${cached.critical} critical` : ''}`
        : '$(shield) Trust & Safety';
    lenses.push(
      new vscode.CodeLens(range, {
        title: trustText,
        command: 'modelbound.showSkillFindings',
        arguments: [target.skillId],
      }),
    );

    lenses.push(
      new vscode.CodeLens(range, {
        title: '$(rocket) Pipeline',
        command: 'modelbound.runSkillPipeline',
        arguments: [target.skillId],
      }),
      new vscode.CodeLens(range, {
        title: '$(pulse) Benchmark',
        command: 'modelbound.benchmarkSkill',
        arguments: [target.skillId],
      }),
      new vscode.CodeLens(range, {
        title: '$(lightbulb) Suggest',
        command: 'modelbound.suggestSkillImprovements',
        arguments: [target.skillId],
      }),
      new vscode.CodeLens(range, {
        title: '$(versions) Versions',
        command: 'modelbound.showSkillVersions',
        arguments: [target.skillId],
      }),
    );

    this.fetchAsync(target.skillId);
    return lenses;
  }

  private findHeaderLine(document: vscode.TextDocument): number {
    if (document.lineAt(0).text !== '---') return 0;
    for (let i = 1; i < Math.min(document.lineCount, 40); i++) {
      if (document.lineAt(i).text === '---') return i + 1;
    }
    return 0;
  }

  private async fetchAsync(skillId: string): Promise<void> {
    if (!this.apiKey || !UUID_RE.test(skillId)) return;
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
          params: { name: 'list_skill_findings', arguments: { skill_id: skillId } },
        }),
      });
      if (!res.ok) return;
      const body = await res.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        const line = body.split('\n').filter((l) => l.startsWith('data:')).pop()?.slice(5).trim();
        if (line) parsed = JSON.parse(line);
      }
      const payload = parsed?.result?.structuredContent;
      if (!payload?.scores) return;
      const critical = (payload.findings as Array<{ severity?: string; ignored?: boolean }> | undefined)?.filter(
        (f) => !f.ignored && String(f.severity).toLowerCase() === 'critical',
      ).length;
      this.cache.set(skillId, { trust: payload.scores.total, critical, ts: Date.now() });
      this._onDidChangeCodeLenses.fire();
    } catch {
      /* silent */
    }
  }
}
