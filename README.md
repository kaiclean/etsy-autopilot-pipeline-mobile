# Etsy Autopilot

Command center for Kai's Etsy shop ("Designed by Kai", Switzerland, CHF), which sells AI-designed digital downloads and print-on-demand (POD) products. It runs a six-stage pipeline (research → design → listing → **your approval** → publish → orders → analytics) on a schedule. You control all of it from a mobile-first, installable dark-mode PWA that also works on desktop.

Everything runs out of the box in **demo mode**: seeded demo data (flagged `is_demo`), mock image and text generation, and dry-run Etsy/Printify adapters. As you add credentials, each piece switches to the real service on its own.

- **Stack:** Next.js 16 (App Router, Turbopack), TypeScript, Tailwind v4, shadcn/ui (Base UI), Drizzle ORM, Postgres (Neon in production, embedded PGlite locally), Recharts, Vitest.
- **Realtime:** Server-Sent Events (`/api/events`) with automatic fallback to 10s polling (`/api/events/poll`). New orders and items awaiting approval raise toasts and web notifications.
- **Safety:** password-protected dashboard, a kill switch that pauses all automation, per-stage pause, daily and monthly AI spend caps, and dry-run publishing by default. Nothing is published without approval in the queue.

---

## Quick start (local, no keys needed)

```bash
npm install
npm run dev            # http://localhost:4317
```

Sign in with the password **`autopilot`**. This dev-only fallback applies when `DASHBOARD_PASSWORD` is unset and is disabled in production.

On first request the app creates an embedded Postgres (PGlite) in `./.data/pglite`, runs migrations, and seeds 30 days of clearly labeled demo data. A **DEMO** badge shows in the header.

Try the whole loop:

