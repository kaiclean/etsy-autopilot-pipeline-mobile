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
    image/                ImageProvider: mock | higgsfield | openai | replicate
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
| Research | Seed list from the plan plus long-tail expansion and `KEYWORD_SEEDS`. Google Trends (unofficial) is tried for 5 keywords per run. | Seed scores when Trends is rate-limited |
| Design | Higgsfield / OpenAI Images / Replicate adapters, capped by the daily and monthly AI budget | Niche-themed SVG placeholder art stamped "MOCK ART" |
| Listing | OpenAI JSON writer, then sanitize, validate, and price with the fee engine | Deterministic niche templates |
| Approval | Always a human gate: swipe, edit inline, undo | — |
| Publish | Etsy `createDraftListing` plus image and file upload. Printify create + publish. | Records payloads and returns `dry-…` ids |
| Orders | Etsy `getShopReceipts`, Printify order status | Simulated receipts, fulfillment advances each sync |
| Analytics | Etsy listing `views` / `num_favorers`, rollups, ads budget booking | Simulated view growth |

### Fee math (business plan §6)

`src/lib/fees.ts` uses USD 0.20 listing fee (at 0.8278 CHF/USD), 6.5% transaction, 4% + CHF 0.50 processing, 8.1% VAT on those fees, and an optional 15% Offsite Ads fee. POD base and shipping cost are subtracted too. Rounding happens only at the output, so results reconcile with the plan:

- A digital download at CHF 8.00 nets **CHF 6.37** (79.7%), or **CHF 5.17** if the sale is attributed to Offsite Ads.
- A POD A3 poster at CHF 29.00 (Printful USD 10.90 + 4.99) nets **CHF 11.84** (40.8%), or **CHF 7.49** with Offsite Ads.

`suggestPrice()` solves for the lowest `.90` retail price that reaches the target margin you set in Settings, bounded by each niche's price band. All of this is covered in `tests/fees.test.ts`.

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
5. **Cron.** `vercel.json` schedules each stage once a day (UTC), which works on the Hobby plan. On Pro you can tighten it, for example `orders` every 30 minutes (`*/30 * * * *`) and `publish` every 2 hours. Keep `DEFAULT_STAGES` in `src/lib/settings.ts` in sync so the dashboard shows the right schedule. Railway has no built-in cron. `.github/workflows/autopilot-cron.yml` hits the same UTC times from the default branch. After merge, set GitHub repository secrets once: `CRON_SECRET` (the same value as Railway) and optional `AUTOPILOT_URL` (defaults to `https://etsy-autopilot-production-8b9f.up.railway.app`). Do not commit either value. You can also call `GET /api/cron/<stage>` yourself with `Authorization: Bearer $CRON_SECRET`. Schedules do not change the dry-run publish choice.
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
9. Leave `PUBLISH_MODE=dry-run`. When a dry-run looks right, open **Connections → Go live**, check the box, and type `CONFIRM`. That arms writes. Live publishing still creates **drafts**, never active listings, unless `ETSY_ACTIVATE=true`.

### Printify

1. Create a Printify account and connect it to your Etsy shop (Printify → My stores → Add → Etsy).
2. Go to Account → Connections → **Generate API token** with scopes shops, catalog, products, uploads and orders, and set `PRINTIFY_API_TOKEN`.
3. `curl -H "Authorization: Bearer $PRINTIFY_API_TOKEN" https://api.printify.com/v1/shops.json` returns the id of your Etsy-connected shop. Set it as `PRINTIFY_SHOP_ID`.
4. Choose a product template:
   - `GET /v1/catalog/blueprints.json` gives the blueprint (for example a matte poster) → `PRINTIFY_BLUEPRINT_ID`.
   - `GET /v1/catalog/blueprints/{id}/print_providers.json` → `PRINTIFY_PRINT_PROVIDER_ID`.
   - `GET /v1/catalog/blueprints/{id}/print_providers/{pid}/variants.json` → comma-separated `PRINTIFY_VARIANT_IDS`.
