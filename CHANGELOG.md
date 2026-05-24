# Changelog

All notable changes to the "ModelBound Context Sync & MCP Server" extension will be documented in this file.

## [1.5.0] - 2026-05-24

### Added
- **Run Skill Development Pipeline** — new command `ModelBound: Run Skill Development Pipeline` (palette / `modelbound.runSkillPipeline`) triggers the CI/CD-style pipeline (Test & Optimize → Production) for the active skill. Auto-detects the skill from `.agents/skills/<slug>/SKILL.md`, `.modelbound/<id>.md`, `.kiro/skills/<id>.md`, `.cursor/rules/<id>.md`, and `.claude/<id>.md`; falls back to a prompt if no skill file is open.
- **Live status webview** — opens beside the editor and polls `get_skill_pipeline_status` every 2s, rendering per-stage status (idle / running / passed / failed) for Test & Optimize and Production, with the underlying `stage_results` JSON for debugging.
- **Stage and target picker** — choose Full / Test & Optimize / Production-only, and multi-select production targets (Save, Marketplace, Claude Export) before the run starts.
- **`.agents/skills/**/SKILL.md`** added to the watcher globs so Anthropic-style agent skills sync to ModelBound on save alongside the existing `.modelbound`, `.kiro`, `.cursor`, and `.claude` locations.

### Changed
- `callMcpTool` now parses both `application/json` and `text/event-stream` MCP responses and returns the JSON-RPC `structuredContent` (or the parsed `text` block) so command handlers can act on tool output. Existing `sync_skill_from_ide` / `delete_skill_from_ide` calls keep their fire-and-forget behavior because they ignore the return value.

## [1.4.0] - 2026-05-23

### Fixed
- **Repo detection is now robust and per-sync.** Previously `repo_url` was probed once at activation with `git config --get remote.origin.url` and any failure silently fell through to "no repo association" for the whole session. Skills synced from valid repos could end up unlinked on ModelBound.
- Resolves the git toplevel with `git -C <root> rev-parse --show-toplevel` so workspaces opened at a subfolder of the repo work correctly.
- Falls back to the first available remote when `origin` doesn't exist (covers forks named `upstream`, multi-remote setups, etc.).
- Re-detects repo info on **every** sync/delete call — repos initialized after activation are picked up without restarting the IDE.
- Adds a "ModelBound" output channel that logs activation state, each sync, and the underlying git error when remote detection fails — makes future "why isn't my skill linked?" issues debuggable in seconds.

## [1.3.0] - 2026-05-22

### Added
- **Sync on create and delete** — previously only `change` events were handled, so new skill files were silently ignored. The watcher now responds to `add`, `change`, and `unlink` for every configured glob.
- **Glob-based watching** — `.modelbound/**`, `.kiro/skills/**`, `.cursor/rules/**`, and `.claude/**` are watched whether or not they exist at activation. New directories are picked up automatically.
- **Repo association** — each sync sends `repo_url`, `branch`, `ide`, and `relative_path` so ModelBound can show which repository a skill came from and reverse-link skills to repos.
- **MCP-based sync** — outbound writes now call `sync_skill_from_ide` and `delete_skill_from_ide` on the ModelBound MCP Streamable HTTP endpoint, replacing the non-existent `PATCH /v1/skills/{id}` REST endpoint that previously caused silent 404s.
- **`modelbound.mcpUrl` setting** — override the MCP endpoint for self-hosted or staging environments.

### Changed
- Dropped `chokidar` and `axios` dependencies in favor of the built-in `vscode.workspace.createFileSystemWatcher` and `fetch`. Smaller install, fewer transitive deps.
- The watcher no longer ignores dotfiles by default (it must walk dot-prefixed directories like `.modelbound`, `.kiro`, `.cursor`, `.claude`).

### Fixed
- Newly created skill files in `.kiro/skills/` now sync to ModelBound on save.
- Deleting a local skill file now soft-deletes the corresponding row in ModelBound.

## [1.0.0] - 2024-01-01

### Added
- Initial release of ModelBound Context Sync extension
- Bi-directional file sync between local `.modelbound/` directory and ModelBound.co cloud
- Native MCP Server integration for AI agent tooling
- `modelbound.pullSkill` command for manual skill/context pulling
- Chokidar-based file watcher for automatic cloud sync on save
- Configuration options for API key and auto-sync toggle
- `.modelboundignore` security manifest to prevent source code tracking
