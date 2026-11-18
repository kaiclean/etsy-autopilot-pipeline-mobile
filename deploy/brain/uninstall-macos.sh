#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Darwin && "$(id -u)" != 0 ]] || { echo 'Run on your Mac as the logged-in user.' >&2; exit 1; }
launchctl bootout "gui/$(id -u)/com.kaiclean.omnibrain-daily" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.kaiclean.omnibrain-daily.plist"
echo 'Daily analyser removed. Local sessions, checkpoints, notes and logs preserved.'
