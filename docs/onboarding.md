# Onboarding Guide

The restructured CLI is centered on three ideas:

- the source repo or workspace root you are operating in
- the tree repo that stores Context Tree content
- the binding metadata that connects the two

## Recommended Flow

1. Run `first-tree tree inspect --json` from the folder you want to onboard.
   The proposal-aligned `role` values are:
   `tree-repo`, `workspace-root-bound`, `source-repo-bound`,
   `unbound-workspace-root`, `unbound-source-repo`, and `unknown`.
2. Decide whether you are creating a new dedicated tree repo or joining an
   existing shared tree.
3. Use `first-tree tree init` as the high-level entrypoint once the tree engine
   has been fully ported back into this workspace.
4. If your current root is a workspace, use `first-tree tree workspace sync`
   after adding new child repos.
5. Before starting `first-tree github scan`, make sure a binding exists in
   `.first-tree/source.json`, or pass `--tree-repo <owner/repo>` explicitly.

## Current Workspace Reality

At the moment:

- `tree inspect` and `tree status` are implemented
- `tree help onboarding` prints the short in-CLI version of this guide
- the rest of the tree command surface is present as scaffolding while the old
  engine is ported back
- `github scan` is the most complete runtime in the workspace today

## When To Reach For `github scan`

Use `first-tree github scan` when you want the old breeze-style GitHub inbox
automation:

- install or start the daemon
- inspect daemon health
- run one-shot polls
- watch the live TUI
- debug statusline or runtime behavior

The scan runtime now expects tree context. For commands that actually start or
run scanning, bind first or pass `--tree-repo <owner/repo>`.
