# Boundary With `first-tree-write`

Sync and write both end up changing the tree, so the boundary matters.

## One-Line Rule

- **Sync** discovers what changed and decides what needs updating.
- **Write** is given a specific source and turns it into a specific tree
  update.

Sync starts from the tree and asks "is anything stale?" Write starts from a
PR / doc / note and asks "what should the tree say about this?"

## Decision Table

| Situation                                                                                       | Skill                                              |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| User asks "is the tree up to date?"                                                             | sync                                               |
| User asks "audit drift since last release"                                                      | sync                                               |
| User says "PR #123 changed how auth works — reflect it in the tree"                             | write                                              |
| User pastes a meeting note about an architecture decision                                       | write                                              |
| GitHub Scan agent classifies a notification as `route=write`                                    | write                                              |
| GitHub Scan agent classifies a notification as `route=sync`                                     | sync                                               |
| Sync finds a `code-not-synced` drift and the user wants the source PR turned into a tree update | hand off to write                                  |
| Write notices the same domain has other drift the user did not mention                          | finish the write task; suggest sync as a follow-up |

## Why It Matters

If sync starts writing new tree content, it stops being an auditor — it
becomes a content producer with no specific source, and the result is hard
to review.

If write starts auditing, it stops being a focused author — it broadens
into a sweep the user did not request.

Keep the roles tight.

## Hand-Off Mechanics

When sync wants write to take over a single finding:

1. Stop the fix loop on that finding.
2. Surface the source pointer (PR, commit, doc) to the user.
3. Suggest invoking `first-tree-write` with that pointer.
4. Do not preemptively start drafting the tree update inside sync.

When write wants sync to follow up on adjacent drift:

1. Finish the write task the user asked for.
2. In the final summary, list the adjacent findings as "consider running
   sync over <domain>".
3. Do not chain into sync automatically.

## What Both Skills Share

- They both consume the bound tree repo from the managed First Tree
  integration block in `AGENTS.md` / `CLAUDE.md`.
- They both default to "code is the ground truth" except where
  `decisionLocksCode: true` is set on the node.
- They both must use `tree verify` before a final commit.

The shared parts let `first-tree` whitepaper own the methodology; sync and
write own the _when_ and _what_ of applying it.