1. **Pipeline → Run all.** Research scores about 144 keywords, Design generates placeholder art, and Listing writes titles and tags with fee math.
2. **Queue.** Swipe right to approve, left to reject, or tap to edit title, tags and price. Validation and net margin update live. You get an Undo toast after each decision.
3. **Pipeline → Publish → Run now.** Approved listings are sent to the dry-run Etsy and Printify adapters.
4. **Pipeline → Orders → Run now.** A simulated Etsy receipt arrives, a "New order" toast fires, and POD fulfillment status advances.
5. **Home and Analytics** update without a page refresh.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 4317 |
| `npm run build && npm start` | Production build and server (port 4317) |
| `npm test` | Vitest: fee math, listing validator, auth, end-to-end mock pipeline |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run db:generate` | Generate a new SQL migration after editing `src/db/schema.ts` |
| `npm run db:seed` | Wipe and reseed **demo** rows only (`is_demo = true`) |
| `npm run images:backfill` | Upload inline `data:` images to the configured S3/Blob bucket and rewrite `image_url`. `--dry-run` only counts them. The maintenance cron rewrites at most 10 rows per run when S3 is configured |

To reset local data completely, stop the server and `rm -rf .data`.

---

## Architecture

```
src/
  db/schema.ts            Drizzle tables: keywords, designs, listings, orders, job_runs, events, costs, daily_stats, settings, push_subscriptions, printify_events
  db/index.ts             Neon (DATABASE_URL) or PGlite; runs migrations from ./drizzle, seeds demo data when empty
  lib/fees.ts             Etsy fee engine for a Swiss seller (see "Fee math")
  lib/listing-validator.ts  Etsy title/tag limits, trademark blocklist, required disclosures
  lib/disclosures.ts      AI-use + production-partner disclosure text appended to every description
  lib/niches.ts           The 5 niches from the business plan: seeds, style prompts, product mix, price bands
  adapters/
    image/                ImageProvider: mock | higgsfield | openai | replicate | runpod
    llm/                  LLMProvider: mock (templates) | openai
    etsy/                 EtsyAdapter: dry-run | live (Open API v3, OAuth 2 PKCE, drafts, images, files, receipts, stats)
    printify/             PrintifyAdapter: dry-run | live (upload, create product, publish to Etsy, order status)
  pipeline/
    research.ts design.ts listing.ts publish.ts orders.ts analytics.ts
    runner.ts             runStage(): kill switch, pause, concurrency guard, logs, events
  app/(app)/              Dashboard: Home, Pipeline, Queue, Products, Orders, Analytics, Settings, More
  app/api/                pipeline/[stage]/run, cron/[stage], listings/[id], settings, events (SSE), etsy/oauth/*, push/*, webhooks/printify, media/*
  proxy.ts                Auth gate (Next 16's replacement for middleware.ts)
```

Every stage is a plain async function `(ctx) => summary` that talks to adapters through interfaces. Stages can be triggered by Vercel Cron (`/api/cron/<stage>`), by the Run buttons (server actions), or by `POST /api/pipeline/<stage|all>/run`.

| Stage | Real today | Mock / dry-run fallback |
| --- | --- | --- |
| Research | Seed list, local long-tail modifiers, and `KEYWORD_SEEDS`. Etsy search volume comes from an operator CSV, or `ETSY_DEMAND_SOURCE=fixture` in demo mode only (no etsy.com scraping). `ETSY_API_COMPETITION=true` reads listing counts from Open API v3. Google Trends is tried for 5 keywords per run when no Etsy volume is present. | Seed scores when Trends is blocked and no export is configured |
| Design | Higgsfield / OpenAI Images / Replicate adapters, capped by the daily and monthly AI budget | Demo only: niche-themed placeholder art. A live shop fails the stage until `IMAGE_PROVIDER` is set. |
| Listing | OpenAI JSON writer, then sanitize, validate, and price with the fee engine. Digital galleries are a downscaled render of the real artwork. | Demo only: deterministic niche templates. A live shop fails the stage until `LLM_PROVIDER=openai` and `OPENAI_API_KEY` are set. |
| Approval | Always a human gate: swipe, edit inline, undo | — |
| Publish | Etsy draft plus preview image and delivery file. Printify product create only. Activate and Publish to Etsy are human actions. | Records payloads and returns `dry-…` ids |
| Orders | Etsy `getShopReceipts`, Printify order status | Simulated receipts, fulfillment advances each sync |
| Analytics | Etsy listing `views` / `num_favorers`, rollups, ads budget booking | Simulated view growth |

### Fee math (business plan §6)

`src/lib/fees.ts` uses USD 0.20 listing fee (at 0.8278 CHF/USD), 6.5% transaction, 4% + CHF 0.50 processing, 8.1% VAT on those fees, and an optional 15% Offsite Ads fee. POD base and shipping cost are subtracted too. Rounding happens only at the output, so results reconcile with the plan:

- A digital download at CHF 8.00 nets **CHF 6.37** (79.7%), or **CHF 5.17** if the sale is attributed to Offsite Ads.
- A POD A3 poster at CHF 29.00 (Printful USD 10.90 + 4.99) nets **CHF 11.84** (40.8%), or **CHF 7.49** with Offsite Ads.

`suggestPrice()` prices in CHF (`.90` retail rounding). Margins are per product type, set in Settings:

- **Print-on-demand** targets **30%** net (clamped to 25–35%). A competitor anchor in CHF (mug 19.90, A3 poster 24.90) wins when it is lower than the margin price and still clears print cost, so listings are not pinned to the niche ceiling.
- **Digital downloads** target **75%** or more. Niche floors still apply. Offsite Ads makes 75% unreachable (fees approach ~26%), so those prices stay on the floor instead of the cap.

Before this change a global 55% target, with Offsite Ads on, solved near CHF 54 (mug) and CHF 74 (poster) and then clamped to the band max: mugs CHF 49.90 and gothic posters CHF 44.90. At the 30% default, the same products land in the competitive bands (mug about CHF 15–25, poster about CHF 18–33). Covered in `tests/fees.test.ts`.

Digital publish uploads **one PNG**. Listing copy says that. It does not promise a 300 DPI pack in 2:3, 3:4, 4:5, 11x14, and ISO A, or an editable template. Those exports are not generated yet. POD queue images use a template mockup at `/api/mockup/{preset}`; the print file stays the design artwork.

### Listing validator

`src/lib/listing-validator.ts` checks:

- The title is 140 characters or fewer, with at most 3 all-caps words, allowed characters only, and each of `% : &` used at most once.
- There are **exactly 13** unique tags, each 20 characters or fewer, using only letters, numbers, spaces, `-` and `'`.
- No terms from the trademark blocklist appear.
- The AI disclosure is present, plus the production-partner disclosure for POD.
- The price is at least CHF 0.20.

Invalid listings can't be approved or published. `tests/listing-validator.test.ts` covers the boundaries (140 vs 141 characters, 12, 13 and 14 tags, 20 vs 21-character tags, duplicates, trademarks, missing disclosures).

---

## Environment variables

All configuration comes from environment variables. See [`.env.example`](.env.example) for the full annotated list. Secrets are never stored in the database or shown in the UI.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DASHBOARD_PASSWORD` | prod | Dashboard password |
| `AUTH_SECRET` | prod | Signs session cookies (`openssl rand -base64 32`) |
| `CRON_SECRET` | prod | Protects `/api/cron/*` (Vercel sends it automatically) |
| `DATABASE_URL` | prod | Neon Postgres connection string. Embedded PGlite is used when empty. |
| `APP_URL` | live publish | Public base URL, used for absolute image URLs, `/api/media`, and the Printify callback |
| `DEMO_MODE` | — | `true`/`false` to force. Default: on until Etsy keys exist. |
| `PUBLISH_MODE` | — | Leave `dry-run`. The dashboard Go live control is the switch. Webhooks and image storage do not turn publishing on. |
| `ETSY_API_KEY`, `ETSY_SHARED_SECRET`, `ETSY_SHOP_ID`, `ETSY_REDIRECT_URI` | live Etsy | Etsy Open API v3 app |
| `PRINTIFY_API_TOKEN`, `PRINTIFY_SHOP_ID`, `PRINTIFY_BLUEPRINT_ID`, `PRINTIFY_PRINT_PROVIDER_ID`, `PRINTIFY_VARIANT_IDS` | live POD | Printify API |
| `PRINTIFY_WEBHOOK_SECRET` | production webhooks | HMAC secret you send as `secret` when creating Printify webhooks. Callback: `POST $APP_URL/api/webhooks/printify` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | background push | Web Push keys. `npm run vapid:generate`. Subject is `mailto:you@example.com`. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `S3_BUCKET` | stored art | S3-compatible upload (Railway, AWS, R2). Optional `S3_PUBLIC_BASE_URL`, `S3_URL_MODE`, `S3_FORCE_PATH_STYLE`. |
| `BLOB_READ_WRITE_TOKEN` | stored art | Vercel Blob, used only when the S3 variables are not all set. |
| `IMAGE_PROVIDER` + `HIGGSFIELD_API_KEY` / `HIGGSFIELD_API_SECRET`, or `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`, `OPENAI_IMAGE_MODEL`), or `REPLICATE_API_TOKEN` | real art | Image generation (OpenAI or OpenRouter) |
| `LLM_PROVIDER=openai` + `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`, `OPENAI_MODEL`) | real copy | Listing writer (OpenAI or OpenRouter) |

---

## Deploy to Vercel + Neon

1. **Create the database.** In Vercel, go to Storage → Create → **Neon Postgres** and connect it to the project. This sets `DATABASE_URL`. You can also create a project at [neon.tech](https://neon.tech) and paste the pooled connection string.
2. **Import the repository** in Vercel. The Next.js framework preset is detected and no build settings need to change.
3. **Add environment variables:** `DASHBOARD_PASSWORD`, `AUTH_SECRET`, `CRON_SECRET`, and `APP_URL=https://<your-domain>`. Add the provider keys when you have them.
4. **Deploy.** On the first request the app runs the migrations in `./drizzle` against Neon. If Etsy keys are missing or `DEMO_MODE=true`, it also seeds demo data.
5. **Cron.** `vercel.json` schedules each stage once a day (UTC), which works on the Hobby plan. On Pro you can tighten it, for example `orders` every 30 minutes (`*/30 * * * *`) and `publish` every 2 hours. Keep `DEFAULT_STAGES` in `src/lib/settings.ts` in sync so the dashboard shows the right schedule. Railway has no built-in cron. `.github/workflows/autopilot-cron.yml` hits the same UTC times from the default branch. After merge, set GitHub repository secrets once: `CRON_SECRET` (the same value as Railway) and optional `AUTOPILOT_URL` (defaults to `https://etsy-autopilot-production-8b9f.up.railway.app`). Do not commit either value. You can also call `GET /api/cron/<stage>` yourself with `Authorization: Bearer $CRON_SECRET`. `maintenance` runs daily at 04:17 UTC and also at the end of the orders cron. It registers missing Printify webhooks, rewrites up to 10 inline images when S3 is set, and deletes fake orders while demo mode is off. Schedules do not change the dry-run publish choice.
6. **Install on your phone.** Open the URL in Safari (iOS), tap Share → **Add to Home Screen**, then enable notifications in Settings. On Android, Chrome shows "Install app".

