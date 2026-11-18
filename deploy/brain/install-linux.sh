#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then
  echo 'Usage: bash deploy/brain/install-linux.sh /absolute/path/to/.env.brain'
  echo 'Installs Zurich-time triggers with user systemd, cron, or a nohup background scheduler.'
  exit 0
fi
if [[ "$(uname -s)" != Linux || "$(id -u)" == 0 ]]; then
  echo 'Run on Linux as your normal user, without sudo.' >&2
  exit 1
fi
if [[ $# != 1 || "$1" != /* || ! -f "$1" ]]; then
  echo 'Supply an existing absolute path to the private .env.brain file.' >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
brain_python="$script_dir/../../.venv-brain/bin/python"
if [[ ! -x "$brain_python" ]]; then
  echo 'Install scripts/brain/requirements.txt into .venv-brain first; see docs/BRAIN_DAILY.md.' >&2
  exit 1
fi
exec "$brain_python" "$script_dir/linux.py" install "$1"
