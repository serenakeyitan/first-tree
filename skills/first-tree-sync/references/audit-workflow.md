# Audit Workflow

Sync's first phase: walk the tree and the code, produce a `drifts[]` list.
The current CLI does not have a single `tree audit` command yet; this
workflow uses `tree verify` plus manual reading.

## Inputs

- one tree repo (the one bound to the current source/workspace)
- one or more source repos (read from the tree's managed code-repo registry
  block in `AGENTS.md` / `CLAUDE.md`, or from `source-repos.md`)
- optional `--since <ref>` to scope the audit to changes since a commit

## Phases

### Phase 1: Cheap Structural Pass

Run:

```bash
first-tree tree verify
```

`verify` exits non-zero on:

- missing `title`/`owners` frontmatter on a tree node
- broken `soft_links` targets (this surfaces `cross-domain-broken` directly)
- missing or malformed tree identity metadata
- members/ structure violations

Convert each verify failure into a candidate drift:

| `verify` failure                   | Drift type                               |
| ---------------------------------- | ---------------------------------------- |
| broken `soft_links` target         | `cross-domain-broken`                    |
| missing frontmatter on a leaf node | `tree-wrong` (the node is malformed)     |
| member validation failure          | `ownership-stale` candidate (re-confirm) |

Other verify failures are _structural_, not drift — fix them as
`tree-wrong` only if a human review confirms the node never made sense.

### Phase 2: Code-Vs-Tree Read-Through

For each `NODE.md` in the tree:

1. Identify the source-repo path the node describes (use the domain
   directory name as a hint; cross-check against the binding entries).
2. Read the matching code-side directory.
3. For each fact stated in the node, check whether code still supports it.
4. Classify any disagreement using `references/drift-taxonomy.md`.

This phase is read-only and human-paced. Do not write tree updates here.

### Phase 3: Recent-Change Sweep

If `--since <ref>` is set or the user wants a focused audit:

```bash
git log --oneline <ref>..HEAD -- <source-path>
```

For each commit in the range:

- skim the diff
- ask: "did this commit move, rename, or remove anything the tree
  references?"
- if yes, classify as `tree-stale` or `code-not-synced` and add to
  `drifts[]`

## Output Shape

The audit phase emits a single `drifts[]` list. Each entry:

```json
{
  "type": "tree-stale | tree-wrong | tree-outdated | code-not-synced | cross-domain-broken | ownership-stale",
  "treeNode": "<relative path inside the tree repo>",
  "sourcePointer": "<repo>:<path>:<line?>",
  "summary": "<one sentence>",
  "evidence": "<commit sha, file path, or quoted line>",
  "decisionLocksCode": false
}
```

Print as JSON for downstream tooling; also print a short human-readable
table for the user.

## Boundaries

- Do not audit a tree that is not bound to the current source/workspace.
  Sync that requires reading code from the right repos — point the user at
  `first-tree-onboarding` first.
- Do not produce any fix in the audit phase. Fixes go to the fix workflow
  (`references/fix-workflow.md`), where ownership and human-review rules
  apply.
- Do not enrich the tree with new content during audit. Adding new
  decisions is the `first-tree-write` skill's job.

## Exit Conditions

- All drift candidates are classified and written into `drifts[]`.
- Findings that need human disambiguation are flagged with the question
  attached, not invented as drift.
- If the audit produces zero drifts, return that explicitly. "No drift" is
  a valid result; treat silence as a bug.
