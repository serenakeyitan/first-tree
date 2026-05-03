# first-tree menu bar app

Native macOS menu bar tray for the `first-tree github scan` daemon. Lives in the
top-right corner of the screen, shows a badge with the count of items needing
human attention, and lets you Pause/Resume the daemon without dropping into a
terminal.

This is a thin client of the daemon — the same `127.0.0.1:7878/inbox` HTTP
endpoint that powers the dashboard at `http://127.0.0.1:7878/`. Daemon is
authoritative; the tray just renders state and proxies daemon-control actions.

## Requirements

- macOS 13+
- Swift toolchain (Xcode Command Line Tools is sufficient — no Xcode needed)
- The `first-tree` CLI must be on `PATH` (the tray shells out to it for daemon
  control)

## Build

```bash
cd apps/tray-mac
swift build
```

This produces `.build/arm64-apple-macosx/debug/FirstTreeTray`. To run as a
proper menu-bar app (not a Dock app), you need a minimal `.app` bundle. See
`scripts/build-tray-app.sh` (when shipped) for the bundling flow used by
`first-tree github scan install`.

## What it does

- Shows the first-tree pixel-tree icon in the menu bar
- Badge: count of items where `github_scan_status === "human"`
- Click icon → dropdown with:
  - Status row: ● Online / Paused / Offline + Pause/Resume button
  - List of items needing you (PR / issue links — click to open in browser)
  - Open dashboard
  - Preferences…
  - Quit
- Pause: stops the daemon, tray stays in menu bar
- Resume: restarts daemon with the same `--allow-repo` and `--tree-repo` it was
  running with (read from the launchd plist)
- Quit: stops daemon AND closes the tray (with a confirmation dialog)

## Persistence

- `~/.first-tree/tray-state.json` — repo scope and tree-repo captured at Pause,
  used by Resume to restart the daemon with the same configuration
- `~/.first-tree/tray-seen.json` — IDs of inbox items the user has clicked.
  Persisted so clicked rows stay dimmed across tray restarts. Garbage-collected
  whenever the daemon stops tracking an item.

## Distribution

The tray ships as part of the npm `first-tree` package and is installed by
`first-tree github scan install` — no separate download, no drag-to-Applications.
See [docs/onboarding.md](../../docs/onboarding.md) (when shipped) for the
end-to-end flow.
