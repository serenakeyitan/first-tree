#!/usr/bin/env bash
#
# Uninstall the menu bar tray:
#  - Stop any running instance
#  - Remove the LaunchAgent (so it won't auto-start at login)
#  - Remove ~/.first-tree/tray/
#
# Does NOT touch ~/.first-tree/tray-state.json or tray-seen.json — those are
# user state. Pass --purge to wipe those too.
#

set -euo pipefail

PURGE=0
while [ "${1:-}" != "" ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --help|-h)
      sed -n '3,11p' "$0"
      exit 0 ;;
    *) echo "ERROR: unknown flag '$1'"; exit 2 ;;
  esac
done

# Stop running instance (if any).
pkill -f "FirstTreeTray.app/Contents/MacOS/FirstTreeTray" 2>/dev/null || true

# Unload + delete LaunchAgent.
PLIST="$HOME/Library/LaunchAgents/com.first-tree.tray.plist"
if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$UID/com.first-tree.tray" 2>/dev/null || true
  rm -f "$PLIST"
  echo "→ Removed launch agent."
fi

# Remove app dir.
DEST_DIR="$HOME/.first-tree/tray"
if [ -d "$DEST_DIR" ]; then
  rm -rf "$DEST_DIR"
  echo "→ Removed $DEST_DIR."
fi

# Optional: also wipe persisted user state.
if [ "$PURGE" = "1" ]; then
  rm -f "$HOME/.first-tree/tray-state.json" "$HOME/.first-tree/tray-seen.json"
  echo "→ Purged tray-state.json + tray-seen.json."
fi

echo "✓ Menu bar app uninstalled."
