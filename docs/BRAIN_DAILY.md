# Twice-daily saved-Reel analysis

The Brain dashboard originally displayed a bundled copy of an external vault. Its old documentation referred to `/workspace/omnigram/process.py` and an automatic Git push, but that analyser and its scheduler were not in this repository. The historical snapshot contains 114 items: 23 summarised, 84 transcribed, six without video and one metadata-only. Its latest `date_processed` is October 19, 2026. These dates establish when the snapshot last changed; they do not establish the cause or status of the old machine.

The new worker reads your authenticated Instagram saved-video feed, downloads bounded video files, extracts four actual frames with FFmpeg, transcribes audio locally with faster-whisper, and asks an installed local Ollama vision model for evidence-based summaries and original ideas. Product, SaaS, other project and content ideas stay distinct. Nothing here builds software or activates Etsy listings automatically. Product proposals still need a real deliverable, original direction and the existing review/publish gates.

New notes persist in the application's `brain_vault_notes` table and overlay the historical files. Brain pages, search, graph, ideas and approval actions read this combined vault. No daily Git push, production deploy, paid AI service or GitHub Actions runner is needed. Imported notes must include real source references; upload retries are idempotent. A source is inspiration, not permission to copy a creator's work.

## Host setup

Deploy to Railway service **etsy-autopilot**, environment **production**, backed by Neon project **cold-shape-50670040**. In the Railway service's runtime Variables set:

- `APP_URL=https://etsy-autopilot-production-8b9f.up.railway.app`
- `BRAIN_SYNC_TOKEN`: a random, dedicated secret (32+ random bytes), set by Kai. Keep it separate from dashboard, Etsy and cron credentials. It authorises reading the known-Reel index and importing notes; it cannot publish listings.

Migrations `0034_brain_product_origins` and `0035_brain_live_vault` were applied manually in production. Startup reports journal entries missing from `drizzle.__drizzle_migrations`; this can include manually applied SQL and is not proof the schema is missing. Verify the schema and migration ledger before reconciling any entries. Drizzle only runs journal entries newer than the latest recorded `created_at`; a new migration's `when` must exceed both the existing journal timestamps and production's `1793410867943` high-water mark.

`GET /api/brain/ingest` and `POST /api/brain/ingest` require that bearer token. POST accepts up to eight bounded notes per request plus a strictly validated run checkpoint. A successful final checkpoint also generates pending product candidates using the existing mapping rules; software stays in the ideas backlog. A job with failed items cannot report success.

Sign in and open `/brain/setup`. The private worker configuration is session-protected, non-cacheable and includes the sync token. Do not share or commit it. After token rotation, download a fresh copy. The worker uses `APP_URL` as its ingest origin; older files with only `BRAIN_BASE_URL` still work if they point to the correct host.

Legacy artwork approvals with no linked keyword can be sent from `/brain/ideas` with **Send to pipeline**. Review the search phrase, select the theme and explicitly confirm. Nothing is requeued automatically and this does not change automation or publish settings.

## Linux (production worker)

On the always-on box, install Python 3.11+ with `venv`, timezone data, FFmpeg (`ffmpeg` and `ffprobe`) and Ollama. Run the worker as the same unprivileged user who owns the session and checkout.

```bash
python3 -m venv .venv-brain
.venv-brain/bin/python -m pip install -r scripts/brain/requirements.txt
# Start the local Ollama service on 127.0.0.1:11434 first.
ollama pull gemma3:4b
```

Set `OLLAMA_MODEL` to an installed vision model (default `gemma3:4b`; a smaller local vision model is fine). Remote Ollama hosts or models are refused. Audio uses faster-whisper on CPU with `int8`; `WHISPER_MODEL=base` is the default, or use `small`. The first speech transcription may download the model.

Download `.env.brain` to the box, set `INSTAGRAM_USERNAME`, and follow the session and verification steps below. Then install the schedule:

```bash
bash deploy/brain/install-linux.sh "$PWD/.env.brain"
```

The installer preflights the worker and prefers a persistent systemd user timer. For that timer to keep running after logout and start at boot, enable lingering for the service user (`loginctl enable-linger USER`, with administrator approval if required). If systemd user services are unavailable, the installer tries cron, then a `nohup` scheduler with a pidfile. Keep the Brain cron block last so its `CRON_TZ=Europe/Zurich` does not apply to other jobs. The worker's cron trigger uses Zurich time even on cron implementations that ignore `CRON_TZ`. The `nohup` fallback does not survive a host or container restart; rerun the installer after restart.

The default schedule is **07:20 and 19:20 Europe/Zurich**, with hourly catch-up. Change `BRAIN_RUN_TIMES` and reinstall to adjust the schedule. Logs are under `$BRAIN_DATA_DIR/logs` (default `.data/brain-worker/logs`). To remove the schedule without deleting sessions, logs or checkpoints:

```bash
bash deploy/brain/uninstall-linux.sh
```

## macOS (optional)

