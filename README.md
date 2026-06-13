# ModelBound — Cursor & VS Code extension

Inline token optimization, Skill Development Pipeline, versions, restore, diff, and benchmark for agent-skill files. Works in Cursor and VS Code.

## Features

- **Command palette**: `ModelBound: Optimize`, `Pipeline`, `Test`, `Benchmark`, `Versions`, `Restore`, `Diff`, `Health`, `Login`.
- **Status bar**: live token count + trust score for the active skill file, click to open the pipeline.
- **CodeLens**: above every skill file, one-click `Optimize · Pipeline · Versions`.
- **Versions webview**: side-by-side list with diff, restore, and benchmark buttons.
- **60-second undo toast**: after every Optimize / Restore, an undo button reverts the new version (non-destructive — appends another version on top).

All operations route through your authenticated session — the same surface as `@modelbound/cli`, the MCP server, and the Claude Code plugin.

## Install

- **Cursor / VS Code**: search "ModelBound" in Extensions, or sideload the `.vsix` from [Releases](https://github.com/ModelBound/modelbound-cursor-extension/releases).
- **First run**: `ModelBound: Login` (device-code flow) or set `MODELBOUND_API_KEY` in your shell.

## Settings

| Setting | Default | Description |
|---|---|---|
| `modelbound.apiUrl` | `https://modelbound.co` | API base URL. |
| `modelbound.skillGlobs` | skills/**, .cursor/skills/**, .agents/skills/**, SKILL.md | Patterns that count as skill files. |
| `modelbound.showCodeLens` | `true` | Show CodeLens on skill files. |
| `modelbound.undoToastSeconds` | `60` | Undo toast duration. |

## License

MIT
