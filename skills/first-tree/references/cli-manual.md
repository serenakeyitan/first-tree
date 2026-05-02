# CLI Manual

This repo currently exposes three top-level CLI groups.

## `first-tree tree`

Use for tree lifecycle work:

- inspect current repo state
- bind a source/workspace root to a tree
- validate and publish tree repos
- maintain shipped skill payloads

Current implementation status: `inspect`, `status`, and help are live; the
rest of the tree surface is being ported back.

## `first-tree github scan`

Use for GitHub inbox runtime work:

- install and start the daemon
- inspect runtime state
- poll notifications
- run foreground debug commands

This is the most complete runtime in the current repo.

## `first-tree hub`

Reserved namespace for future hosted or local Hub integration. Treat it as
scaffolding until the repo lands the real implementation.
