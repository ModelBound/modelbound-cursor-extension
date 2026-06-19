import * as vscode from 'vscode';

export type SkillFinding = {
  class: string;
  message: string;
  severity: string;
  source: string;
  key: string;
  ignored: boolean;
};

export type SkillFindingsPayload = {
  skill_id: string;
  scores?: {
    total?: number;
    clarity?: number;
    safety?: number;
    fit?: number;
    ai_fit_score?: number;
    ai_fit_reason?: string;
  };
  findings?: SkillFinding[];
  ignored_keys?: string[];
  updated_at?: string;
};

type McpCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

type SkillTarget = {
  skillId: string;
  slug: string;
  relativePath: string;
  filePath: string;
  label: string;
};

type SkillTrustDeps = {
  getApiKey: () => string | undefined;
  getMcpUrl: () => string;
  workspaceRoot: string;
  pickSkillTarget: (
    workspaceRoot: string,
    opts?: { preferUri?: vscode.Uri; hint?: string; purpose?: string },
  ) => Promise<SkillTarget | undefined>;
  ensureSkillUuid: (
    mcpUrl: string,
    apiKey: string,
    target: SkillTarget,
    logFn?: (msg: string) => void,
  ) => Promise<string>;
  ensureSkillSynced: (
    mcpUrl: string,
    apiKey: string,
    workspaceRoot: string,
    target: SkillTarget,
    logFn?: (msg: string) => void,
  ) => Promise<string>;
  callMcp: McpCaller;
  log: (msg: string) => void;
};

const MCP_ALIASES: Record<string, string> = {
  list_skill_findings: 'skills.listFindings',
  ignore_skill_finding: 'skills.ignoreFinding',
  unignore_skill_finding: 'skills.unignoreFinding',
  benchmark_skill: 'skills.benchmark',
  compare_skill_versions: 'skills.compareVersions',
  suggest_skill_improvements: 'skills.suggestImprovements',
};

async function callSkillTool(callMcp: McpCaller, canonical: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await callMcp(canonical, args);
  } catch (err) {
    const alias = MCP_ALIASES[canonical];
    if (!alias) throw err;
    return callMcp(alias, args);
  }
}

