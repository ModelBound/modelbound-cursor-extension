---
name: Prompt PR Contributor
description: "Help prepare focused, reviewable pull requests for prompt and skill changes."
allowed-tools: []
license: MIT
version: 0.1.25
---


# Prompt PR Contributor

Use this skill to prepare pull requests modifying prompts, AI skills, rules, or ModelBound sync behavior.

## Goals

- Focus PR on a single behavior change or closely related fixes.
- Explain *why* prompt/sync behavior changed, not just *what* files changed.
- Highlight risks: user content overwrite, stale cloud copies, authentication, backward compatibility.
- Provide a runnable, local test plan.

## Workflow

1. Inspect diff; identify user-facing behavior changes.
2. Distinguish intentional product changes from incidental formatting/generated artifacts.
3. Write a concise PR summary: motivation, expected outcome.
4. Add a test plan covering relevant create, update, delete, pull, and conflict/recovery paths.
5. Flag required manual verification in Cursor, Kiro, or ModelBound backend.

## PR Summary Template

```markdown
## Summary
- Describe primary behavior change.
- Note any user-visible sync, auth, or recovery behavior.

## Test Plan
- [ ] Build/package extension.
- [ ] Install VSIX in target IDE.
- [ ] Verify create/update/delete sync for affected file paths.
- [ ] Verify error/conflict recovery.
```

## Review Notes

Prefer small PRs. Do not embed risky sync changes within unrelated cleanup. If a change can overwrite local/cloud prompt content, make user choices explicit and preserve an escape hatch.