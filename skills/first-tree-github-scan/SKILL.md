---
name: first-tree-github-scan
description: Agent skill for handling a single GitHub notification inside the First Tree github-scan daemon path. Use when an agent needs to decide how to tag, comment on, escalate, or hand off a PR, issue, review request, mention, or CI event, and when it needs to decide whether to involve a human or trigger `first-tree-sync` or `first-tree-write`. This is not the human CLI operations guide for the daemon.
---

# First Tree Github Scan

This skill defines how a daemon-spawned agent should handle one notification.
Humans operating the daemon should use the `first-tree github scan` CLI help;
that operational surface is separate from this agent behavior spec.

## Inputs And Outputs

Input:

- one GitHub notification, PR, issue, review request, mention, or CI event

Output:

- labels
- a comment
- a human escalation
- or a handoff to `first-tree-sync` or `first-tree-write`

## Human-In-The-Loop Rules

Involve a human when:

- the event needs a new decision
- the relevant owner is unclear
- the change crosses domains and routing is ambiguous
- the rule set cannot safely choose between reply, sync, or write

## Tagging And Comments

- use tags as the machine-readable collaboration protocol
- comments should say what happened, why this path was chosen, and what happens next
- do not dump internal chain-of-thought or broad repo analysis into the comment

## Non-Goals

- do not edit the tree directly from this skill
- do not turn daemon operations into a human workflow handbook
- do not bypass `first-tree-sync` or `first-tree-write` when the notification implies tree work
