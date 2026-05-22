# ModelBound — Cursor Rules Sync, AI Skills Manager & MCP Prompt Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**The system prompt version control layer for your IDE.** Keep your Cursor rules, Claude Code skills, `.cursorrules`, and AI knowledge bases in sync between your workspace and [ModelBound.co](https://modelbound.co) — automatically. The ModelBound MCP server gives Cursor, Claude Code, Copilot, and any MCP client live access to your shared prompts, eval results, and token-health insights.

Open source. Local-first. Zero source code leaves your machine.

---

## Why ModelBound?

If you've ever dealt with:
- `.cursorrules` files drifting out of sync across repos
- Manually copying system prompts between Cursor, Claude, and Copilot
- No version history for your AI rules and context
- Wanting an MCP prompt server that actually works with your IDE

This extension solves all of it.

---

## Features

* **Cursor Rules Sync:** Edit `.cursor/rules/` files natively. On save, changes push to ModelBound cloud and stay versioned.
* **`.cursorrules` Manager:** Pull shared rules from your team's ModelBound workspace directly into your local Cursor config.
* **Claude Code Skills Sync:** Same bi-directional sync for `.claude/` — your Claude skills stay current across machines.
* **System Prompt Version Control:** Every edit is tracked. Roll back, branch, or share prompts across your team from the ModelBound dashboard.
* **MCP Prompt Server:** The [ModelBound MCP server](https://modelbound.co) exposes 40+ tools to any MCP-compatible agent. This extension handles the local filesystem bridge — writing files and syncing edits back to the cloud.
* **IDE-Aware File Placement:** Automatically writes pulled skills to the correct native location for your IDE — `.kiro/skills/`, `.cursor/rules/`, `.claude/`, and `.modelbound/`.
* **Local Isolation:** Only context directories are watched. No application source code, credentials, or telemetry ever leave your machine.

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

## Supported IDEs & Tools

| IDE / Tool | Context Directory | What Syncs |
|------------|-------------------|------------|
| Cursor | `.cursor/rules/` | Cursor rules, .cursorrules |
| Kiro | `.kiro/skills/` | Skills and steering files |
| Claude Code | `.claude/` | Claude skills and context |
| Copilot | `.github/` | Copilot instructions (coming soon) |
| Any MCP client | `.modelbound/` | All skills (canonical) |

The extension never creates IDE parent directories from scratch — it only writes into them if they already exist in your workspace.

---

## Use Cases

- **Team prompt libraries:** Share system prompts and Cursor rules across your org. Everyone pulls from the same source of truth.
- **Multi-IDE workflows:** Use Cursor and Claude Code on the same project? Edits in either sync back to ModelBound and propagate to both.
- **Prompt version control:** Track changes to your AI rules over time. See who changed what and roll back if needed.
- **MCP-native agents:** Let your AI agent fetch and scaffold context directly via the ModelBound MCP server — no manual file management.

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
