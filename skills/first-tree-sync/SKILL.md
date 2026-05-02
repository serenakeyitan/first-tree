---
name: first-tree-sync
description: Audit and repair drift between merged code and the Context Tree. Use when the tree may be stale, wrong, outdated, or missing coverage for recent code changes, after a large merge, before release, or when a GitHub notification indicates that tree context may need review. This skill owns broad drift discovery; use `first-tree-write` instead when the user gives explicit source material to write into the tree.
---

# First Tree Sync

Read these first:

- `../first-tree/SKILL.md`
- `../first-tree/references/functions.md`
- `../first-tree/references/maintenance.md`

## Drift Types

Classify findings into durable categories:

- `tree-stale`
- `tree-wrong`
- `tree-outdated`
- `code-not-synced`
- `cross-domain-broken`
- `ownership-stale`

## Workflow

Run sync in two stages:

1. audit the current tree and merged code
2. decide which findings to fix automatically, escalate, or skip

Default to merged code on the default branch as the higher-confidence source,
unless the relevant tree node explicitly says the decision should hold and a
human needs to arbitrate.

## Boundary

- use this skill for broad discovery across a repo or workspace
- use `first-tree-write` when the user already provided the exact PR, doc, or note to write
- do not turn every finding into a tree PR automatically; human review still matters
