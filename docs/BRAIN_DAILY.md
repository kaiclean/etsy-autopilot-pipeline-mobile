# Daily saved-Reel analysis on the Mac

The Brain dashboard originally displayed a bundled copy of an external vault. Its old documentation referred to `/workspace/omnigram/process.py` and an automatic Git push, but that analyser and its scheduler were not in this repository. The historical snapshot contains 114 items: 23 summarised, 84 transcribed, six without video and one metadata-only. Its latest `date_processed` is October 19, 2026. These dates establish when the snapshot last changed; they do not establish the cause or status of the old machine.

The new worker reads your authenticated Instagram saved-video feed, downloads bounded video files, extracts four actual frames with FFmpeg, transcribes audio locally with faster-whisper, and asks an installed local Ollama vision model for evidence-based summaries and original ideas. Product, SaaS, other project and content ideas stay distinct. Nothing here builds software or activates Etsy listings automatically. Product proposals still need a real deliverable, original direction and the existing review/publish gates.

New notes persist in the application's `brain_vault_notes` table and overlay the historical files. Brain pages, search, graph, ideas and approval actions read this combined vault. No daily Git push, production deploy, paid AI service or GitHub Actions runner is needed. Imported notes must include real source references; upload retries are idempotent. A source is inspiration, not permission to copy a creator's work.

## Host setup

Deploy this release, including migration `0035_brain_live_vault`, with a permanent shared Postgres database. Set a random, dedicated `BRAIN_SYNC_TOKEN` (32+ random bytes) in the host's **runtime** environment and set `APP_URL` to the final HTTPS origin. Keep this token separate from dashboard, Etsy and cron credentials. The token authorises reading the known-Reel index and importing notes; it cannot publish listings.

`GET /api/brain/ingest` and `POST /api/brain/ingest` require that bearer token. POST accepts up to eight bounded notes per request plus a strictly validated run checkpoint. A successful final checkpoint also generates pending product candidates using the existing mapping rules; software stays in the ideas backlog. A job with failed items cannot report success.

Sign in and open `/brain/setup`. The private worker-configuration download is session-protected, non-cacheable, and includes the sync token. Do not share or commit it. Changing `BRAIN_SYNC_TOKEN` invalidates old downloads; download a new copy on the Mac after rotation.

**Existing phone demo:** its claimable Neon database expires November 13, 2026 at 23:20 UTC unless replaced or claimed. A successful code deployment does not extend that database. Claiming rotates the database URL; update `DATABASE_URL` through a private secret setting and redeploy before relying on the daily service. Never paste database credentials or Instagram sessions into chat. Do not use an expiring demo database for unattended production.

## Install locally

Use the repository branch/release containing this file, Python 3.11+, FFmpeg, and Ollama. The service runs as your logged-in macOS user. No sudo or cloud worker subscription is needed.

```bash
brew install python@3.12 ffmpeg ollama
brew services start ollama
ollama pull gemma3:4b
python3.12 -m venv .venv-brain
.venv-brain/bin/python -m pip install -r scripts/brain/requirements.txt
```

The selected model must be installed locally and support images. Cloud/forwarding model names, remote Ollama hosts and model metadata declaring a remote host are refused. Model downloads use bandwidth and disk space; processing uses the Mac's RAM and electricity. The first speech transcription downloads the Whisper model. `WHISPER_MODEL=base` is the default; no cloud transcription fallback exists.

Download the configuration **on the Mac** from `/brain/setup`, save it at the repository root as `.env.brain`, and protect it before running any worker command:

```bash
chmod 600 .env.brain
```

Set `INSTAGRAM_USERNAME` inside that local file. Do not put a password there. Sign in interactively on the Mac once:

```bash
.venv-brain/bin/instaloader --login YOUR_INSTAGRAM_USERNAME --login-only
```

Instaloader keeps its authenticated session in its standard local session file. Optional `INSTAGRAM_SESSION_FILE` selects an existing private session file; never use a session file supplied by somebody else. Challenges, two-factor login and reauthentication must be handled locally. An expired/challenged session produces a visible failure, not a falsely successful empty import. Instagram's unofficial saved-feed access can change or be rate limited; the worker does not bypass those restrictions or retry aggressively.

