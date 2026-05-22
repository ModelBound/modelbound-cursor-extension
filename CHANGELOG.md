# Changelog

All notable changes to the "ModelBound Context Sync & MCP Server" extension will be documented in this file.

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
