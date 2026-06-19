#!/usr/bin/env node
/**
 * Smoke-test MCP tools used by the Cursor extension.
 * Usage: node scripts/test-mcp-features.mjs
 * Requires MODELBOUND_API_KEY or .env with VSCE_PAT-style key in MODELBOUND_API_KEY / api key in .env
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnv();

const MCP_URL = process.env.MODELBOUND_MCP_URL || 'https://mcp.modelbound.co';
const API_KEY = process.env.MODELBOUND_API_KEY || process.env.MB_API_KEY;
const SKILL_ID = process.env.TEST_SKILL_ID || '08fc2be9-5c1d-4a81-921f-f578bc8c31fa';
const SOURCE_PATH = '.modelbound/prompt-pr-contributor.md';

if (!API_KEY) {
  console.error('Missing API key. Set MODELBOUND_API_KEY or add to .env');
  process.exit(1);
}

const results = [];

async function callTool(name, args = {}) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${raw.slice(0, 400)}`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const line = raw.split('\n').filter((l) => l.startsWith('data:')).pop()?.slice(5).trim();
    parsed = line ? JSON.parse(line) : null;
  }
  if (parsed?.error) throw new Error(`${name}: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  const result = parsed?.result;
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const txt = result.content?.[0]?.text;
  if (typeof txt === 'string') {
    try {
      return JSON.parse(txt);
    } catch {
      return { text: txt };
    }
  }
  return result;
}

async function callHosted(canonical, args) {
  const aliases = {
    run_skill_pipeline: ['skills.runPipeline'],
    get_skill_pipeline_status: ['skills.getPipelineStatus'],
    set_skill_pipeline_config: ['skills.setPipelineConfig'],
    list_skill_findings: ['skills.listFindings'],
    ignore_skill_finding: ['skills.ignoreFinding'],
    benchmark_skill: ['skills.benchmark'],
    compare_skill_versions: ['skills.compareVersions'],
    suggest_skill_improvements: ['skills.suggestImprovements'],
    list_eval_cases: ['evals.listCases'],
    list_eval_results: ['evals.listResults'],
  };
  const names = [canonical, ...(aliases[canonical] ?? [])];
  let lastErr;
  for (const name of names) {
    try {
      return await callTool(name, args);
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    return await callTool('modelbound.callTool', { tool_name: canonical, arguments: args });
  } catch (err) {
    throw lastErr || err;
  }
}

async function test(label, fn) {
  try {
    const out = await fn();
    results.push({ label, status: 'ok', detail: summarize(out) });
    console.log(`✓ ${label}`);
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ label, status: 'fail', detail: msg });
    console.log(`✗ ${label}: ${msg}`);
    return null;
  }
}

function summarize(v) {
  if (v == null) return 'null';
  if (typeof v !== 'object') return String(v).slice(0, 120);
  const keys = Object.keys(v).slice(0, 8);
  return `{${keys.join(',')}}`;
}

const skillBody = fs.readFileSync(path.join(root, SOURCE_PATH), 'utf8');

console.log(`Testing MCP at ${MCP_URL} skill=${SKILL_ID}\n`);

await test('set_workspace_context', () =>
  callTool('set_workspace_context', {
    workspace_path: root,
    repo_full_name: 'ModelBound/modelbound-cursor-extension',
    file_hints: ['.modelbound'],
  }),
);

await test('sync_skill_from_ide', () =>
  callTool('sync_skill_from_ide', {
    repo_url: 'https://github.com/ModelBound/modelbound-cursor-extension',
    branch: 'main',
    source_ide: 'modelbound',
    source_path: SOURCE_PATH,
    body_md: skillBody,
  }),
);

await test('get_skill', () => callTool('get_skill', { skill_id: SKILL_ID, file_id: SKILL_ID }));

await test('get_resource_tree', () => callTool('get_resource_tree', {}));

await test('list_skills', () => callTool('list_skills', { source_platform: 'modelbound' }));

await test('list_skill_findings', () => callHosted('list_skill_findings', { skill_id: SKILL_ID }));

await test('get_skill_pipeline_status', () =>
  callHosted('get_skill_pipeline_status', { skill_id: SKILL_ID, limit: 3 }),
);

await test('set_skill_pipeline_config', () =>
  callHosted('set_skill_pipeline_config', { skill_id: SKILL_ID, min_trust_score: 60 }),
);

await test('benchmark_skill', () =>
  callHosted('benchmark_skill', { skill_id: SKILL_ID, phase: 'pre_optimize' }),
);

await test('compare_skill_versions', () =>
  callHosted('compare_skill_versions', {
    skill_id: SKILL_ID,
    current_skill_md: skillBody,
    version_a: 'latest',
    version_b: 'current',
  }),
);

await test('suggest_skill_improvements', () =>
  callHosted('suggest_skill_improvements', { skill_id: SKILL_ID }),
);

await test('list_eval_cases', () => callHosted('list_eval_cases', {}));

await test('list_eval_results', () => callHosted('list_eval_results', { limit: 5 }));

await test('skill.test (extension alias)', () =>
  callTool('skill.test', { skillId: SKILL_ID, source: 'cursor-extension-test' }),
);

await test('run_skill_test (native)', () =>
  callTool('run_skill_test', { skill_id: SKILL_ID }).catch(() => null),
);

await test('skill.versions', () =>
  callTool('skill.versions', { skillId: SKILL_ID, source: 'cursor-extension-test' }),
);

await test('pipeline.status', () =>
  callTool('pipeline.status', { source: 'cursor-extension-test' }),
);

// Pipeline start — may be long-running; just verify start doesn't error immediately
await test('run_skill_pipeline (test_optimize start)', () =>
  callHosted('run_skill_pipeline', {
    skill_id: SKILL_ID,
    stage: 'test_optimize',
    targets: ['save'],
  }),
);

console.log('\n--- Summary ---');
for (const r of results) {
  console.log(`${r.status === 'ok' ? 'OK' : 'FAIL'}\t${r.label}\t${r.detail}`);
}
const failed = results.filter((r) => r.status === 'fail');
process.exit(failed.length ? 1 : 0);
