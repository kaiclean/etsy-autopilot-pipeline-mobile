#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin || "$(id -u)" == 0 ]]; then
  echo "Run on macOS as your logged-in user, without sudo." >&2
  exit 1
fi
launchctl bootout "gui/$(id -u)/com.kaiclean.etsy-autopilot" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.kaiclean.etsy-autopilot.plist"
echo "Removed the worker LaunchAgent. Environment, logs, database and stored files were preserved."
