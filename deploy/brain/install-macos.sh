#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then
  echo 'Usage: bash deploy/brain/install-macos.sh /absolute/path/to/.env.brain'
  echo 'Installs a daily per-user saved-Reel analyser with hourly failed-run catch-up.'
  exit 0
fi
if [[ "$(uname -s)" != Darwin || "$(id -u)" == 0 ]]; then
  echo 'Run this on your Mac as the logged-in user, without sudo.' >&2
  exit 1
fi
if [[ $# != 1 || "$1" != /* || ! -f "$1" ]]; then
  echo 'Supply an existing absolute path to the private .env.brain file.' >&2
  exit 1
fi
brain_repo="$(cd "$(dirname "$0")/../.." && pwd)"
brain_env="$1"
brain_python="$brain_repo/.venv-brain/bin/python"
brain_logs="$HOME/Library/Logs/OmniBrain"
brain_plist="$HOME/Library/LaunchAgents/com.kaiclean.omnibrain-daily.plist"
if [[ ! -x "$brain_python" ]]; then
  echo 'Install scripts/brain/requirements.txt into .venv-brain first; see docs/BRAIN_DAILY.md.' >&2
  exit 1
fi
umask 077
chmod 600 "$brain_env"
cd "$brain_repo"
"$brain_python" scripts/brain/daily.py --env-file "$brain_env" --check
mkdir -p "$brain_logs" "$(dirname "$brain_plist")"
"$brain_python" scripts/brain/install-agent.py "$brain_env" "$brain_python" "$brain_repo" "$brain_logs" "$brain_plist"
/usr/bin/plutil -lint "$brain_plist"
brain_target="gui/$(id -u)/com.kaiclean.omnibrain-daily"
launchctl bootout "$brain_target" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$brain_plist"
echo 'Installed com.kaiclean.omnibrain-daily. Check /brain for the first successful run.'
echo "Local logs: $brain_logs"