```bash
brew install python@3.12 ffmpeg ollama
brew services start ollama
ollama pull gemma3:4b
python3.12 -m venv .venv-brain
.venv-brain/bin/python -m pip install -r scripts/brain/requirements.txt
```

The LaunchAgent has two calendar entries, configurable via `BRAIN_RUN_TIMES`, plus a login and hourly tick. LaunchAgent calendar entries use the Mac's timezone; set the Mac to Europe/Zurich to match exact slot start times. Matching and catch-up in the worker always use Zurich time.

After session setup and verification, run `bash deploy/brain/install-macos.sh "$PWD/.env.brain"`. The plist contains paths, not tokens. The Mac must be powered, connected and logged in; `caffeinate` only prevents idle sleep during a run. Inspect `launchctl print "gui/$(id -u)/com.kaiclean.omnibrain-daily"` and the two log files in `$HOME/Library/Logs/OmniBrain`. Remove the agent with `bash deploy/brain/uninstall-macos.sh`.

## Set up the private Instagram session

Save the configuration from `/brain/setup` as `.env.brain` at the repository root and protect it:

```bash
chmod 600 .env.brain
```

Set `INSTAGRAM_USERNAME` in the file; do not put a password there. Sign in interactively once:

```bash
.venv-brain/bin/instaloader --login YOUR_INSTAGRAM_USERNAME --login-only
```

Alternatively set `INSTAGRAM_COOKIES_FROM=chrome` or `chrome:/absolute/path/to/Chrome/profile` to import from a locally signed-in Chrome profile the worker user can access and decrypt. This runs only if the Instaloader session file is missing. The worker checks it belongs to `INSTAGRAM_USERNAME` before saving it with mode `0600`; it never logs cookie values. A headless host without access to the browser's keyring should use Instaloader's interactive setup instead.

`INSTAGRAM_SESSION_FILE` overrides the standard Instaloader session path. If you use it, also pass `--sessionfile /absolute/path/to/session` to the interactive login command. Don't use a session file supplied by someone else. If login expires or is challenged, the worker reports `instagram_session`; reauthenticate locally, or remove the stale session file to explicitly reimport from Chrome. Instagram's unofficial saved-feed access can change or be rate limited; the worker does not bypass those restrictions or retry aggressively.

## Verify before scheduling

```bash
.venv-brain/bin/python scripts/brain/daily.py --env-file .env.brain --check
.venv-brain/bin/python scripts/brain/daily.py --env-file .env.brain --force
```

`--check` verifies authenticated reachability at `APP_URL`, FFmpeg, the transcription package, the local Ollama vision model and the Instagram session. It does not claim that a model download or real analysis has completed. The second command performs a real bounded batch. Verify a fresh source-linked Reel note and its ideas at `/brain/reels` and `/brain/ideas` before calling the integration live.

The worker checks the latest 200 saved posts by default. Videos already summarised in the shared vault are skipped. Previously transcribed items can be completed when encountered. Up to 12 unsummarised videos are attempted per batch; failed items retry on a future pass. Raising `BRAIN_SCAN_LIMIT` (up to 5000) allows a historical backfill; raising `BRAIN_MAX_REELS` (up to 100) increases bounded batch work. The run reports deferred items and reaching the scan bound rather than claiming it inspected the entire saved library. Removed/non-video saves do not become fabricated analyses.

## Catch-up and monitoring

An hourly check covers the latest due slot if it was missed or failed. Once that slot succeeds, extra triggers skip before accessing the network. After a longer outage the next check scans the feed once, not once for each elapsed slot. `--force` permits another manual batch. A filesystem lock prevents overlapping local runs. Upload failures retain completed analysis in a durable outbox. Keep `.data/brain-worker` (or `BRAIN_DATA_DIR`) when upgrading. Sampled frames, transcripts and analyses are retained privately under `evidence/<shortcode>`; full videos are temporary. Do not run the legacy analyser alongside this worker.

`/brain` and `/brain/reels` show worker telemetry: not connected, running, failed, stalled (>3h) or overdue (>14h since success), with counters and the latest successful check. The authenticated `/api/brain/status` includes this telemetry. Failure logs contain stage codes, not session cookies, model response bodies or service credentials. Retain a bounded local log history.

Uninstall preserves sessions, outbox, notes, checkpoints and logs. The original `sync-vault.sh` remains available for historical manual file imports; the new daily worker never resets a Git checkout or pushes to `main`.

## Verification

```bash
python3 -m unittest discover -s scripts/brain -p 'test_*.py'
npm exec -- vitest run tests/brain-ingestion.test.ts --fileParallelism=false
npm run typecheck
```

The tests cover real FFmpeg frame extraction from generated media, strict analysis validation, private configuration parsing, local-only inference, SaaS separation, source linking, resumable uploads, duplicate prevention, historical ID preservation, stale-job reporting and the LaunchAgent calendar. Synthetic tests are not proof of authenticated Instagram ingestion or real model output. A live run needs the user's local session and models.
