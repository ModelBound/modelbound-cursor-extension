# ModelBound — AI Context, Skills & MCP Sync for Cursor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Keep your AI system prompts, Cursor rules, Claude skills, and knowledge bases in sync between your IDE and ModelBound.co — automatically. The built-in MCP server gives Cursor, Claude Code, Copilot, and any MCP client live access to your shared context, eval results, and token-health insights. Open source, local-first, zero source code leaves your machine.

---

## Features

* **Bi-directional Automation:** Edit markdown prompt states or rules natively inside your IDE. On save (`Cmd+S`), a background file-system listener updates your remote cloud configuration instantly.
* **Agentic Tooling via MCP:** Exposes native tools directly to Cursor Composer, Claude Engineers, and local AI agents. The model can fetch, patch, and execute context templates itself on command.
* **Local Isolation Layer:** Keeps all tracking inside a strict local `.modelbound/` boundary. No application source code, operational logic, or credentials ever hit our servers.

---

## Architecture Blueprint

```
+--------------------+               +-------------------------+               +----------------------+
|  ModelBound Cloud  | <===========> | Local MCP Server (Host) | <===========> |     IDE / Agent      |
|  (Context Hub)     |   Secure API  | (File Watcher + Sync)   |  Stdio / SSE  | (Cursor, VSCode etc) |
+--------------------+               +-------------------------+               +----------------------+
                                              |                                          |
                                              v                                          v
                                     +-------------------------+               +----------------------+
                                     |  Local .modelbound/ dir | <============ | Reads Skills & Rules |
                                     +-------------------------+               +----------------------+
```

---

## Privacy & Security Guardrails (Open Source Auditability)

We take code security seriously. This client integration is explicitly open-sourced so that enterprise security teams can easily verify what data moves off their machines:

1. **Directory Isolation:** The file watcher strictly targets `.modelbound/*` extensions. It is structurally blocked from indexing outside directories.
2. **Exclusion Manifest:** A `.modelboundignore` definition is included to prevent the accidental tracking of configurations, proprietary backend files, or system assets.

---

## Local Setup & Onboarding

### Installation

1. Install the extension directly via the Cursor Extension Marketplace or download the verified compiled distribution package (`.vsix`) from our GitHub Releases page.
2. Drop the `.vsix` asset straight into your Extension pane settings panel.

### Sync Configuration

Add your explicit authentication configuration inside your main editor profile preferences (`settings.json`):

```json
{
  "modelbound.apiKey": "mb_live_your_secure_token_here",
  "modelbound.autoSync": true
}
```

---

## Open Source Contribution Workflow

We welcome community pull requests to improve stability, support additional IDE variants, or extend platform capabilities.

### Development Quickstart

1. Fork and pull down the source project target:

```bash
git clone https://github.com/ModelBound/modelbound-cursor-extension.git
cd modelbound-cursor-extension
npm install
```

2. Run continuous execution loops to watch files:

```bash
npm run watch
```

3. Open the directory path inside Cursor or VS Code, click `F5` to spin up the independent **Extension Development Host**, and begin testing changes safely inside an isolated testing instance.

---

## Commands

| Command | Description |
|---------|-------------|
| `ModelBound: Pull Skill/Context to Local Workspace` | Manually fetch a specific skill/context by ID from ModelBound.co |

---

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `modelbound.apiKey` | string | `""` | Your ModelBound.co Secret API Key |
| `modelbound.autoSync` | boolean | `true` | Auto-sync `.modelbound/` changes to cloud |

---

## License

Distributed under the terms of the [MIT License](LICENSE).
