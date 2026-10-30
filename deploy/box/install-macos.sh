#!/bin/bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: bash deploy/box/install-macos.sh /absolute/path/to/.env.box"
  echo "Installs a per-user LaunchAgent. Run as your logged-in user, without sudo."
  exit 0
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo "This installer runs on macOS only." >&2
  exit 1
fi
if [[ "$(id -u)" == 0 ]]; then
  echo "Run as your logged-in user, without sudo." >&2
  exit 1
fi
if [[ $# != 1 || "$1" != /* || ! -f "$1" ]]; then
  echo "Supply an existing absolute path to your private .env.box file." >&2
  exit 1
fi

box_node="$(command -v node || true)"
if [[ -z "$box_node" ]]; then
  echo "Install Node.js 22.12+ first." >&2
  exit 1
fi
"$box_node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12))process.exit(1)' || {
  echo "Node.js 22.12+ is required." >&2; exit 1;
}
box_repo="$(cd "$(dirname "$0")/../.." && pwd)"
box_env="$1"
box_agent_dir="$HOME/Library/LaunchAgents"
box_log_dir="$HOME/Library/Logs/EtsyAutopilot"
box_plist="$box_agent_dir/com.kaiclean.etsy-autopilot.plist"
box_target="gui/$(id -u)/com.kaiclean.etsy-autopilot"

if [[ ! -d "$box_repo/node_modules/tsx" ]]; then
  echo "Run npm ci in the repository first." >&2
  exit 1
fi
umask 077
chmod 600 "$box_env"
cd "$box_repo"
"$box_node" --env-file="$box_env" scripts/check-free-setup.mjs --role=box
mkdir -p "$box_agent_dir" "$box_log_dir"
"$box_node" --input-type=module - "$box_repo" "$box_node" "$box_env" "$box_log_dir" "$box_plist" <<'JS'
import fs from "node:fs";
import path from "node:path";
const [repo, node, envFile, logDir, plist] = process.argv.slice(2);
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
let text = fs.readFileSync(path.join(repo,"deploy/box/com.kaiclean.etsy-autopilot.plist.template"),"utf8");
const replacements={NODE:node,NODE_DIR:path.dirname(node),ENV_FILE:envFile,REPO:repo,LOG_DIR:logDir};
text=text.replace(/__(NODE|NODE_DIR|ENV_FILE|REPO|LOG_DIR)__/g,(_,key)=>xml(replacements[key]));
fs.writeFileSync(plist,text,{mode:0o600});
JS
/usr/bin/plutil -lint "$box_plist"
launchctl bootout "$box_target" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$box_plist"
echo "Installed com.kaiclean.etsy-autopilot for the logged-in user."
echo "Logs: $box_log_dir"
echo "The agent starts at login; the Mac must stay powered on and connected."
