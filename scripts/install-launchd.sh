#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="$(command -v node)"
DAEMON_DIST_PATH="$PROJECT_DIR/dist/daemon/index.js"
SRV_HOME="$HOME/.srv"
PLIST_DEST="$HOME/Library/LaunchAgents/com.srv-wrapper.daemon.plist"

mkdir -p "$SRV_HOME"

sed \
  -e "s#__NODE_PATH__#${NODE_PATH}#g" \
  -e "s#__DAEMON_DIST_PATH__#${DAEMON_DIST_PATH}#g" \
  -e "s#__SRV_HOME__#${SRV_HOME}#g" \
  "$PROJECT_DIR/scripts/com.srv-wrapper.daemon.plist" > "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "srvd installed and loaded via launchd. Logs: $SRV_HOME/daemon.log"
