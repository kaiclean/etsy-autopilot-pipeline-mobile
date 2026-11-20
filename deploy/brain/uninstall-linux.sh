#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --help ]]; then
  echo 'Usage: bash deploy/brain/uninstall-linux.sh'
  echo 'Removes Brain scheduling, including the nohup fallback. Local data and logs are preserved.'
  exit 0
fi
if [[ "$(uname -s)" != Linux || "$(id -u)" == 0 || $# != 0 ]]; then
  echo 'Run on Linux as your normal user, without sudo or arguments.' >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec python3 "$script_dir/linux.py" uninstall
