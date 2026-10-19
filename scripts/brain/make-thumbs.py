#!/usr/bin/env python3
"""Build data/omnibrain/thumbs/<shortcode>.webp for every reel note: a frame from the local mp4,
or the Instagram thumbnail from Archive/<shortcode>.info.json as a fallback. Idempotent."""
import json, os, re, subprocess, sys, urllib.request, tempfile
SRC = os.environ.get("VAULT_SRC", "/workspace/omnigram/OmniBrain")
MEDIA = os.environ.get("MEDIA_DIR", "/workspace/omnigram/media")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "data", "omnibrain", "thumbs"); os.makedirs(OUT, exist_ok=True)
codes = set()
for f in os.listdir(os.path.join(REPO, "data", "omnibrain", "vault", "Reels")):
    m = re.search(r'^shortcode:\s*"?([^"\n]+)"?', open(os.path.join(REPO, "data", "omnibrain", "vault", "Reels", f), encoding="utf8").read(), re.M)
    if m: codes.add(m.group(1).strip())
def ff(inp, out, seek):
    args = ["ffmpeg", "-loglevel", "error", "-y"] + (["-ss", seek] if seek else []) + ["-i", inp, "-frames:v", "1",
            "-vf", "scale=360:-2:flags=lanczos,crop=360:min(ih\\,480)", "-c:v", "libwebp", "-quality", "72", out]
    return subprocess.run(args, capture_output=True).returncode == 0 and os.path.getsize(out) > 500
made = skipped = failed = 0
for c in sorted(codes):
    out = os.path.join(OUT, c + ".webp")
    if os.path.exists(out): skipped += 1; continue
    ok = False
    mp4 = os.path.join(MEDIA, c + ".mp4")
    if os.path.exists(mp4): ok = ff(mp4, out, "1.2") or ff(mp4, out, None)
    info = os.path.join(SRC, "Archive", c + ".info.json")
    if not ok and os.path.exists(info):
        url = json.load(open(info)).get("thumbnail")
        if url:
            try:
                with tempfile.NamedTemporaryFile(suffix=".jpg") as t:
                    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                    t.write(urllib.request.urlopen(req, timeout=15).read()); t.flush()
                    ok = ff(t.name, out, None)
            except Exception: ok = False
    if ok: made += 1
    else:
        failed += 1
        if os.path.exists(out): os.remove(out)
print(f"thumbs: {made} new, {skipped} existing, {failed} unavailable, {len(codes)} reels")
