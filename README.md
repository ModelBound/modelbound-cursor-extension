# ModelBound — Cursor Rules Sync, AI Skills Manager & MCP Prompt Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![ModelBound Skill Trust](https://modelbound.co/api/badge/skills.svg?repo=ModelBound/modelbound-cursor-extension)](https://modelbound.co/connect/github-actions)

**The system prompt version control layer for your IDE.** Keep your Cursor rules, Claude Code skills, `.cursorrules`, and AI knowledge bases in sync between your workspace and [ModelBound.co](https://modelbound.co) — automatically. The ModelBound MCP server gives Cursor, Claude Code, Copilot, and any MCP client live access to your shared prompts, eval results, and token-health insights.

Open source. Local-first. Zero source code leaves your machine.

---

## Why ModelBound?

If you've ever dealt with:
- `.cursorrules` files drifting out of sync across repos
- Manually copying system prompts between Cursor, Claude, and Copilot
- No version history for your AI rules and context
- Wanting an MCP prompt server that actually works with your IDE
- No CI/CD pipeline for testing and validating prompt changes
- Rebuilding your entire prompt library when switching AI tools

This extension solves all of it.

---

## One Library, Every AI Tool

Your prompts, rules, and skills shouldn't be locked into a single IDE or agent. ModelBound acts as the shared layer underneath — write a skill once, and it's available everywhere you work:

- Switch from Cursor to Claude Code mid-project? Your context follows you.
- Try a new AI tool next month? Your entire prompt library is already there.
- Run Copilot at work and Cursor at home? Same skills, same quality, no re-work.

Stop rebuilding context from scratch every time you change tools. ModelBound makes your investment in prompt engineering portable — so you get full value from every AI subscription you're paying for, regardless of which editor or agent you're using today.

---

## Getting Started

### 1. Install

Search **"ModelBound"** in the Cursor/VS Code Extensions panel, or download the `.vsix` from [GitHub Releases](https://github.com/ModelBound/modelbound-cursor-extension/releases).

### 2. Sign In

On first activation, you'll be prompted to authenticate. Two options:

- **Sign In with Browser (recommended):** Opens your browser for a one-click OAuth sign-in. No tokens to copy — the extension handles everything automatically via the Device Authorization Grant flow.
- **Paste API Key:** For users who prefer manual setup or CI environments. Grab your key from [modelbound.co/settings](https://modelbound.co/settings) and paste it when prompted.

You can also sign in later via `Cmd+Shift+P` → **"ModelBound: Sign In with Browser"**.

### 3. Start Editing

That's it. Save any file in a watched context directory and it syncs to ModelBound cloud automatically. Pull skills from your team's shared library with `Cmd+Shift+P` → **"ModelBound: Pull Skill/Context to Local Workspace"**.

---

## Features

* **One-Click OAuth Sign-In:** Browser-based authentication — no manual token management. The extension opens your browser, you approve, and you're connected.
* **Cursor Rules Sync:** Edit `.cursor/rules/` files natively. On save, changes push to ModelBound cloud and stay versioned.
* **`.cursorrules` Manager:** Pull shared rules from your team's ModelBound workspace directly into your local Cursor config.
* **Claude Code Skills Sync:** Same bi-directional sync for `.claude/` — your Claude skills stay current across machines.
* **System Prompt Version Control:** Every edit is tracked. Roll back, branch, or share prompts across your team from the ModelBound dashboard.
* **Skill Development Pipeline:** Run test, optimize, and production stages against your skills directly from the IDE. Visual status panel shows pass/fail results in real time.
* **MCP Prompt Server:** The [ModelBound MCP server](https://modelbound.co) exposes 40+ tools to any MCP-compatible agent. This extension handles the local filesystem bridge — writing files and syncing edits back to the cloud.
* **IDE-Aware File Placement:** Automatically writes pulled skills to the correct native location for your IDE — `.kiro/skills/`, `.cursor/rules/`, `.claude/`, and `.modelbound/`.
* **Git-Aware Sync:** Detects your repo URL and branch, associating synced skills with the correct project context server-side.
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
                                     Watches & syncs these directories:
                                     • .modelbound/**/*.{md,json}
                                     • .kiro/skills/**/*.md
                                     • .cursor/rules/**/*.md
                                     • .claude/**/*.md
                                     • .agents/skills/**/SKILL.md
```

**The ModelBound MCP server** runs remotely and handles agent-facing tools (fetching skills, searching context, running evals). Since it can't see your local filesystem, this extension acts as the local bridge — writing files to the right places and syncing edits back.

---

## Supported IDEs & Tools

| IDE / Tool | Context Directory | What Syncs |
|------------|-------------------|------------|
| Cursor | `.cursor/rules/` | Cursor rules, .cursorrules |
| Kiro | `.kiro/skills/` | Skills and steering files |
| Claude Code | `.claude/` | Claude skills and context |
| Agents | `.agents/skills/` | SKILL.md files |
| Copilot | `.github/` | Copilot instructions (coming soon) |
| Any MCP client | `.modelbound/` | All skills (canonical) |

The extension never creates IDE parent directories from scratch — it only writes into them if they already exist in your workspace.

---

## Commands

| Command | Description |
|---------|-------------|
| `ModelBound: Sign In with Browser` | OAuth sign-in — opens browser, no token copy needed |
| `ModelBound: Sign Out` | Clear stored credentials |
| `ModelBound: Pull Skill/Context to Local Workspace` | Fetch a skill by ID and write to all detected IDE locations |
| `ModelBound: Set API Key (Manual)` | Manually set or update your API key |
| `ModelBound: Run Skill Development Pipeline` | Run test/optimize/production pipeline against a skill |

---

## Skill Development Pipeline

Run CI/CD-style validation on your AI skills without leaving the IDE:

1. `Cmd+Shift+P` → **"ModelBound: Run Skill Development Pipeline"**
2. Select a stage: Full pipeline, Test & Optimize only, or Production only
3. Choose production targets: Save, Publish to Marketplace, Export to Claude
4. A live status panel opens showing pass/fail results for each stage

The pipeline runs server-side via the ModelBound MCP server and reports results back in real time.

---

## Use Cases

- **Team prompt libraries:** Share system prompts and Cursor rules across your org. Everyone pulls from the same source of truth.
- **Multi-IDE workflows:** Use Cursor and Claude Code on the same project? Edits in either sync back to ModelBound and propagate to both.
- **Tool-agnostic prompt investment:** Build your skills once in ModelBound and use them across every AI tool you subscribe to — no vendor lock-in, no re-work when you switch.
- **Prompt version control:** Track changes to your AI rules over time. See who changed what and roll back if needed.
- **Skill CI/CD:** Validate prompt changes before publishing — run test gates, optimization passes, and production deploys from the command palette.
- **MCP-native agents:** Let your AI agent fetch and scaffold context directly via the ModelBound MCP server — no manual file management.

---

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `modelbound.apiKey` | string | `""` | Your ModelBound.co API Key (set automatically via sign-in) |
| `modelbound.autoSync` | boolean | `true` | Auto-sync context file changes back to cloud |
| `modelbound.mcpUrl` | string | `https://mcp.modelbound.co` | MCP Streamable HTTP endpoint |
| `modelbound.authUrl` | string | `https://modelbound.co/api/extension-device-auth` | Device auth endpoint (advanced) |

---

## Privacy & Security

This extension is open-sourced so enterprise security teams can audit exactly what data moves off their machines:

1. **Directory Isolation:** The file watcher only targets known context directories listed above. It cannot index outside them.
2. **Exclusion Manifest:** A `.modelboundignore` file prevents accidental tracking of source code or secrets.
3. **No telemetry.** No analytics. Just file sync.
4. **OAuth tokens stay local:** API keys are stored in your VS Code/Cursor settings — never transmitted anywhere except the ModelBound API.

---

## Related projects

| Project | Description |
| --- | --- |
| [ModelBound CLI](https://github.com/ModelBound/modelbound-cli) · [npm](https://www.npmjs.com/package/modelbound) | Terminal + CI for token optimization, skill pipeline, and version management |
| [ModelBound MCP Server](https://github.com/ModelBound/modelbound-mcp-server) · [npm](https://www.npmjs.com/package/modelbound-mcp) | Local-first MCP server for skill lint, convert, and cloud sync |
| [Cursor Plugin](https://github.com/ModelBound/cursor-plugin) | Cursor slash commands for pipeline, trust & safety, and versions |
| [Claude Code Plugin](https://github.com/ModelBound/modelbound-claude-code-plugin) | Claude Code plugin for pipeline, hooks, and skill sync |
| [Dev Packs](https://github.com/ModelBound/dev-packs) | Open-source curated AI context packs for engineering teams |

Also on [Open VSX](https://open-vsx.org/extension/ModelBound/modelbound-cursor-extension). Install hub: [modelbound.co/connect](https://modelbound.co/connect)

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