> Without `DATABASE_URL`, Vercel falls back to PGlite in `/tmp`. That is fine for a preview but gets wiped on every cold start. Use Neon for anything real.

---

## Getting API credentials

### Etsy Open API v3

1. Open your shop first. Swiss sellers are supported and get payouts in CHF.
2. Go to <https://www.etsy.com/developers/your-apps> → **Create a new app**. Describe it as a personal tool for your own shop, for example "Manage my own shop's listings and orders".
3. Copy the **Keystring** into `ETSY_API_KEY` and the **Shared secret** into `ETSY_SHARED_SECRET`.
4. Register a callback URL such as `https://<your-domain>/api/etsy/oauth/callback` (and `http://localhost:4317/api/etsy/oauth/callback` for local testing), and set `ETSY_REDIRECT_URI` to match it exactly.
5. New apps start with personal access, which is enough for your own shop. Commercial access is only needed for other people's shops.
6. Deploy, then go to **Settings → Connect Etsy shop**. That runs OAuth 2 with PKCE (scopes `listings_r listings_w transactions_r shops_r`) and stores the refreshable token in the `settings` table.
7. Set `ETSY_SHOP_ID`. After connecting, the numeric user id is the prefix of the access token, and `GET /v3/application/users/{user_id}/shops` returns the shop id.
8. Optionally pick seller taxonomy ids (`GET /v3/application/seller-taxonomy/nodes`) for `ETSY_TAXONOMY_ID_DIGITAL` / `_POSTER`.
9. Leave `PUBLISH_MODE=dry-run`. When a dry-run looks right, open **Connections → Go live**, check the box, and type `CONFIRM`. That arms writes. Live digital publishing creates **drafts only**. There is no `ETSY_ACTIVATE` flag. A listing becomes active only when a human has recorded the delivery file (filename, pixel size, bytes, hash), marked that file verified, and clicked **Activate** on that listing. The cron never activates.

