---
name: first-tree-onboarding
description: Onboard a repo or workspace to First Tree using the current CLI surface and the proposal-aligned five-step setup flow. Use when a repo is unbound, when a workspace needs a shared tree, when you need to choose between creating a new tree and binding an existing one, or when you need to install or start the GitHub scan daemon and prepare agent templates.
---

# First Tree Onboarding

Read these first:

- `../first-tree/SKILL.md`
- `../first-tree/references/structure.md`
- `../first-tree/references/cli-manual.md`

## Workflow

Run onboarding as a five-step flow:

1. inspect the current root
2. choose daemon mode
3. import repos and decide whether to create or bind a tree
4. start the daemon
5. write agent-template files for the requested roles

## CLI Surface

Use the current CLI where it already exists:

- `first-tree tree inspect --json`
- `first-tree tree init`
- `first-tree tree bind`
- `first-tree tree workspace sync`
- `first-tree github scan install`
- `first-tree github scan start`

When a required tree subcommand is still scaffolded in the current repo, keep
the workflow aligned to this skill and avoid inventing a new top-level command.

## Decision Rules

- Prefer a shared tree when many repos need the same decision layer.
- Prefer a new dedicated tree only when the repo truly owns its own context.
- Keep the initial onboarding credential-light until the tree scaffold exists.
- Treat agent-template setup as part of onboarding, not an unrelated afterthought.
