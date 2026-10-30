# Free hosting with a macOS worker

This deployment puts the Next.js dashboard and short API requests on Netlify, stores application data in Neon, stores artwork in S3-compatible Supabase Storage, and runs pipeline jobs and CPU upscaling on an existing Mac. The Mac connects out to the database and providers. There is no inbound port or home tunnel to configure.

The code and configuration do not provision provider accounts, prove that an account is on a free plan, or remove an existing Railway subscription. This is a migration to verify before retiring the old deployment. Electricity, internet, Etsy fees, POD manufacturing and taxes remain separate costs.

## Architecture and limits

| Component | Role | Free-tier boundary reviewed 30 October 2026 |
| --- | --- | --- |
| Netlify Free | Dashboard, authentication, OAuth callback, webhooks and queue submissions | 300 credits/month, hard stop. Each successful production deploy consumes 15 credits. Requests, compute and bandwidth share the balance. |
| Existing Mac | One worker, UTC schedules, AI calls and Real-ESRGAN | No hosting subscription; capacity, electricity and uptime are the owner's responsibility. |
| Neon Free | Shared application database and durable job queue | 100 CU-hours/project/month, 1 GB Postgres storage. Idle computes scale down; frequent polling keeps them awake. |
| Supabase Free | S3-compatible artwork bucket | 1 GB file storage; transfer and file-size limits also apply. |
| Cloudflare Workers Free | Supported image-generation models | 10,000 Neurons/day shared with other Workers AI usage. Stop at quota; do not upgrade or configure paid fallback automatically. |
| Local Ollama | Listing text and vision assessment | No hosted inference fee. A vision-capable local model, sufficient Mac memory and model licence review are required. |