### Printify

1. Create a Printify account and connect it to your Etsy shop (Printify → My stores → Add → Etsy).
2. Go to Account → Connections → **Generate API token** with scopes shops, catalog, products, uploads and orders, and set `PRINTIFY_API_TOKEN`.
3. `curl -H "Authorization: Bearer $PRINTIFY_API_TOKEN" https://api.printify.com/v1/shops.json` returns the id of your Etsy-connected shop. Set it as `PRINTIFY_SHOP_ID`.
4. Choose a product template:
   - `GET /v1/catalog/blueprints.json` gives the blueprint (for example a matte poster) → `PRINTIFY_BLUEPRINT_ID`.
   - `GET /v1/catalog/blueprints/{id}/print_providers.json` → `PRINTIFY_PRINT_PROVIDER_ID`.
   - `GET /v1/catalog/blueprints/{id}/print_providers/{pid}/variants.json` → comma-separated `PRINTIFY_VARIANT_IDS`.
5. In Etsy, set Printify as a **production partner** (Shop Manager → Settings → Production partners) with the correct ship-from location.
   The publish run **creates** the Printify product and stops. It does not call Printify `publish.json`. Publishing that product to Etsy is a per-listing button. It stays blocked until you record a physical sample for that blueprint id + print provider id (Products → the listing → Record sample). Live creation does not auto-pick a provider: `PRINTIFY_BLUEPRINT_ID`, `PRINTIFY_PRINT_PROVIDER_ID` and `PRINTIFY_VARIANT_IDS` are required, and they are the only blueprint that live products use. Order a sample of that pair before you record it.
6. Point webhooks at `POST https://<your-domain>/api/webhooks/printify`. Topics: `order:created`, `order:updated`, `order:sent-to-production`, `order:shipment:created`, `order:shipment:delivered`, `product:publish:started`, `product:publish:succeeded`. The daily maintenance cron registers any topic that is not already aimed at that URL, using `PRINTIFY_WEBHOOK_SECRET` as the webhook `secret`. It skips that step in dry-run or demo mode, and when the Printify env vars are missing. Printify signs the raw body as `sha256=<hmac>` in `x-pfy-signature`. The handler stores the event once, strips buyer contact fields, and when the ids match a local row it records the Etsy listing id and Printify order id. It does not call Printify or Etsy, so it is safe while `PUBLISH_MODE=dry-run`. Production rejects unsigned deliveries.

