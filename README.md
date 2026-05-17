# ModelBound — AI Context, Skills & MCP Sync for Cursor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Keep your AI system prompts, Cursor rules, Claude skills, and knowledge bases in sync between your IDE and [ModelBound.co](https://modelbound.co) — automatically. The ModelBound MCP server gives Cursor, Claude Code, Copilot, and any MCP client live access to your shared context, eval results, and token-health insights. Open source, local-first, zero source code leaves your machine.

---

## Features

* **Bi-directional Sync:** Edit skills and rules natively inside your IDE. On save, a background file watcher pushes changes back to ModelBound cloud instantly.
* **IDE-Aware File Placement:** Automatically writes pulled skills to the correct native location for your IDE — `.kiro/skills/`, `.cursor/rules/`, `.claude/`, and `.modelbound/`.
* **Agentic Tooling via MCP:** The [ModelBound MCP server](https://modelbound.co) exposes 40+ tools to Cursor, Claude Code, Copilot, and any MCP-compatible agent. This extension handles the local filesystem bridge — writing files the MCP server returns and syncing edits back to the cloud.
* **Local Isolation:** Only files inside `.modelbound/` and detected IDE context directories are watched. No application source code, operational logic, or credentials ever leave your machine.

---

## How It Works

```
+--------------------+               +---------------------------+               +---------------------+
|  ModelBound Cloud  | <===========> |  This Extension (Local)   | <===========> |    IDE / Agent      |
|  (Context Hub)     |   Secure API  |  File Watcher + Sync      |   Filesystem  | (Cursor, Kiro, etc) |
+--------------------+               +---------------------------+               +---------------------+
                                                |
                                                v
                                     Writes to all detected IDE directories:
                                     • .modelbound/<skill>.md  (canonical)
                                     • .kiro/skills/<skill>.md (if .kiro/ exists)
                                     • .cursor/rules/<skill>.md (if .cursor/ exists)
                                     • .claude/<skill>.md (if .claude/ exists)
```

**The ModelBound MCP server** runs remotely and handles agent-facing tools (fetching skills, searching context, running evals). Since it can't see your local filesystem, this extension acts as the local bridge — writing files to the right places and syncing edits back.

---

## Supported IDEs

| IDE | Context Directory | Behavior |
|-----|-------------------|----------|
| Kiro | `.kiro/skills/` | Writes here if `.kiro/` exists |
| Cursor | `.cursor/rules/` | Writes here if `.cursor/` exists |
| Claude Code | `.claude/` | Writes here if `.claude/` exists |
| Any | `.modelbound/` | Always writes here (canonical) |

The extension never creates IDE parent directories from scratch — it only writes into them if they already exist in your workspace.

---

## Privacy & Security

This extension is open-sourced so enterprise security teams can audit exactly what data moves off their machines:

1. **Directory Isolation:** The file watcher only targets known context directories. It cannot index outside them.
2. **Exclusion Manifest:** A `.modelboundignore` file prevents accidental tracking of source code or secrets.
3. **No telemetry.** No analytics. Just file sync.

---

## Installation

1. Search **"ModelBound"** in the Cursor/VS Code Extensions panel, or download the `.vsix` from [GitHub Releases](https://github.com/ModelBound/modelbound-cursor-extension/releases).
2. On first activation, you'll be prompted to enter your ModelBound.co API key.
3. Update your key anytime via `Cmd+Shift+P` → **"ModelBound: Set API Key"**.

---

## Commands

| Command | Description |
|---------|-------------|
| `ModelBound: Pull Skill/Context to Local Workspace` | Fetch a skill by ID and write it to all detected IDE locations |
| `ModelBound: Set API Key` | Set or update your ModelBound.co API key |

---

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `modelbound.apiKey` | string | `""` | Your ModelBound.co Secret API Key |
| `modelbound.autoSync` | boolean | `true` | Auto-sync context file changes back to cloud |

---

## Contributing

1. Clone and install:

```bash
git clone https://github.com/ModelBound/modelbound-cursor-extension.git
cd modelbound-cursor-extension
npm install
```

2. Watch for changes:

```bash
npm run watch
```

3. Press `F5` to launch the Extension Development Host for testing.

---

## License

Distributed under the terms of the [MIT License](LICENSE).
