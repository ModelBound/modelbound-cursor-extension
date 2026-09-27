/** Shared with CLI, MCP, plugins — keep in sync with modelbound package. */
export const VERDICTS = ["worked", "partial", "failed"] as const;
export type Verdict = (typeof VERDICTS)[number];