export async function fetchSkillFindings(callMcp: McpCaller, skillId: string): Promise<SkillFindingsPayload> {
  const raw = await callSkillTool(callMcp, 'list_skill_findings', { skill_id: skillId });
  if (!raw || typeof raw !== 'object') {
    throw new Error('Unexpected findings response from ModelBound.');
  }
  return raw as SkillFindingsPayload;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findingsPanelHtml(label: string, payload: SkillFindingsPayload): string {
  const scores = payload.scores ?? {};
  const findings = payload.findings ?? [];
  const scoreCards = [
    ['Trust', scores.total],
    ['Clarity', scores.clarity],
    ['Safety', scores.safety],
    ['Fit', scores.fit],
  ]
    .map(
      ([name, val]) =>
        `<div class="score"><div class="score-label">${name}</div><div class="score-val">${val ?? '—'}</div></div>`,
    )
    .join('');

  const rows = findings.length
    ? findings
        .map((f) => {
          const sev = (f.severity || 'info').toLowerCase();
          const sevCls = sev === 'critical' ? 'sev-critical' : sev === 'warn' ? 'sev-warn' : 'sev-info';
          const action = f.ignored
            ? `<button class="btn btn-secondary" data-act="unignore" data-key="${escapeHtml(f.key)}">Un-ignore</button>`
            : `<button class="btn" data-act="ignore" data-key="${escapeHtml(f.key)}">Ignore</button>`;
          return `<div class="finding ${f.ignored ? 'ignored' : ''}">
            <div class="finding-head">
              <span class="badge ${sevCls}">${escapeHtml(f.severity || 'info')}</span>
              <span class="class">${escapeHtml(f.class || 'finding')}</span>
              <span class="source">${escapeHtml(f.source || '')}</span>
              ${f.ignored ? '<span class="ignored-tag">ignored</span>' : ''}
            </div>
            <div class="message">${escapeHtml(f.message || '')}</div>
            <div class="finding-actions">${action}</div>
          </div>`;
        })
        .join('')
    : '<div class="meta">No findings — trust scan is clean.</div>';

  const aiReason = scores.ai_fit_reason
    ? `<div class="meta ai-reason">AI fit (${scores.ai_fit_score ?? '—'}/100): ${escapeHtml(scores.ai_fit_reason)}</div>`
    : '';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 14px; color: var(--vscode-foreground); margin: 0; }
  h2 { margin: 0 0 4px; font-size: 14px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px; }
  .scores { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
  .score { background: var(--vscode-textCodeBlock-background); border-radius: 6px; padding: 8px; text-align: center; }
  .score-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; }
  .score-val { font-size: 18px; font-weight: 600; margin-top: 2px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .finding { border-top: 1px solid var(--vscode-panel-border); padding: 10px 0; }
  .finding.ignored { opacity: 0.72; }
  .finding-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; }
  .badge { padding: 1px 6px; border-radius: 4px; font-size: 10px; text-transform: uppercase; }
  .sev-critical { background: rgba(248, 81, 73, 0.18); color: #f85149; }
  .sev-warn { background: rgba(210, 153, 34, 0.18); color: #d29922; }
  .sev-info { background: rgba(56, 139, 253, 0.18); color: #58a6ff; }
  .class { font-weight: 600; }
  .source, .meta { color: var(--vscode-descriptionForeground); }
  .ignored-tag { margin-left: auto; font-style: italic; }
  .message { font-size: 12px; line-height: 1.45; margin-bottom: 6px; }
  .ai-reason { margin-bottom: 10px; }
  #status { min-height: 16px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  #status.error { color: #f85149; }
</style>
</head>
<body>
<h2>Trust &amp; Safety</h2>
<div class="sub">Skill: <code>${escapeHtml(label)}</code></div>
<div class="scores">${scoreCards}</div>
${aiReason}
<div class="toolbar">
  <button class="btn btn-secondary" data-act="refresh">Refresh</button>
  <button class="btn btn-secondary" data-act="benchmark">Benchmark latency</button>
  <button class="btn btn-secondary" data-act="compare">Compare versions</button>
  <button class="btn btn-secondary" data-act="suggest">Suggest improvements</button>
  <button class="btn" data-act="pipeline">Run Test &amp; Optimize</button>
</div>
<div id="findings">${rows}</div>
<div id="status"></div>
<script>
  const vscodeApi = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.className = isError ? 'error' : '';
  }
  document.body.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLButtonElement)) return;
    const act = t.dataset.act;
    if (!act) return;
    if (act === 'ignore' || act === 'unignore') {
      const key = t.dataset.key;
      if (!key) return;
      t.disabled = true;
      setStatus((act === 'ignore' ? 'Ignoring' : 'Un-ignoring') + ' finding…');
      vscodeApi.postMessage({ type: act, finding_key: key });
      return;
    }
    t.disabled = true;
    setStatus('Working…');
    vscodeApi.postMessage({ type: act });
  });
  window.addEventListener('message', (ev) => {
    const data = ev.data || {};
    if (data.type === 'status') setStatus(data.message || '', !!data.error);
  });
