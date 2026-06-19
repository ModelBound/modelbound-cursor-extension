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

export type TestOptimizeDeps = {
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

const TOOL_ALIASES: Record<string, string[]> = {
  run_skill_pipeline: ['skills.runPipeline'],
  get_skill_pipeline_status: ['skills.getPipelineStatus'],
  set_skill_pipeline_config: ['skills.setPipelineConfig'],
  list_skill_findings: ['skills.listFindings'],
  ignore_skill_finding: ['skills.ignoreFinding'],
  unignore_skill_finding: ['skills.unignoreFinding'],
  benchmark_skill: ['skills.benchmark'],
  compare_skill_versions: ['skills.compareVersions'],
  suggest_skill_improvements: ['skills.suggestImprovements'],
  create_eval_case: ['evals.createCase'],
  list_eval_cases: ['evals.listCases'],
  run_eval: ['evals.run'],
  list_eval_results: ['evals.listResults'],
};

const TERMINAL_PIPELINE = new Set(['passed', 'failed', 'completed', 'errored', 'skipped']);

export async function callHostedTool(
  callMcp: McpCaller,
  canonical: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let lastErr: unknown;
  for (const name of [canonical, ...(TOOL_ALIASES[canonical] ?? [])]) {
    try {
      return await callMcp(name, args);
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    return await callMcp('modelbound.callTool', { tool_name: canonical, arguments: args });
  } catch {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

export async function fetchSkillFindings(callMcp: McpCaller, skillId: string): Promise<SkillFindingsPayload> {
  const raw = await callHostedTool(callMcp, 'list_skill_findings', { skill_id: skillId });
  if (!raw || typeof raw !== 'object') throw new Error('Unexpected findings response from ModelBound.');
  return raw as SkillFindingsPayload;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatJson(value: unknown): string {
  return escapeHtml(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function renderFindingsRows(findings: SkillFinding[]): string {
  if (!findings.length) return '<div class="meta">No findings — trust scan is clean.</div>';
  return findings
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
    .join('');
}

function renderPipelineStages(stageResults: Record<string, unknown> | undefined): string {
  if (!stageResults) return '<div class="meta">No stage data yet.</div>';
  const labels: Record<string, string> = { edit: 'Edit', test: 'Test & Optimize', production: 'Production' };
  return Object.entries(stageResults)
    .map(([key, val]) => {
      const s = (val ?? {}) as { status?: string; summary?: string };
      const status = s.status || 'idle';
      const cls =
        status === 'passed' ? 'b-pass' : status === 'failed' ? 'b-fail' : status === 'running' ? 'b-run' : 'b-idle';
      return `<div class="row"><span class="badge ${cls}">${escapeHtml(status)}</span><strong>${labels[key] ?? key}</strong><span class="meta">${escapeHtml(s.summary || '')}</span></div>`;
    })
    .join('');
}

function panelHtml(
  label: string,
  state: {
    findings?: SkillFindingsPayload;
    pipelineRuns?: Array<Record<string, unknown>>;
    benchmark?: unknown;
    compare?: unknown;
    suggest?: unknown;
    evalCases?: unknown;
    evalResults?: unknown;
  },
): string {
  const scores = state.findings?.scores ?? {};
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

  const latestRun = state.pipelineRuns?.[0];
  const runMeta = latestRun
    ? `Run ${String(latestRun.id ?? '').slice(0, 8)} · v${latestRun.version_after ?? latestRun.version_before ?? '—'} · ${latestRun.status ?? 'unknown'}`
    : 'No pipeline runs yet';

  const history =
    (state.pipelineRuns ?? []).length > 1
      ? (state.pipelineRuns ?? [])
          .slice(0, 5)
          .map(
            (r) =>
              `<div class="meta">${String(r.id ?? '').slice(0, 8)} · ${r.status ?? '?'} · ${r.created_at ?? ''}</div>`,
          )
          .join('')
      : '';

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 14px; color: var(--vscode-foreground); margin: 0; }
  h2 { margin: 0 0 4px; font-size: 14px; }
  h3 { margin: 16px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px; }
  .scores { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
  .score { background: var(--vscode-textCodeBlock-background); border-radius: 6px; padding: 8px; text-align: center; }
  .score-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
  .score-val { font-size: 18px; font-weight: 600; margin-top: 2px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .finding, .row { border-top: 1px solid var(--vscode-panel-border); padding: 8px 0; }
  .finding.ignored .message { text-decoration: line-through; opacity: 0.7; }
  .finding-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; }
  .badge { padding: 1px 6px; border-radius: 4px; font-size: 10px; text-transform: uppercase; }
  .sev-critical, .b-fail { background: rgba(248, 81, 73, 0.18); color: #f85149; }
  .sev-warn { background: rgba(210, 153, 34, 0.18); color: #d29922; }
  .sev-info { background: rgba(56, 139, 253, 0.18); color: #58a6ff; }
  .b-pass { background: rgba(46, 160, 67, 0.18); color: #3fb950; }
  .b-run { background: rgba(56, 139, 253, 0.18); color: #58a6ff; }
  .b-idle { background: rgba(139, 148, 158, 0.18); color: #8b949e; }
  .class { font-weight: 600; }
  .source, .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .ignored-tag { margin-left: auto; font-style: italic; }
  .message { font-size: 12px; line-height: 1.45; margin-bottom: 6px; }
  pre.box { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto; white-space: pre-wrap; }
  #status { min-height: 16px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  #status.error { color: #f85149; }
</style>
</head>
<body>
<h2>Test &amp; Optimize</h2>
<div class="sub">Skill: <code>${escapeHtml(label)}</code></div>
<div class="scores">${scoreCards}</div>
<div class="toolbar">
  <button class="btn btn-secondary" data-act="refresh">Refresh all</button>
  <button class="btn" data-act="pipeline">Run Test &amp; Optimize</button>
  <button class="btn btn-secondary" data-act="pipeline-config">Gate settings</button>
</div>

<h3>Pipeline</h3>
<div class="meta">${escapeHtml(runMeta)}</div>
<div id="pipeline-stages">${renderPipelineStages(latestRun?.stage_results as Record<string, unknown> | undefined)}</div>
${history ? `<div style="margin-top:8px">${history}</div>` : ''}

<h3>Trust &amp; Safety</h3>
<div id="findings">${renderFindingsRows(state.findings?.findings ?? [])}</div>
<div class="toolbar">
  <button class="btn btn-secondary" data-act="benchmark">Benchmark latency</button>
  <button class="btn btn-secondary" data-act="compare">Compare with previous version</button>
  <button class="btn btn-secondary" data-act="suggest">Suggest improvements</button>
</div>

<h3>Benchmark</h3>
<pre class="box" id="benchmark">${state.benchmark ? formatJson(state.benchmark) : 'Run benchmark to see median/p95 latency.'}</pre>

<h3>Version comparison</h3>
<pre class="box" id="compare">${state.compare ? formatJson(state.compare) : 'Compare versions to see adherence and latency deltas.'}</pre>

<h3>AI suggestions</h3>
<pre class="box" id="suggest">${state.suggest ? formatJson(state.suggest) : 'Request suggestions for clarity, safety, and fit improvements.'}</pre>

<h3>Eval test cases</h3>
<div class="toolbar">
  <button class="btn btn-secondary" data-act="eval-list">Refresh cases</button>
  <button class="btn btn-secondary" data-act="eval-create">New test case</button>
</div>
<pre class="box" id="eval-cases">${state.evalCases ? formatJson(state.evalCases) : 'No eval cases loaded.'}</pre>
<pre class="box" id="eval-results">${state.evalResults ? formatJson(state.evalResults) : ''}</pre>

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
    if (data.type === 'html' && data.section && data.html) {
      const el = document.getElementById(data.section);
      if (el) el.innerHTML = data.html;
      document.querySelectorAll('.btn').forEach((b) => { b.disabled = false; });
      setStatus('');
    }
    if (data.type === 'patch' && data.patches) {
      for (const [id, html] of Object.entries(data.patches)) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
      }
      document.querySelectorAll('.btn').forEach((b) => { b.disabled = false; });
    }
  });
</script>
</body>
</html>`;
}

async function resolveTarget(
  deps: TestOptimizeDeps,
  argHint?: string,
  preferUri?: vscode.Uri,
  purpose?: string,
): Promise<SkillTarget | undefined> {
  if (!deps.getApiKey()) {
    vscode.window.showWarningMessage('ModelBound: Set your API key first (ModelBound: Set API Key).');
    return undefined;
  }
  return deps.pickSkillTarget(deps.workspaceRoot, {
    hint: typeof argHint === 'string' ? argHint : undefined,
    preferUri,
    purpose,
  });
}

async function runPipelineWithCrossRepo(
  deps: TestOptimizeDeps,
  skillUuid: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await callHostedTool(deps.callMcp, 'run_skill_pipeline', args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('cross_repo_skill_blocked')) throw err;
    const ok = await vscode.window.showWarningMessage(
      msg,
      { modal: true },
      'Run anyway',
      'Cancel',
    );
    if (ok !== 'Run anyway') throw err;
    return callHostedTool(deps.callMcp, 'run_skill_pipeline', { ...args, cross_repo: true });
  }
}

async function pollPipeline(
  deps: TestOptimizeDeps,
  skillUuid: string,
  panel: vscode.WebviewPanel,
  onRun?: (run: Record<string, unknown>) => void,
): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const status = await callHostedTool(deps.callMcp, 'get_skill_pipeline_status', {
      skill_id: skillUuid,
      limit: 5,
    });
    const runs = ((status as { runs?: Array<Record<string, unknown>> })?.runs ?? []) as Array<
      Record<string, unknown>
    >;
    if (runs[0]) onRun?.(runs[0]);
    panel.webview.postMessage({
      type: 'patch',
      patches: {
        'pipeline-stages': renderPipelineStages(runs[0]?.stage_results as Record<string, unknown> | undefined),
      },
    });
    const st = String(runs[0]?.status ?? '');
    if (st && TERMINAL_PIPELINE.has(st)) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function openTestOptimizePanel(
  deps: TestOptimizeDeps,
  target: SkillTarget,
  skillUuid: string,
  initial?: Partial<{
    findings: SkillFindingsPayload;
    pipelineRuns: Array<Record<string, unknown>>;
  }>,
): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    'modelboundTestOptimize',
    `ModelBound Test & Optimize · ${target.label}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  let panelState: Parameters<typeof panelHtml>[1] = {
    findings: initial?.findings,
    pipelineRuns: initial?.pipelineRuns,
  };

  const render = () => {
    panel.webview.html = panelHtml(target.label, panelState);
  };

  const refreshAll = async (statusMessage?: string) => {
    const [findings, pipeline] = await Promise.all([
      fetchSkillFindings(deps.callMcp, skillUuid),
      callHostedTool(deps.callMcp, 'get_skill_pipeline_status', { skill_id: skillUuid, limit: 5 }),
    ]);
    panelState.findings = findings;
    panelState.pipelineRuns = (pipeline as { runs?: Array<Record<string, unknown>> })?.runs ?? [];
    render();
    if (statusMessage) panel.webview.postMessage({ type: 'status', message: statusMessage });
  };

  render();

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.type === 'refresh') {
        await refreshAll();
        return;
      }

      if (msg.type === 'ignore' && msg.finding_key) {
        await callHostedTool(deps.callMcp, 'ignore_skill_finding', {
          skill_id: skillUuid,
          finding_key: msg.finding_key,
        });
        vscode.window.showInformationMessage(
          'ModelBound: Finding ignored. Re-run the pipeline to update the trust score.',
        );
        panelState.findings = await fetchSkillFindings(deps.callMcp, skillUuid);
        panel.webview.postMessage({
          type: 'html',
          section: 'findings',
          html: renderFindingsRows(panelState.findings?.findings ?? []),
        });
        return;
      }

      if (msg.type === 'unignore' && msg.finding_key) {
        await callHostedTool(deps.callMcp, 'unignore_skill_finding', {
          skill_id: skillUuid,
          finding_key: msg.finding_key,
        });
        panelState.findings = await fetchSkillFindings(deps.callMcp, skillUuid);
        panel.webview.postMessage({
          type: 'html',
          section: 'findings',
          html: renderFindingsRows(panelState.findings?.findings ?? []),
        });
        return;
      }

      if (msg.type === 'pipeline') {
        vscode.window.setStatusBarMessage(`$(rocket) ModelBound: Pipeline starting…`, 4000);
        await runPipelineWithCrossRepo(deps, skillUuid, {
          skill_id: skillUuid,
          stage: 'test_optimize',
          targets: ['save'],
        });
        await pollPipeline(deps, skillUuid, panel, (run) => {
          panelState.pipelineRuns = [run, ...(panelState.pipelineRuns ?? []).filter((r) => r.id !== run.id)];
        });
        await refreshAll('Pipeline finished.');
        return;
      }

      if (msg.type === 'pipeline-config') {
        await vscode.commands.executeCommand('modelbound.setPipelineConfig', target.skillId);
        panel.webview.postMessage({ type: 'status', message: 'Pipeline gate settings updated.' });
        return;
      }

      if (msg.type === 'benchmark') {
        panelState.benchmark = await callHostedTool(deps.callMcp, 'benchmark_skill', {
          skill_id: skillUuid,
          phase: 'pre_optimize',
        });
        panel.webview.postMessage({
          type: 'patch',
          patches: { benchmark: `<pre class="box">${formatJson(panelState.benchmark)}</pre>` },
        });
        return;
      }

      if (msg.type === 'compare') {
        let currentMd: string | undefined;
        if (target.filePath) {
          const fs = await import('fs');
          currentMd = fs.readFileSync(target.filePath, 'utf8');
        }
        panelState.compare = await callHostedTool(deps.callMcp, 'compare_skill_versions', {
          skill_id: skillUuid,
          current_skill_md: currentMd,
          version_a: 'latest',
          version_b: 'current',
        });
        panel.webview.postMessage({
          type: 'patch',
          patches: { compare: `<pre class="box">${formatJson(panelState.compare)}</pre>` },
        });
        return;
      }

      if (msg.type === 'suggest') {
        panelState.suggest = await callHostedTool(deps.callMcp, 'suggest_skill_improvements', {
          skill_id: skillUuid,
        });
        panel.webview.postMessage({
          type: 'patch',
          patches: { suggest: `<pre class="box">${formatJson(panelState.suggest)}</pre>` },
        });
        return;
      }

      if (msg.type === 'eval-list') {
        panelState.evalCases = await callHostedTool(deps.callMcp, 'list_eval_cases', {});
        panelState.evalResults = await callHostedTool(deps.callMcp, 'list_eval_results', { limit: 20 });
        render();
        return;
      }

      if (msg.type === 'eval-create') {
        await vscode.commands.executeCommand('modelbound.createEvalCase');
        panelState.evalCases = await callHostedTool(deps.callMcp, 'list_eval_cases', {});
        render();
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      panel.webview.postMessage({ type: 'status', message, error: true });
      deps.log(`Test & Optimize panel error: ${message}`);
    } finally {
      panel.webview.postMessage({ type: 'status', message: '' });
    }
  });

  refreshAll().catch((err) => {
    panel.webview.postMessage({
      type: 'status',
      message: err instanceof Error ? err.message : String(err),
      error: true,
    });
  });

  return panel;
}

export function registerTestOptimizeCommands(context: vscode.ExtensionContext, deps: TestOptimizeDeps): void {
  const openPanel = vscode.commands.registerCommand('modelbound.openTestOptimize', async (argHint?: string) => {
    const target = await resolveTarget(deps, argHint, undefined, 'open Test & Optimize for');
    if (!target) return;
    try {
      const apiKey = deps.getApiKey()!;
      const skillUuid = await deps.ensureSkillSynced(deps.getMcpUrl(), apiKey, deps.workspaceRoot, target, deps.log);
      await openTestOptimizePanel(deps, target, skillUuid);
    } catch (err) {
      vscode.window.showErrorMessage(
        `ModelBound Test & Optimize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const showFindings = vscode.commands.registerCommand('modelbound.showSkillFindings', async (argHint?: string) => {
    await vscode.commands.executeCommand('modelbound.openTestOptimize', argHint);
  });

  const setPipelineConfig = vscode.commands.registerCommand(
    'modelbound.setPipelineConfig',
    async (argHint?: string) => {
      const target = await resolveTarget(deps, argHint, undefined, 'configure pipeline gates for');
      if (!target) return;
      const apiKey = deps.getApiKey()!;
      const skillUuid = await deps.ensureSkillSynced(deps.getMcpUrl(), apiKey, deps.workspaceRoot, target, deps.log);
      const minTrust = await vscode.window.showInputBox({
        prompt: 'Minimum trust score (0–100, blank = unchanged)',
        value: '60',
      });
      const enforceTrust = await vscode.window.showQuickPick(['Enforce trust gate', 'Do not enforce trust gate'], {
        placeHolder: 'Trust gate',
      });
      const args: Record<string, unknown> = { skill_id: skillUuid };
      if (minTrust?.trim()) args.min_trust_score = Number(minTrust);
      if (enforceTrust?.startsWith('Enforce')) args.enforce_trust_gate = true;
      if (enforceTrust?.startsWith('Do not')) args.enforce_trust_gate = false;
      await callHostedTool(deps.callMcp, 'set_skill_pipeline_config', args);
      vscode.window.showInformationMessage('ModelBound: Pipeline gate configuration saved.');
    },
  );

  const ignoreFinding = vscode.commands.registerCommand(
    'modelbound.ignoreSkillFinding',
    async (argHint?: string, findingKey?: string) => {
      const target = await resolveTarget(deps, argHint, undefined, 'ignore a finding on');
      if (!target || !findingKey) return;
      const apiKey = deps.getApiKey()!;
      const skillUuid = await deps.ensureSkillUuid(deps.getMcpUrl(), apiKey, target, deps.log);
      await callHostedTool(deps.callMcp, 'ignore_skill_finding', { skill_id: skillUuid, finding_key: findingKey });
      vscode.window.showInformationMessage('ModelBound: Finding ignored. Re-run the pipeline to update the trust score.');
    },
  );

  const benchmarkSkill = vscode.commands.registerCommand('modelbound.benchmarkSkill', async (argHint?: string) => {
    await vscode.commands.executeCommand('modelbound.openTestOptimize', argHint);
  });

  const compareVersions = vscode.commands.registerCommand(
    'modelbound.compareSkillVersions',
    async (argHint?: string) => {
      await vscode.commands.executeCommand('modelbound.openTestOptimize', argHint);
    },
  );

  const suggestImprovements = vscode.commands.registerCommand(
    'modelbound.suggestSkillImprovements',
    async (argHint?: string) => {
      await vscode.commands.executeCommand('modelbound.openTestOptimize', argHint);
    },
  );

  const createEvalCase = vscode.commands.registerCommand('modelbound.createEvalCase', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Eval case name', ignoreFocusOut: true });
    if (!name) return;
    const prompt = await vscode.window.showInputBox({ prompt: 'Input prompt for the skill', ignoreFocusOut: true });
    if (!prompt) return;
    const expected = await vscode.window.showInputBox({ prompt: 'Expected output (optional)', ignoreFocusOut: true });
    await callHostedTool(deps.callMcp, 'create_eval_case', {
      name,
      input_prompt: prompt,
      expected_output: expected || undefined,
    });
    vscode.window.showInformationMessage(`ModelBound: Eval case "${name}" created.`);
  });

  const listEvalCases = vscode.commands.registerCommand('modelbound.listEvalCases', async () => {
    const r = await callHostedTool(deps.callMcp, 'list_eval_cases', {});
    const doc = await vscode.workspace.openTextDocument({
      content: JSON.stringify(r, null, 2),
      language: 'json',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  context.subscriptions.push(
    openPanel,
    showFindings,
    setPipelineConfig,
    ignoreFinding,
    benchmarkSkill,
    compareVersions,
    suggestImprovements,
    createEvalCase,
    listEvalCases,
  );
}

/** @deprecated use registerTestOptimizeCommands */
export const registerSkillTrustCommands = registerTestOptimizeCommands;
