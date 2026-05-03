#!/usr/bin/env bash
#
# Install the menu bar tray to ~/.first-tree/tray/ and (optionally) register
# it as a login item so it auto-launches at boot.
#
# This is invoked by `first-tree github scan install` when the user opts in
# to the menu bar app. Can also be run by hand for development.
#
# Flags:
#   --keep-quarantine   Don't remove the macOS quarantine attribute on the
#                       installed .app. Default is to remove it (so the user
#                       doesn't see a "first-time" Gatekeeper warning).
#   --no-launch         Install but don't open the app afterwards.
#   --no-autostart      Don't register a LaunchAgent for auto-start at login.
#   --source <path>     Path to FirstTreeTray.app to install (default: built
#                       inline via build-tray-app.sh).
#

set -euo pipefail

KEEP_QUARANTINE=0
LAUNCH=1
AUTOSTART=1
SOURCE_APP=""

while [ "${1:-}" != "" ]; do
  case "$1" in
    --keep-quarantine) KEEP_QUARANTINE=1; shift ;;
    --no-launch)       LAUNCH=0; shift ;;
    --no-autostart)    AUTOSTART=0; shift ;;
    --source)          SOURCE_APP="$2"; shift 2 ;;
    --help|-h)
      sed -n '3,18p' "$0"
      exit 0 ;;
    *)
      echo "ERROR: unknown flag '$1'"
      echo "Run with --help to see options."
      exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAY_DIR="$(dirname "$SCRIPT_DIR")"
DEST_DIR="$HOME/.first-tree/tray"
DEST_APP="$DEST_DIR/FirstTreeTray.app"

# 1. Resolve the source .app — build inline if not provided.
if [ -z "$SOURCE_APP" ]; then
  SOURCE_APP="$TRAY_DIR/.build/FirstTreeTray.app"
  if [ ! -d "$SOURCE_APP" ]; then
    echo "→ Building tray app first..."
    "$SCRIPT_DIR/build-tray-app.sh" release
  fi
fi

if [ ! -d "$SOURCE_APP" ]; then
  echo "ERROR: source .app not found at $SOURCE_APP"
  exit 1
fi

# 2. Copy to ~/.first-tree/tray/ (out of /Applications — we treat the tray
#    as part of the github-scan runtime, like the daemon).
echo "→ Installing to $DEST_APP..."
mkdir -p "$DEST_DIR"
# Stop any running instance so the copy doesn't fail.
pkill -f "FirstTreeTray.app/Contents/MacOS/FirstTreeTray" 2>/dev/null || true
sleep 0.5
rm -rf "$DEST_APP"
cp -R "$SOURCE_APP" "$DEST_APP"

# 3. Strip the macOS quarantine attribute unless the user asked to keep it.
#    Without this, opening a non-signed app for the first time triggers a
#    Gatekeeper warning. Removing it lets the app launch silently.
if [ "$KEEP_QUARANTINE" = "0" ]; then
  echo "→ Removing macOS quarantine flag (so first launch doesn't pop a warning)..."
  xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true
else
  echo "→ Keeping macOS quarantine flag — first launch will show a confirmation dialog."
fi

# 4. Register as a login item so the tray comes back automatically at boot.
if [ "$AUTOSTART" = "1" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.first-tree.tray.plist"
  echo "→ Writing launch agent at $PLIST..."
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.first-tree.tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>$DEST_APP</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
PLIST_BODY
  # Reload so the change takes effect now (and at every future login).
  launchctl bootout "gui/$UID/com.first-tree.tray" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || true
fi

# 5. Open the app now so the user sees the icon immediately.
if [ "$LAUNCH" = "1" ]; then
  echo "→ Launching..."
  open "$DEST_APP"
fi

echo ""
echo "✓ Menu bar app installed."
echo "  Look for the leaf icon in the top-right corner of your screen."