The cron creates the Printify product and sets status `pod_created`. That row is not on Etsy yet, so the orders stage does not poll it and does not alert on it. **Publish to Etsy** is the human step. After Printify accepts that publish, the row becomes `publishing` (dashboard: “Awaiting Etsy id”) until `external.id` exists. The orders stage then polls `GET /v1/shops/{shop_id}/products/{product_id}.json` and writes that id; the webhook still does the same write. A numeric id promotes the row to `published`. Receipts for an Etsy listing id the pipeline does not know yet are stored as unmatched and linked when the id arrives. After 24 hours in `publishing` the orders stage emits `listing.awaiting_etsy_id` once per listing (also a push when failed-job notifications are on). The wait starts at `pod_published_at`.

No new environment variables. The poll and the backfill fetch use `PRINTIFY_API_TOKEN` and `PRINTIFY_SHOP_ID`. `PRINTIFY_WEBHOOK_SECRET` is still only for the webhook.

Backfill (migration `0004` does the same status rewrite on startup):

- legacy `published` POD rows with a null Etsy id become `publishing`
- `pod_created` rows that already have `pod_published_at` and a null Etsy id become `publishing`
- `pod_created` rows that have not been sent to Etsy stay `pod_created`

```bash
npm run backfill:etsy-ids                 # status only, no network
npm run backfill:etsy-ids -- --fetch      # GET each Printify product; does not publish
```

`--fetch` refuses to run unless both Printify variables are set.

### Web Push

The service worker already shows `{ title, body, url }` payloads. To deliver them while the PWA is closed:

1. Run `npm run vapid:generate` and put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (`mailto:…`) in the server environment. Do not commit them.
2. Open **Settings** and enable notifications. The browser subscribes and `POST /api/push/subscribe` stores the endpoint. Use **Send test** to confirm.
3. Sales (`order.new`), listings awaiting approval (`approval.pending`), and failed jobs or publishes send a push. If VAPID is missing, Settings says so and in-app toasts still work. Expired subscriptions (HTTP 404/410) are deleted.

### Image storage

OpenAI, Higgsfield, Replicate, and the mock adapter pass generated bytes through object storage before the URL is saved:

