# CLI Restructure Migration

This workspace follows the proposal in
`first-tree-context/proposals/first-tree-cli-restructure.20260429.md`.

The proposal reshapes the public CLI around three namespaces:

- `first-tree tree`
- `first-tree hub`
- `first-tree github`

Inside `github`, the first command group is `scan`, which takes over the old
GitHub inbox / automation runtime previously described as `breeze`.

## Public Path Changes

| Previous path                      | New path                               | Notes                                                                                                    |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `first-tree breeze <subcommand>`   | `first-tree github scan <subcommand>`  | public rename; implementation currently lives in `packages/github-scan`                                  |
| `first-tree skill <subcommand>`    | `first-tree tree skill <subcommand>`   | skill maintenance moves under the tree namespace                                                         |
| `first-tree gardener <subcommand>` | `first-tree-sync` / `first-tree-write` | gardener logic is split into sync and write workflows; `github scan` only routes notifications into them |

## Current Workspace Status

| Surface                                | Current state                                                            |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `tree inspect` / `tree status`         | implemented in `apps/cli`                                                |
| `tree help onboarding`                 | implemented as the current onboarding narrative                          |
| `tree init/bind/bootstrap/...`         | proposal-aligned public scaffolding; engine still needs port-back work   |
| `tree skill ...`                       | proposal-aligned public scaffolding; shipped skills are not restored yet |
| `github scan ...`                      | implemented by wiring the public CLI to `packages/github-scan`           |
| `hub ...`                              | stub namespace only                                                      |
| `first-tree-sync` / `first-tree-write` | canonical gardener-logic replacement skills are now the target shape     |

## GitHub Scan Binding Contract

The proposal requires `github scan` to fail closed when it cannot resolve a
Context Tree binding.

This workspace now enforces that rule at the CLI entry for:

- `install`
- `start`
- `run`
- `daemon`
- `run-once`
- `poll`

Resolution order:

1. `--tree-repo <owner/repo>`
2. `.first-tree/source.json` discovered from the current working directory upward

If neither exists, the command stops with an actionable error that points the
user to `first-tree tree bind ...` or `--tree-repo <owner/repo>`.

The following commands remain diagnosable without a binding:

- `status`
- `doctor`
- `stop`
- `cleanup`
- `watch`
- hook/internal entry points such as `statusline` and `status-manager`

## Remaining Port-Back Work

The biggest gaps between this workspace and the historical main branch are:

1. restore the tree engine behind `init`, `bind`, `bootstrap`, `integrate`,
   `workspace sync`, `verify`, `upgrade`, `publish`, `inject-context`, and `review`
2. restore shipped skill payloads so `first-tree tree skill ...` can become real
3. finish wiring the shipped `first-tree-sync` and `first-tree-write` skills as the old gardener logic replacement
4. update release notes and operational docs once the runtime behavior matches
   the new public command surface

## Contributor Rule Of Thumb

When porting code from the old main branch, prefer:

- proposal names over historical names
- public migration clarity over short-term compatibility hacks
- updating tests and docs in the same PR as the code move
