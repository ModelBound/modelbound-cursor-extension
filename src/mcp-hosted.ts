export type McpCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Native tool names with optional dotted aliases used by older MCP wrappers. */
export const TOOL_ALIASES: Record<string, string[]> = {
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
  list_eval_results: ['evals.listResults'],
  run_skill_test: ['skill.test', 'skills.test'],
  delete_skill_from_ide: ['skills.deleteFromIde'],
  resolve_skill_conflict: ['skills.resolveConflict'],
  sync_skill_from_ide: ['skills.syncFromIde'],
  get_context_health: ['pipeline.status'],
  optimize_content: ['skills.optimize'],
};

/**
 * Invoke a ModelBound native tool with fallbacks for legacy aliases and dispatchers.
 * Tries direct native name first (full MCP endpoint), then aliases, then wrappers.
 */
export async function callHostedTool(
  callMcp: McpCaller,
  canonical: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let lastErr: unknown;
  const names = [canonical, ...(TOOL_ALIASES[canonical] ?? [])];
  for (const name of names) {
    try {
      return await callMcp(name, args);
    } catch (err) {
      lastErr = err;
    }
  }
  for (const wrapper of ['modelbound.callTool', 'call_modelbound_tool'] as const) {
    try {
      return await callMcp(wrapper, { tool_name: canonical, arguments: args });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
