---
name: first-tree-onboarding
version: 0.4.0-alpha.1
cliCompat:
  first-tree: ">=0.4.0 <0.5.0"
description: Onboard a repo or workspace to First Tree using the proposal-aligned five-step setup flow. Use when a repo is unbound, when a workspace needs a shared tree, when you need to choose between creating a new tree and binding an existing one, or when you need to install or start the GitHub scan daemon and prepare agent templates. Use this skill instead of running `first-tree tree init` from raw memory — it owns the role-by-role decision rules and the daemon/agent setup checks.
---

# First Tree Onboarding

Read these first:

- `../first-tree/SKILL.md`
- `../first-tree/references/structure.md`
- `../first-tree/references/cli-manual.md`

## What This Skill Does

Drive a repo or workspace from "no first-tree binding" to "tree bound,
daemon running, agent templates in place." Five steps:

0. inspect the current root and classify the role
1. choose a daemon mode (local vs cloud — only local exists today)
2. import repos (no-op for single repos; `workspace sync` for workspaces)
3. init or bind the tree
4. start the GitHub Scan daemon
5. set up agent templates

The full recipe with exact CLI invocations is in
[references/recipe.md](references/recipe.md). Read that before running any
command.

## When To Use This Skill

| Use this skill                                     | Use a different skill                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Repo or workspace is unbound                       | The repo is already bound and the user wants drift detection — use `first-tree-sync` |
| User wants to start GitHub Scan for the first time | User wants to write a tree update from a specific PR — use `first-tree-write`        |
| User wants to refresh shipped skill payloads       | User wants to handle one inbound notification — use `first-tree-github-scan`         |

## How To Decide Branches

Run `first-tree tree inspect --json` first. The `role` field has six values;
[references/role-decisions.md](references/role-decisions.md) maps each role
to the right next action.

| `role`                                       | Next action                                                         |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `unbound-source-repo`                        | step 3a or 3b (single repo)                                         |
| `unbound-workspace-root`                     | step 2 (workspace sync) then step 3a or 3b with `--scope workspace` |
| `source-repo-bound` / `workspace-root-bound` | skip to step 4 + 5                                                  |
| `tree-repo`                                  | stop — onboarding does not run inside the tree repo                 |
| `unknown`                                    | ask the user before continuing                                      |

## Hard Rules

- Never proceed past step 3 if `first-tree tree verify` fails. Report the
  failures and stop.
- Never run `first-tree github scan install` until a binding exists in
  the managed First Tree integration block in `AGENTS.md` or `CLAUDE.md`.
  The CLI will fail closed; do not bypass it.
- Never edit managed First Tree integration / tree identity / code-repo
  registry blocks by hand. Re-run the relevant `tree` command instead.
- Never start any agent runtime in step 5. Step 5 writes templates only; the
  daemon spawns agents.
- Never claim onboarding succeeded without a final `tree skill doctor` and
  `github scan doctor` pair, both reporting healthy.

## References

- [recipe.md](references/recipe.md) — the canonical 5-step flow with CLI
  invocations and check points
- [role-decisions.md](references/role-decisions.md) — what to do for each of
  the six `inspect` role values
- [agent-templates.md](references/agent-templates.md) — schema and writing
  instructions for step 5
- [cli-quickref.md](references/cli-quickref.md) — every CLI call this skill
  uses, in one place