## Verify before scheduling

```bash
.venv-brain/bin/python scripts/brain/daily.py --env-file .env.brain --check
.venv-brain/bin/python scripts/brain/daily.py --env-file .env.brain --force
```

`--check` validates the host token, installed tools, local vision model and current Instagram session. It does not claim that a model download or real analysis has completed. The second command performs a real bounded batch. Verify a fresh source-linked Reel note and its ideas at `/brain/reels` and `/brain/ideas` before calling the integration live.

The worker checks the latest 200 saved posts by default. Videos already summarised in the shared vault are skipped. Previously transcribed items can be completed when encountered. Up to 12 unsummarised videos are attempted per batch; failed items retry on a future pass. Raising `BRAIN_SCAN_LIMIT` (up to 5000) allows a historical backfill; raising `BRAIN_MAX_REELS` (up to 100) increases bounded batch work. The run reports deferred items and reaching the scan bound rather than claiming it inspected the entire saved library. Removed/non-video saves do not become fabricated analyses.

## Install the daily schedule

```bash
bash deploy/brain/install-macos.sh "$PWD/.env.brain"
```

This runs the preflight, then installs `com.kaiclean.omnibrain-daily` with a `StartCalendarInterval`, default **07:20 in the Mac's timezone**. `BRAIN_DAILY_HOUR` and `BRAIN_DAILY_MINUTE` customise it. Re-run the installer after changing the time, Python environment or checkout location. The plist contains file paths, not tokens.

The agent also checks at login and hourly for interrupted/failed/missed work. The local successful-day checkpoint makes these extra triggers exit before accessing Instagram or the dashboard after one successful daily check. `--force` permits another manual batch. A filesystem lock prevents overlapping local runs. Uploads that fail retain completed analysis in a durable outbox, then retry without re-running the model. Keep `.data/brain-worker` (or the explicit `BRAIN_DATA_DIR`) when upgrading. Four sampled frames, transcript and structured analysis are retained privately under `evidence/<shortcode>` for review; full downloaded videos are temporary and are removed after the item is processed. Do not run the legacy analyser in parallel against the same account until its scheduler has been located and stopped.

Keep the Mac powered, connected and logged in. `caffeinate -i` prevents idle sleep during a run; it cannot turn on a powered-off Mac or keep a closed laptop lid awake. A Mac that is offline cannot fetch saves or analyse them; the dashboard will show the missed run.

```bash
launchctl print "gui/$(id -u)/com.kaiclean.omnibrain-daily"
tail -n 80 "$HOME/Library/Logs/OmniBrain/daily.log"
tail -n 80 "$HOME/Library/Logs/OmniBrain/daily.error.log"
```

`/brain` and `/brain/reels` show not-connected, running, failed, stalled (>3h) or overdue (>36h), counters and last successful check. This is actual worker telemetry; the UI never claims a scheduler is installed merely because the code exists. `/api/brain/status` includes this telemetry for the existing authenticated operational API. Failure logs contain stage codes, not session cookies, model response bodies or service credentials. Retain a bounded local log history.

```bash
bash deploy/brain/uninstall-macos.sh
```

Uninstall preserves sessions, outbox, notes, checkpoints and logs. The original `sync-vault.sh` remains available for historical manual file imports; the new daily worker never resets a Git checkout or pushes to `main`.

## Verification

```bash
python3 -m unittest discover -s scripts/brain -p 'test_*.py'
npm exec -- vitest run tests/brain-ingestion.test.ts --fileParallelism=false
npm run typecheck
```

The tests cover real FFmpeg frame extraction from generated media, strict analysis validation, private configuration parsing, local-only inference, SaaS separation, source linking, resumable uploads, duplicate prevention, historical ID preservation, stale-job reporting and the LaunchAgent calendar. Synthetic tests are not proof of authenticated Instagram ingestion or real model output. A live run needs the user's local session and models.