</script>
</body>
</html>`;
}

async function resolveTarget(
  deps: SkillTrustDeps,
  argHint?: string,
  preferUri?: vscode.Uri,
  purpose?: string,
): Promise<SkillTarget | undefined> {
  const apiKey = deps.getApiKey();
  if (!apiKey) {
    vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
    return undefined;
  }
  return deps.pickSkillTarget(deps.workspaceRoot, {
    hint: typeof argHint === 'string' ? argHint : undefined,
    preferUri,
    purpose,
  });
}

async function openFindingsPanel(
  deps: SkillTrustDeps,
  target: SkillTarget,
  skillUuid: string,
  initial?: SkillFindingsPayload,
): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    'modelboundSkillFindings',
    `ModelBound Trust · ${target.label}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const refreshPanel = async (statusMessage?: string, isError?: boolean) => {
    const payload = await fetchSkillFindings(deps.callMcp, skillUuid);
    panel.webview.html = findingsPanelHtml(target.label, payload);
    if (statusMessage) {
      panel.webview.postMessage({ type: 'status', message: statusMessage, error: !!isError });
    }
    return payload;
  };

  panel.webview.html = findingsPanelHtml(target.label, initial ?? { skill_id: skillUuid, findings: [] });

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.type === 'refresh') {
        await refreshPanel();
        return;
      }

      if (msg.type === 'ignore' && msg.finding_key) {
        await callSkillTool(deps.callMcp, 'ignore_skill_finding', {
          skill_id: skillUuid,
          finding_key: msg.finding_key,
        });
        await refreshPanel('Finding ignored. Re-run Test & Optimize to update the pipeline score.');
        deps.log(`Ignored finding on ${target.label}: ${msg.finding_key}`);
        return;
      }

      if (msg.type === 'unignore' && msg.finding_key) {
        await callSkillTool(deps.callMcp, 'unignore_skill_finding', {
          skill_id: skillUuid,
          finding_key: msg.finding_key,
        });
        await refreshPanel('Finding restored.');
        return;
      }

      if (msg.type === 'benchmark') {
        vscode.window.setStatusBarMessage(`$(loading~spin) ModelBound: Benchmarking ${target.label}…`, 4000);
        const result = await callSkillTool(deps.callMcp, 'benchmark_skill', { skill_id: skillUuid });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'json' });
        await vscode.window.showTextDocument(doc, { preview: true });
        panel.webview.postMessage({ type: 'status', message: 'Benchmark complete.' });
        return;
      }

      if (msg.type === 'compare') {
        const versionA = await vscode.window.showInputBox({
          prompt: 'From version (or "latest")',
          value: 'latest',
          ignoreFocusOut: true,
        });
        if (!versionA) return;
        const versionB = await vscode.window.showInputBox({
          prompt: 'To version (or "current")',
          value: 'current',
          ignoreFocusOut: true,
        });
        if (!versionB) return;
        const result = await callSkillTool(deps.callMcp, 'compare_skill_versions', {
          skill_id: skillUuid,
          version_a: versionA,
          version_b: versionB,
        });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'json' });
        await vscode.window.showTextDocument(doc, { preview: true });
        panel.webview.postMessage({ type: 'status', message: 'Comparison ready.' });
        return;
      }

      if (msg.type === 'suggest') {
        vscode.window.setStatusBarMessage(`$(loading~spin) ModelBound: Suggesting improvements for ${target.label}…`, 5000);
        const result = await callSkillTool(deps.callMcp, 'suggest_skill_improvements', { skill_id: skillUuid });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true });
        panel.webview.postMessage({ type: 'status', message: 'Suggestions ready.' });
        return;
      }

      if (msg.type === 'pipeline') {
        await vscode.commands.executeCommand('modelbound.runSkillPipeline', target.skillId);
        panel.webview.postMessage({ type: 'status', message: 'Pipeline started — check the pipeline panel.' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      panel.webview.postMessage({ type: 'status', message, error: true });
      deps.log(`Trust panel action failed: ${message}`);
    }
  });

  if (!initial) {
    refreshPanel().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      panel.webview.postMessage({ type: 'status', message, error: true });
    });
  }

  return panel;
}

