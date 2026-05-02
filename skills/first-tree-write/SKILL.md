---
name: first-tree-write
description: Write Context Tree updates from explicit source material such as code PRs, design docs, meeting notes, or raw text. Use when the user gives you concrete inputs and wants the right durable tree changes drafted, linked, and reviewed. This skill is source-driven and targeted; use `first-tree-sync` instead for broad drift audits.
---

# First Tree Write

Read these first:

- `../first-tree/SKILL.md`
- `../first-tree/references/anti-patterns.md`
- `../first-tree/references/maintenance.md`

## Inputs

Typical source material:

- one or more code PRs
- a spec or design doc
- meeting notes
- raw text the user wants reflected into the tree

## Workflow

1. identify what belongs in the tree and what stays in the source system
2. choose the smallest correct node or leaf update
3. draft the update with rationale, not code detail
4. verify structure and ownership expectations
5. link the tree change to the source PR or document that motivated it

## Boundary

- prefer `first-tree-sync` if the job starts as a broad audit
- use this skill when the source material is explicit and the writing target is the main question
- do not invent new tree content when the source is still ambiguous; ask for clarification or mark the update as needing review