- **S3 (preferred on Railway):** set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` (or `AWS_ENDPOINT_URL`), `AWS_REGION`, and `S3_BUCKET` (also accepts `AWS_S3_BUCKET_NAME`). With `S3_PUBLIC_BASE_URL`, that public URL is stored. Otherwise the database stores `$APP_URL/api/media/designs/…`, which streams the private object. `S3_URL_MODE=signed` stores a 7-day presigned URL instead.
- **Vercel Blob:** set `BLOB_READ_WRITE_TOKEN` only when S3 is not configured. Blob's public URL is stored.
- With neither, the design stage refuses the image and leaves the keyword unselected so it can be retried after storage is configured. Storage does not change the publish choice. Leave `PUBLISH_MODE=dry-run` and arm writes from Connections.

Neon’s HTTP driver rejects any result larger than 64 MB. Orders joins each receipt to `listings.image_url`, and a digital gallery URL used to embed the full `data:` artwork in `src`, so a few hundred rows exceeded that cap while the page still returned HTTP 200. Orders, analytics, products, queue, and the home review strip now select a compact URL: a normal http(s) or app path is kept, an oversized `/api/preview` drops `src`, and a raw `data:` value becomes a niche preview. The orders and analytics stages also skip the image columns.

Images already saved as `data:` (or as a preview URL that contains one) stay in the table until you rewrite them:

```bash
npm run images:backfill -- --dry-run   # counts rows and bytes, no uploads
npm run images:backfill                # uploads via the existing S3 or Blob env, then updates image_url
```

The script reads `DATABASE_URL` and the storage variables above. It does not add new secrets. Each image is loaded on its own, in chunks, so the backfill itself stays under the 64 MB cap. The same bytes are uploaded once. A gallery that was the same data URL as its delivery file is saved as `/api/preview?…&src=<stored url>` so the preview and the buyer file stay different. `/api/cron/maintenance` rewrites at most 10 of those rows per run when S3 is configured, so the work happens on Railway without copying secrets out. The CLI still processes every row when you already have the environment locally.

### Higgsfield / OpenAI / Replicate / RunPod

- **Higgsfield:** create API credentials on your Higgsfield account, then set `IMAGE_PROVIDER=higgsfield`, `HIGGSFIELD_API_KEY` and `HIGGSFIELD_API_SECRET`. The adapter uses submit-then-poll. Its endpoint paths are configurable (`HIGGSFIELD_API_BASE`, `HIGGSFIELD_TEXT2IMAGE_PATH`) because the public API surface changes, so **verify them against your account's API docs**. Free-plan images are watermarked; you need a paid plan for sellable files.
- **OpenAI / OpenRouter:** set `OPENAI_API_KEY`, then `LLM_PROVIDER=openai` for listing copy and/or `IMAGE_PROVIDER=openai` for art. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. Point it at `https://openrouter.ai/api/v1` and use an OpenRouter key to call OpenRouter the same way. Chat model is `OPENAI_MODEL`; image model is `OPENAI_IMAGE_MODEL` (OpenRouter example: `google/gemini-2.5-flash-image`).
- **Replicate:** set `IMAGE_PROVIDER=replicate` and `REPLICATE_API_TOKEN`. The default model is flux-schnell.
- **RunPod Serverless ComfyUI:** set `IMAGE_PROVIDER=runpod`, `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, and `RUNPOD_COMFY_WORKFLOW`. Use ComfyUI's **Export for API** JSON as the workflow. Replace the positive prompt input with `{{PROMPT}}`; optionally add `{{SEED}}`, `{{WIDTH}}`, and `{{HEIGHT}}` to workflow inputs. The adapter submits to `/run`, polls `/status/<job id>`, accepts RunPod worker base64 or S3 URL output, and passes generated bytes through configured image storage. Set `RUNPOD_COST_PER_IMAGE_CHF` to your estimated image cost for budget-cap accounting. Keep the API key in deployment secrets, never in source control. Connections → Test connection submits a real generation using the configured workflow and may incur GPU charges.

---

## What still needs a human

These can't be automated through Etsy's APIs today, per the business plan §7:

- **The per-listing "How it's made" / AI-tools disclosure field.** The API doesn't expose it (etsy/open-api discussion #1630). After a draft exists, open it in Shop Manager and set the field. Activation in this app is separate: verify the delivery file, then click Activate on that listing. The disclosure *text* is added to every description automatically.
- **Digital file check.** Open the real PNG (not the gallery preview). Products → Read delivery file stores the filename, pixel size, bytes and hash. **I opened this file** records that you did. Activate stays disabled until both exist, and it is refused while the image provider is the mock placeholder.
- **POD sample.** For each blueprint + print provider you intend to sell, order a physical sample and record it on the listing. Publish to Etsy stays disabled without that row.
- **Buyer messages.** Etsy has no messaging API (discussion #677). Use saved replies in the Etsy app.
- **Etsy Ads.** There is no Ads API. Set the daily budget in Etsy, and mirror it under Settings → "Etsy Ads daily budget" with "Etsy Ads running" switched on so profit accounts for it.
- IP/trademark judgment (the blocklist catches obvious terms only), sample quality checks, disputes, account verification, and taxes (AHV, income tax).
- Production-partner settings in Etsy, and the Printify ↔ Etsy store connection.

## Security notes

- Every route except `/login`, `/offline`, the manifest, the icons, `sw.js`, `/api/cron/*`, `/api/media/*`, and `POST /api/webhooks/printify` requires a signed, httpOnly session cookie (HMAC-SHA256, 30 days). Cron routes require `CRON_SECRET`. The Printify callback checks `x-pfy-signature` when `PRINTIFY_WEBHOOK_SECRET` is set, and production refuses the call when that secret is missing. Media keys are unguessable object ids, not a directory listing.
- Server actions re-check the session.
- Production refuses to start a session if `DASHBOARD_PASSWORD` or `AUTH_SECRET` is missing.
- In live mode, rows flagged `is_demo` are hidden everywhere. `npm run db:seed` touches only those rows.

## Next steps

- Leave `PUBLISH_MODE=dry-run`. Arm live writes from Connections → Go live after the checkbox and `CONFIRM`. Digital drafts are never auto-activated. POD products are not published to Etsy until you record a sample and click Publish to Etsy on that listing.
- After a live Printify publish, confirm a webhook row links `printify_product_id` to the Etsy listing id before relying on order sync.