export function registerSkillTrustCommands(context: vscode.ExtensionContext, deps: SkillTrustDeps): void {
  const showFindings = vscode.commands.registerCommand(
    'modelbound.showSkillFindings',
    async (argHint?: string) => {
      const target = await resolveTarget(deps, argHint, undefined, 'review trust findings for');
      if (!target) return;
      try {
        const apiKey = deps.getApiKey()!;
        const skillUuid = await deps.ensureSkillSynced(deps.getMcpUrl(), apiKey, deps.workspaceRoot, target, deps.log);
        const payload = await fetchSkillFindings(deps.callMcp, skillUuid);
        await openFindingsPanel(deps, target, skillUuid, payload);
      } catch (err) {
        vscode.window.showErrorMessage(`ModelBound trust findings failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  const ignoreFinding = vscode.commands.registerCommand(
    'modelbound.ignoreSkillFinding',
    async (argHint?: string, findingKey?: string) => {
      const target = await resolveTarget(deps, argHint, undefined, 'ignore a finding on');
      if (!target || !findingKey) return;
      try {
        const apiKey = deps.getApiKey()!;
        const skillUuid = await deps.ensureSkillUuid(deps.getMcpUrl(), apiKey, target, deps.log);
        await callSkillTool(deps.callMcp, 'ignore_skill_finding', { skill_id: skillUuid, finding_key: findingKey });
        vscode.window.showInformationMessage('ModelBound: Finding ignored. Re-run Test & Optimize to refresh the pipeline score.');
      } catch (err) {
        vscode.window.showErrorMessage(`Ignore finding failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  const benchmarkSkill = vscode.commands.registerCommand(
    'modelbound.benchmarkSkill',
    async (argHint?: string) => {
      const target = await resolveTarget(deps, argHint, undefined, 'benchmark');
      if (!target) return;
      try {
        const apiKey = deps.getApiKey()!;
        const skillUuid = await deps.ensureSkillSynced(deps.getMcpUrl(), apiKey, deps.workspaceRoot, target, deps.log);
        vscode.window.setStatusBarMessage(`$(loading~spin) ModelBound: Benchmarking ${target.label}…`, 4000);
        const result = await callSkillTool(deps.callMcp, 'benchmark_skill', { skill_id: skillUuid });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'json' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  const compareVersions = vscode.commands.registerCommand(
    'modelbound.compareSkillVersions',
    async (argHint?: string) => {
      const target = await resolveTarget(deps, argHint, undefined, 'compare versions for');
      if (!target) return;
      const versionA = await vscode.window.showInputBox({ prompt: 'From version (or "latest")', value: 'latest', ignoreFocusOut: true });
      if (!versionA) return;
      const versionB = await vscode.window.showInputBox({ prompt: 'To version (or "current")', value: 'current', ignoreFocusOut: true });
      if (!versionB) return;
      try {
        const apiKey = deps.getApiKey()!;
        const skillUuid = await deps.ensureSkillSynced(deps.getMcpUrl(), apiKey, deps.workspaceRoot, target, deps.log);
        const result = await callSkillTool(deps.callMcp, 'compare_skill_versions', {
          skill_id: skillUuid,
          version_a: versionA,
          version_b: versionB,
        });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'json' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Compare versions failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  const suggestImprovements = vscode.commands.registerCommand(
    'modelbound.suggestSkillImprovements',
    async (argHint?: string) => {
      const target = await resolveTarget(deps, argHint, undefined, 'suggest improvements for');
      if (!target) return;
      try {
        const apiKey = deps.getApiKey()!;
        const skillUuid = await deps.ensureSkillSynced(deps.getMcpUrl(), apiKey, deps.workspaceRoot, target, deps.log);
        vscode.window.setStatusBarMessage(`$(loading~spin) ModelBound: Generating suggestions for ${target.label}…`, 5000);
        const result = await callSkillTool(deps.callMcp, 'suggest_skill_improvements', { skill_id: skillUuid });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Suggest improvements failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  context.subscriptions.push(showFindings, ignoreFinding, benchmarkSkill, compareVersions, suggestImprovements);
}
