# Changelog

## 1.9.0 — 2026-06-13

### Added
- **Palette commands** for Skill Development Pipeline features:
  - `ModelBound: Run Skill Test` — executes `skill.test` MCP tool and shows pass/fail summary
  - `ModelBound: Show Skill Versions` — opens a webview panel listing checkpoints with scores, labels, and restore/diff actions
  - `ModelBound: Diff Skill Versions` — quick-pick two versions and show a diff document
  - `ModelBound: Show Project Health` — displays overall score, budgets, and suggestions
- **Persistent status bar** (`ModelBoundStatusBar`) — polls `pipeline.status` every 30s, shows score + budget warnings, click opens health
- **CodeLens on SKILL.md files** (`SkillCodeLensProvider`) — shows version count, latest score, and quick-action buttons for Pipeline and Test directly above the frontmatter
- **Version webview** — interactive table with Restore and Diff buttons; restore opens the content in a new editor
- **60-second undo toast** after restore — shows an information message with "Undo Restore" button that triggers the editor undo stack

## 1.8.6

- Refined auto-sync watcher globs and realtime echo suppression for cloud-to-IDE pulls.
