# Role Decision Table

`first-tree tree inspect --json` reports one of six `role` values. This table
maps each role to the right next action.

| `role`                   | What it means                                                                                                                           | Action                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unbound-source-repo`    | Current dir is a git repo with no first-tree binding and is not a workspace root.                                                       | Ask the user whether they have an existing tree. New tree → `first-tree tree init --tree-mode dedicated`. Existing → `first-tree tree init --tree-path <path>` or `--tree-url <url>` with `--tree-mode shared`. |
| `unbound-workspace-root` | Current dir contains multiple direct child repos, each with `.git/`, but the root itself is not bound.                                  | Use `--scope workspace`. New shared tree → `first-tree tree init --scope workspace --tree-mode shared --workspace-id <id>`. Existing shared tree → add `--tree-path <path>` or `--tree-url <url>`.              |
| `source-repo-bound`      | Already bound as a single repo.                                                                                                         | No init/bind. Run `first-tree tree skill upgrade` to refresh shipped skills, then skip to onboarding step 4 (daemon) and step 5 (agents).                                                                       |
| `workspace-root-bound`   | Workspace root already bound.                                                                                                           | Same as above, plus `first-tree tree workspace sync` if new child repos appeared since the last bind.                                                                                                           |
| `tree-repo`              | Current dir is the tree repo itself (`NODE.md` + `members/NODE.md`, plus the managed tree identity block in `AGENTS.md` / `CLAUDE.md`). | Stop. Ask the user whether they meant to onboard a source repo. Do not run onboarding inside the tree.                                                                                                          |
| `unknown`                | Not a git repo and not a recognized workspace shape.                                                                                    | Ask the user whether they want to convert the directory into a git repo first (`git init`), or whether they pointed onboarding at the wrong path.                                                               |

## Workspace Detection Notes

`unbound-workspace-root` only fires when the _direct_ children of the current
directory contain at least two `.git` markers. A nested layout like
`<root>/repos/repo-a/.git` does not count. If the user expects workspace
behavior on a nested layout, ask them to either flatten it or point
onboarding at the inner directory.

## Existing-Binding Sanity Check

If `role` is `*-bound`, also read the `binding` block returned by inspect:

- `binding.bindingMode` confirms the mode (`standalone-source`,
  `shared-source`, `workspace-root`, `workspace-member`).
- `binding.treeRepoName` and `binding.treeMode` confirm the tree.

When any field is missing, treat the binding as corrupt and re-run
`first-tree tree init` with the right flags rather than patching the JSON
manually.

## When `inspect` Disagrees With User Intent

If the user says they want a workspace but inspect reports
`unbound-source-repo`, do not force `--scope workspace`. Either:

- ask whether the user meant to point onboarding at a parent directory; or
- accept the current scope and onboard as a single source repo.

Forcing the wrong scope produces a binding that other commands will reject
later.