Sources: [Netlify credits](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/), [credit consumption](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/), [Neon pricing](https://neon.com/pricing), [Supabase pricing](https://supabase.com/pricing), [Supabase S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

These allocations can change. Check the actual plans and usage before migration. A hard quota may stop the application; this design chooses stopping over automatic paid fallback. `FREE_ONLY_MODE` guards inference providers, not the provider's actual subscription or marketplace fees. Vercel Hobby is restricted to personal, non-commercial use and is not the proposed host for this shop.

## 1. Prepare the shared services

1. Export and back up the existing database and artwork. Record the current deployment commit and original object URLs. Keep the existing deployment available during testing, with automation paused to prevent two schedulers.
2. Use a Neon Free project for the shared database. Keep the application's existing shop rows, OAuth tokens, listing IDs, verification evidence and settings when moving data. Do not seed or reset a production database. Run the application's migrations on this database; verify the box queue, stage lease, AI reservation and publish dead-letter tables exist.
3. Create an artwork bucket in a Supabase Free project. Obtain its S3 endpoint, region, bucket name and restricted S3 credentials. Configure the existing `AWS_*` and `S3_*` variables and explicitly set `SUPABASE_STORAGE_PLAN=free`, rather than storing images inside Postgres. Strict free mode permits the verified Supabase HTTPS endpoint shape and refuses other S3 hosts or Vercel Blob. The declaration does not prove the subscription: confirm Free in Supabase's billing dashboard. Test Put/Get, presigned Put, read-back SHA-256, and deletion using a test object before copying production artwork.
4. Copy `.env.free.example` to a private `.env.box`. Copy the existing Etsy/Printify connection credentials from your deployment's secret manager; do not paste them into repository files or chat. Generate new dashboard/cron/upscaler secrets if starting a new deployment. Set the final Netlify origin as `APP_URL` and keep `PUBLISH_MODE=dry-run` on both web and box during migration.

The adapter currently has one bucket/public-base configuration. Leave `S3_PUBLIC_BASE_URL` unset for a private bucket and stable application media proxy. The media paths use unguessable object IDs; a private bucket is not a promise of per-buyer authentication. Serving files through the application consumes Netlify bandwidth. If you explicitly choose a public bucket/base, every object under it is public: do not put buyer/contact data, exports or secrets there. Separate public previews and private buyer originals require a separate storage mapping; changing one variable does not create that separation.

Never store expiring signed download URLs permanently in listings. Keep `S3_URL_MODE=stable`. Uploads may use short-lived presigned URLs. Do not delete old stored artwork merely to fit the free allowance: preserve a local backup and every file still promised by a listing.

## 2. Deploy the web application

1. Connect the repository to a Netlify Free project. Use a deploy preview first; choose the production branch deliberately. `netlify.toml` selects Node 22, the Next build, box execution and free-only mode. Netlify supplies its maintained OpenNext adapter.
2. Configure runtime environment variables in Netlify's dashboard with Functions scope: `AUTOPILOT_EXECUTION=box`, `FREE_ONLY_MODE=true`, `UPSCALER_PULL=on`, `PUBLISH_MODE=dry-run`, `DEMO_MODE=false`, `DATABASE_URL`, `APP_URL`, dashboard/auth/cron secrets, S3 settings, `SUPABASE_STORAGE_PLAN=free` and existing Etsy/Printify settings. Build settings in `netlify.toml` are not a replacement for runtime credentials. Never expose these as `NEXT_PUBLIC_*`. Local model/provider settings belong on the box.
3. Do not set `AUTOPILOT_BOX_WORKER` or `UPSCALER_ROLE=worker` on Netlify. The box worker sets these only in its own process. Web functions must not download models or execute ONNX. Existing manual image operations may be held in box mode; keep the quality and physical-sample gates.
4. Register `https://YOUR-SITE.netlify.app/api/etsy/oauth/callback` with Etsy and set the exact same `ETSY_REDIRECT_URI`. Verify an authenticated read and refresh. Update Printify webhook destinations to the new origin; confirm the signed event maps the same product/listing IDs. Keep public Etsy webhook reception disabled until its signature contract has been separately verified.
5. Sign in and submit a manual stage. It should return a queued job promptly. HTTP 202 means queued, not completed. Follow the saved job and stage logs to success, failure or a held state.

Git integration does not require GitHub Actions to execute production jobs. Public-repository standard Actions runners can provide free CI once the account's existing billing lock is resolved. Do not rely on Actions cron for the new runtime. Avoid production deploys on every experiment: credits also need to cover the dashboard and media traffic.

## 3. Run the worker on the Mac

Use Node.js 22.12 or newer. Clone/check out the reviewed release into a directory that stays on the Mac. Run `npm ci` there. The box needs the CPU ONNX dependency; do not use the web build's traced deployment bundle as the worker installation.

Create the private environment file:

```bash
cp .env.free.example .env.box
chmod 600 .env.box
```

Fill it locally with the shared service settings and box-only provider settings. `LLM_PROVIDER=ollama-local` uses the explicit loopback `OLLAMA_LOCAL_BASE_URL`, not the existing Ollama Cloud provider. Select an installed vision-capable `OLLAMA_LOCAL_MODEL`; set `OLLAMA_LOCAL_VISION_MODEL` if using a different installed vision model. Cloud-forwarding model names are refused. Verify model JSON output and image input with one real draft before running a schedule. Unavailable vision must keep artwork held for review.

Run local configuration checks and one bounded worker pass:

```bash
node --env-file=.env.box scripts/check-free-setup.mjs --role=box
node --env-file=.env.box --import tsx workers/box/worker.ts --once
```

`--once` creates jobs due in the current UTC schedule window and drains the current queue. For an explicit manual test without scheduling other stages:

```bash
node --env-file=.env.box --import tsx workers/box/worker.ts --stage research
```

The worker sets `AUTOPILOT_BOX_WORKER=1`, `UPSCALER_ROLE=worker` and `UPSCALER_PULL=off` in its own process so artwork processing and upscaling run inline on the Mac. Do not run the older `workers/upscaler/pull.ts` at the same time. `BOX_SHOP_ID` can select an explicit local shop UUID; leave unset for the active shop.

Install the per-user background service after the foreground test passes:

```bash
bash deploy/box/install-macos.sh "$PWD/.env.box"
```

The installer runs the checks, sets the environment file to mode 600, generates a LaunchAgent containing file paths rather than secrets, and starts one continuous worker. No `sudo` is needed. It records the currently selected Node executable, including Homebrew or nvm installations. Run the installer again after moving the checkout or replacing that Node installation.

The service starts when this macOS user logs in; it is not a system daemon that runs before login. Keep the Mac powered and connected. `caffeinate -i` prevents idle system sleep while the worker runs; it does not overcome a powered-off Mac or a closed laptop lid. A reboot interrupts a job. Restart recovery holds uncertain work instead of automatically repeating provider writes.

Inspect service state and logs:

```bash
launchctl print "gui/$(id -u)/com.kaiclean.etsy-autopilot"
tail -n 60 "$HOME/Library/Logs/EtsyAutopilot/worker.log"
tail -n 60 "$HOME/Library/Logs/EtsyAutopilot/worker.error.log"
```

Retain a bounded log history locally. Logs should never contain tokens; keep the environment file and database backups private. To stop and uninstall the service while preserving data and environment:

```bash
bash deploy/box/uninstall-macos.sh
```

## 4. Keep usage within the free allocations

`BOX_IDLE_POLL_MS=900000` is the default minimum idle wait of 15 minutes. Manual jobs can therefore wait up to that long. A continuously polling database connection can consume Neon's free compute allowance even with almost no sales. Do not start a second service or an additional cron timer for the same queue. Do not enable persistent pg-boss polling merely to make manual jobs appear instantaneous.

Use the dashboard only when needed; background browser polling and large image downloads count toward usage. Check the provider dashboards after the first day and first week. Set account notifications where available, retain free plans, and avoid auto-recharge or paid AI fallback. The code cannot enforce a quota shared with unrelated projects on the same account.

The queue's durable job ID and stage logs, not a web request's status code, are the source of truth. Repeated schedule slots and manual idempotency keys should resolve to the same queued job. Jobs interrupted after a possible provider write must be inspected against Etsy/Printify before an operator explicitly retries them. A held job is preferable to a duplicate listing or supplier order.

## 5. Verify the migration and roll back safely

- Confirm the reviewed CI checks pass: tests, lint, route type generation/typecheck and Etsy declaration reproduction. Test a real Netlify preview build; local checks do not prove provider deployment success.
- Submit one research job from the dashboard, watch the Mac claim it, and verify the same job's stored outcome. Submit a duplicate key and run two workers briefly in dry-run: only one claim may execute.
- Restart the worker during a dry-run test and verify the interrupted job is held. Inspect its saved logs and explicitly reconcile/retry it. Never test uncertain live writes by clearing holds blindly.
- Generate one artwork, inspect its original and preview, verify stored bytes/hash, create one listing and verify exactly what a buyer receives. Approval and live activation remain human actions. POD still requires the recorded sample.
- Test signed Printify event delivery and read-only receipt sync; ensure the same receipt is not counted twice. Keep `ETSY_WEBHOOK_ENABLED=false` during this rollout.
- Verify backups can be read, quotas are within limits, and the old and new deployments do not both schedule work. Only then pause/retire old Railway services and separately confirm their subscriptions and stored resources in the provider billing UI.

To roll back, stop the LaunchAgent and pause queue submission. Preserve queue records, job holds and all migrated artwork. Restore the previous reviewed application release and its original configuration against the same compatible database; do not drop the additive runtime tables. Re-enable exactly one old scheduler only after checking pending/running jobs and provider resources. Rollback does not undo a live marketplace write or restore deleted files.