5. In Etsy, set Printify as a **production partner** (Shop Manager → Settings → Production partners) with the correct ship-from location.
6. Point webhooks at `POST https://<your-domain>/api/webhooks/printify`. Create one webhook per topic (`order:created`, `order:updated`, `order:sent-to-production`, `order:shipment:created`, `order:shipment:delivered`, `product:publish:started`) with the same URL and `"secret": "<PRINTIFY_WEBHOOK_SECRET>"`. Printify signs the raw body as `sha256=<hmac>` in `x-pfy-signature`. The handler stores the event once, strips buyer contact fields, and when the ids match a local row it records the Etsy listing id and Printify order id. It does not call Printify or Etsy, so it is safe while `PUBLISH_MODE=dry-run`. Production rejects unsigned deliveries.

### Web Push

The service worker already shows `{ title, body, url }` payloads. To deliver them while the PWA is closed:

1. Run `npm run vapid:generate` and put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (`mailto:…`) in the server environment. Do not commit them.
2. Open **Settings** and enable notifications. The browser subscribes and `POST /api/push/subscribe` stores the endpoint. Use **Send test** to confirm.
3. Sales (`order.new`), listings awaiting approval (`approval.pending`), and failed jobs or publishes send a push. If VAPID is missing, Settings says so and in-app toasts still work. Expired subscriptions (HTTP 404/410) are deleted.

### Image storage

OpenAI, Higgsfield, Replicate, and the mock adapter pass generated bytes through object storage before the URL is saved:

- **S3 (preferred on Railway):** set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` (or `AWS_ENDPOINT_URL`), `AWS_REGION`, and `S3_BUCKET` (also accepts `AWS_S3_BUCKET_NAME`). With `S3_PUBLIC_BASE_URL`, that public URL is stored. Otherwise the database stores `$APP_URL/api/media/designs/…`, which streams the private object. `S3_URL_MODE=signed` stores a 7-day presigned URL instead.
- **Vercel Blob:** set `BLOB_READ_WRITE_TOKEN` only when S3 is not configured. Blob's public URL is stored.
- With neither, data URLs are kept and the design log warns. Storage does not change the publish choice. Leave `PUBLISH_MODE=dry-run` and arm writes from Connections.

### Higgsfield / OpenAI / Replicate

- **Higgsfield:** create API credentials on your Higgsfield account, then set `IMAGE_PROVIDER=higgsfield`, `HIGGSFIELD_API_KEY` and `HIGGSFIELD_API_SECRET`. The adapter uses submit-then-poll. Its endpoint paths are configurable (`HIGGSFIELD_API_BASE`, `HIGGSFIELD_TEXT2IMAGE_PATH`) because the public API surface changes, so **verify them against your account's API docs**. Free-plan images are watermarked; you need a paid plan for sellable files.
- **OpenAI / OpenRouter:** set `OPENAI_API_KEY`, then `LLM_PROVIDER=openai` for listing copy and/or `IMAGE_PROVIDER=openai` for art. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. Point it at `https://openrouter.ai/api/v1` and use an OpenRouter key to call OpenRouter the same way. Chat model is `OPENAI_MODEL`; image model is `OPENAI_IMAGE_MODEL` (OpenRouter example: `google/gemini-2.5-flash-image`).
- **Replicate:** set `IMAGE_PROVIDER=replicate` and `REPLICATE_API_TOKEN`. The default model is flux-schnell.

---

## What still needs a human

These can't be automated through Etsy's APIs today, per the business plan §7:

- **The per-listing "How it's made" / AI-tools disclosure field.** The API doesn't expose it (etsy/open-api discussion #1630). After a live publish, open each draft in Shop Manager, set the field, and activate the listing. The Products view shows this reminder on every live listing. The disclosure *text* is added to every description automatically.
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

- Leave `PUBLISH_MODE=dry-run`. Arm live writes from Connections → Go live after the checkbox and `CONFIRM`. Live Etsy publishes stay drafts unless `ETSY_ACTIVATE=true`.
- After a live Printify publish, confirm a webhook row links `printify_product_id` to the Etsy listing id before relying on order sync.
