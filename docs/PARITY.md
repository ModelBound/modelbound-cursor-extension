# CLI parity (modelbound vs Cursor extension)

The VS Code / Cursor extension talks to the same REST and MCP surfaces as **[modelbound](https://www.npmjs.com/package/modelbound)** CLI **0.3.6** and the Cursor plugin.

## Covered in the extension (Command Palette)

| CLI area | Extension command |
|----------|-------------------|
| Auth | Sign In / Sign Out / Set API Key |
| Sync | Pull Skill, Sync Current File |
| Pipeline / test / eval | Run Skill Development Pipeline, Run Skill Test, Test & Optimize panel, Create/List Eval Cases |
| Optimize / versions | Optimize, Show Versions, Diff, Restore, Benchmark, Compare |
| Trust & safety | Trust & Safety Findings, Suggest Improvements, Ignore Finding, Configure Pipeline Gates |
| Health | Show Project Health |
| Feedback loop | Report Skill Outcome, Show Skill Reliability |
| Browse / filter | Browse Resource Tree, Filter Skills |

## CLI / plugin-only (use terminal or `/mb-*`)

| Feature | Where |
|---------|--------|
| `mb harness` / `/mb-harness` | Unattended gate in CI — use CLI or plugin; extension ships `presets/harness.json` for pipeline config |
| `mb trace` / `/mb-trace` | Shell wrap or MCP `report_run` in chat; see [TRACING.md](./TRACING.md) |
| Local anti-slop (`init`, `new`, `lint`, `validate`, `trust`) | Cursor plugin slash commands or `mb` in terminal |
| `review`, `detect`, `ls`, `config`, `mcp`, `skills` | CLI |

Harness presets: [HARNESS.md](./HARNESS.md). Install CLI: `npm install -g modelbound@0.3.6`.
