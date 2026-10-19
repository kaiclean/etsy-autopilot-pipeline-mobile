#!/usr/bin/env bash
# Re-sync the OmniGram Obsidian vault into data/omnibrain/ and (optionally) push to main.
# Railway redeploys etsy-autopilot on every push to main, so by default this only commits.
# Usage: scripts/brain/sync-vault.sh [--push]
# Env: VAULT_SRC (default /workspace/omnigram/OmniBrain), MEDIA_DIR (for thumbnails)
set -euo pipefail
SRC="${VAULT_SRC:-/workspace/omnigram/OmniBrain}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="data/omnibrain/vault"
[ -d "$SRC" ] || { echo "vault source not found: $SRC" >&2; exit 1; }
cd "$REPO"
git pull --ff-only --quiet || { echo "git pull failed; resolve manually" >&2; exit 1; }
rm -rf "$DEST.tmp" && mkdir -p "$DEST.tmp"
# Leave out raw Archive/ files, media and Obsidian workspace state.
(cd "$SRC" && tar cf - --exclude=./Archive --exclude=Archive --exclude='*.mp4' --exclude='*.mov' --exclude='*.webm' \
  --exclude='*.jpg' --exclude='*.png' --exclude='*.zip' --exclude=.obsidian --exclude=.trash --exclude=.DS_Store .) | (cd "$DEST.tmp" && tar xf -)
rm -rf "$DEST" && mv "$DEST.tmp" "$DEST"
python3 "$REPO/scripts/brain/make-thumbs.py" || echo "thumbnail step failed (continuing)"
git add -A data/omnibrain
if git diff --cached --quiet; then echo "vault unchanged"; exit 0; fi
n=$(find "$DEST" -name '*.md' | wc -l | tr -d ' ')
git commit --quiet -m "brain: vault sync $(date +%Y-%m-%d\ %H:%M) ($n notes)"
echo "committed $(git rev-parse --short HEAD)"
[ "${1:-}" = "--push" ] || { echo "not pushed (run with --push to deploy)"; exit 0; }
git push --quiet origin HEAD:main && echo "pushed to main; Railway will redeploy etsy-autopilot"
