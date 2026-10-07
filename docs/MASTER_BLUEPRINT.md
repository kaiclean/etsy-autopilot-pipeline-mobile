# Etsy Autopilot — Master Blueprint

Dashboard upgrade, multi-shop support, and custom shop setup.

This document is the single plan for taking Etsy Autopilot from a one-shop command center (env-var configured, five hardcoded niches) to a multi-shop operator console where each shop is added, configured, tested, and armed from the dashboard. It is grounded in the code as it exists today; every section names the files it affects.

Status: proposal. Nothing in this document is implemented yet. Phases are ordered by dependency, not by calendar time.

---

## 1. Goals and non-goals

### Goals

1. **Add and set up new shops from the dashboard.** A guided wizard creates a shop, captures marketplace and POD credentials, picks niches and product templates, sets budgets and schedules, and finishes with a dry-run smoke test. No redeploy, no editing Railway variables.
2. **Run the existing six-stage pipeline per shop.** Research → design → listing → approval → publish → orders → analytics, each scoped to one shop, with the same safety gates (kill switch, dry-run default, CONFIRM to go live, spend caps).
3. **Upgrade the dashboard** with a shop switcher, a cross-shop portfolio view, per-shop pages, and a restructured Settings area that separates app-level settings from shop-level settings.
4. **Make niches, product templates, pricing rules, and disclosures editable data** instead of TypeScript constants, so each shop can have its own catalog without a code change.
5. **Keep every current safety property.** Secret values are never rendered. Dry-run is the default. Live writes require the CONFIRM gate. Demo rows stay flagged and hidden in live mode. Nothing publishes without approval in the queue.
6. **Keep the single-shop path working unchanged.** A deployment with only the current env vars must behave exactly as it does today after every phase.

### Non-goals (for this blueprint)

- Multi-user accounts, roles, or team permissions. The dashboard stays single-operator with one password. An audit log is in scope; authn/authz redesign is not.
- Replacing Etsy as the primary marketplace. Additional marketplaces (Gumroad, Payhip, KDP) are stretch items with adapter seams reserved, not committed work.
- Mobile native apps. The PWA remains the mobile surface.

---

## 2. Current state (audit)

### 2.1 What exists

| Area | Where | Notes |
| --- | --- | --- |
| Config | `src/lib/config.ts` | Getters over `process.env`. One Etsy shop (`ETSY_SHOP_ID`), one Printify shop, one image provider, one LLM provider. `isDemoMode()` is true until Etsy keys exist. |
| Settings | `src/lib/settings.ts`, table `settings` | Key/value singleton: `automation`, `stages`, `etsyTokens`, `pushPrefs`. No shop dimension. |
| Schema | `src/db/schema.ts` | `keywords`, `designs`, `listings`, `orders`, `job_runs`, `events`, `costs`, `daily_stats`, `settings`, `push_subscriptions`, `printify_events`. Every data table has `is_demo`; none has `shop_id`. `keywords.phrase` and `orders.etsy_receipt_id` are globally unique. |
| Niches | `src/lib/niches.ts` | `Niche` is a 5-member string union. `NICHES` holds seeds, style prompt, product mix, price band, peak months. Used by research, design, listing, seed, queue filters, analytics chart. |
| Fees | `src/lib/fees.ts` | `FEES` constants for a Swiss CHF seller. `POD_PRESETS` (4 presets, USD base + shipping). Verified against the business plan §6 in `tests/fees.test.ts`. |
| Pipeline | `src/pipeline/*.ts`, `runner.ts` | Stages are `(ctx) => Promise<string>` with `StageContext { db, trigger, random, now, log }`. Runner handles kill switch, pause, 5-minute concurrency guard, logs, events. |
| Adapters | `src/adapters/{etsy,printify,image,llm}` | Factories read `config` globals: `getEtsyAdapter(db)`, `getPrintifyAdapter({db})`, `getImageProvider()`, `getLLMProvider()`. Live vs dry-run decided by `readPublishMode(db)` plus credential presence. |
| OAuth | `src/adapters/etsy/oauth.ts`, `src/app/api/etsy/oauth/*` | PKCE flow; tokens saved to `settings.etsyTokens`; callback redirects to `/settings?etsy=…`. |
| Cron | `src/app/api/cron/[stage]/route.ts`, `vercel.json`, `.github/workflows/autopilot-cron.yml` | One schedule per stage, one pipeline. |
| Health & setup | `src/lib/health.ts`, `src/lib/setup-guide.ts`, `src/lib/next-actions.ts` | Env-var presence checks. Never returns values. Drives Connections, Home attention list, and the copyable checklist. |
| UI | `src/app/(app)/*`, `src/components/*` | Home, Pipeline, Queue (swipe/keyboard/bulk), Products, Orders, Analytics, Connections, Settings, More. Sidebar on desktop, 5-tab bar on mobile. SSE with polling fallback. Web Push. |
| Demo | `src/db/seed.ts` | Seeds 30 days of `is_demo=true` rows on an empty DB in demo mode. `clearDemo` and `npm run db:seed`. |
| Tests | `tests/*.test.ts` (86 tests) | Fee math, validator, auth, health, publish mode, operator mode, OpenAI/OpenRouter adapters, dashboard fixes, and an in-memory PGlite end-to-end pipeline run. |

### 2.2 Constraints that shape the design

1. **Secrets policy.** README and UI copy promise "Secrets are never stored in the database or shown in the UI." Adding shops from the UI requires storing per-shop credentials somewhere the server can read at runtime. This blueprint keeps the "never shown" half and relaxes the "never stored" half with an encrypted vault (§3.4). This is the one deliberate policy change and must be called out in README.
2. **`Niche` is a type.** Changing it to a data-driven string touches ~20 files (anything importing `NICHES` or the `Niche` type). It is the largest refactor and is isolated in its own phase.
3. **Global uniqueness.** `keywords.phrase` unique and `orders.etsy_receipt_id` unique must become `(shop_id, …)` composites, otherwise two shops cannot research the same phrase.
4. **Adapters read globals.** Every factory must take a shop context instead of reading `config` directly. The interfaces (`EtsyAdapter`, `PrintifyAdapter`, `ImageProvider`, `LLMProvider`) already isolate callers, so this is a factory-level change.
5. **`isDemoMode()` is global.** Demo must become a shop attribute so a seeded demo shop can coexist with a real one.
6. **Two databases.** PGlite locally, Neon in production, both via Drizzle migrations in `./drizzle`. Every migration must run on both; migrations with backfills must be idempotent.
7. **Mobile-first PWA.** New navigation (shop switcher, Shops area) must fit the 5-tab mobile bar and the `w-64` sidebar in `src/components/app-shell.tsx`.

---

## 3. Target architecture

### 3.1 Domain model

New tables (Drizzle, `src/db/schema.ts`):

```ts
shops            id, slug (unique), name, marketplace ("etsy"), marketplace_shop_id,
                 country ("CH"), currency ("CHF"), color, status ("draft"|"active"|"paused"|"archived"),
                 is_demo, publish_mode ("dry-run"|"live"), kill_switch, created_at, updated_at

shop_secrets     id, shop_id, provider ("etsy"|"printify"|"openai"|"higgsfield"|"replicate"),
                 key ("api_key"|"shared_secret"|"token"|…), ciphertext, iv, tag, fingerprint,
                 updated_at          — unique(shop_id, provider, key)

shop_settings    shop_id, key, value jsonb, updated_at        — pk(shop_id, key)
                 keys: automation, stages, etsyTokens, pushPrefs, providers, disclosures, feeProfile

niches           id, shop_id, slug, label, short, color, peak_months jsonb, product_mix jsonb,
                 price_band jsonb, style, seeds jsonb, enabled, sort_order — unique(shop_id, slug)

pod_presets      id, shop_id, key, label, provider ("printify"), base_usd, shipping_usd,
                 blueprint_id, print_provider_id, variant_ids jsonb, enabled — unique(shop_id, key)

audit_log        id, shop_id (nullable), action, target, meta jsonb, created_at
```

Existing tables gain `shop_id integer not null references shops(id)`:
`keywords`, `designs`, `listings`, `orders`, `job_runs`, `events`, `costs`, `daily_stats`, `printify_events`.
`push_subscriptions` stays global (a device, not a shop); routing is handled by `pushPrefs` per shop.

Uniqueness changes:
- `keywords.phrase` unique → `unique(shop_id, phrase)`
- `orders.etsy_receipt_id` unique → `unique(shop_id, etsy_receipt_id)`
- `daily_stats` → `unique(shop_id, date)`

`listings.niche` and `keywords.niche` keep the column name but become `text` referencing `niches.slug` by convention (not FK, so seeds and imports stay simple). The `Niche` TypeScript union becomes `string`.

### 3.2 Shop context resolution

Keep today's URLs. The active shop is a server-side concept:

- **Dashboard pages:** `getActiveShop()` reads an `ea_shop` cookie (slug), falls back to the first active shop, and exposes `{ shop, allShops }`. A special value `all` enables the portfolio mode on Home, Queue, Products, Orders, Analytics.
- **API routes:** accept `?shop=<slug>` or header `x-shop`. Missing means the default shop (slug `default`). `shop=all` is accepted only by cron and pipeline routes.
- **Server actions:** receive `shopId` explicitly from the form/component. No hidden state.
- **Cron:** `/api/cron/[stage]?shop=all` iterates active shops in sequence; `?shop=<slug>` runs one. Existing schedules without `?shop` keep working (default shop).
- **Realtime:** `/api/events` and `/api/events/poll` filter by shop or `all`; events carry `shop_id` and the client shows a shop chip on toasts in portfolio mode.

Why a cookie instead of `/shops/[slug]/…` routes: the PWA `start_url`, push `url` payloads, and every existing deep link stay valid; the mobile tab bar does not need a path prefix; the switch is one server action.

### 3.3 Config layering

`src/lib/config.ts` is split in two:

- **`appConfig`** (unchanged shape, app-level only): `databaseUrl`, `authSecret`, `dashboardPassword`, `cronSecret`, `vapid`, `storage`, `publicAppUrl`, `credentialsKey` (new).
- **`resolveShopConfig(shop)`** (new, `src/lib/shop-config.ts`): returns the same shape the adapters consume today (`etsy`, `printify`, `imageProvider`, `llmProvider`, `openai*`, `higgsfield`, `replicate`, `publishMode`, `isDemo`), resolved in this order:
  1. `shop_secrets` / `shop_settings.providers` for that shop (decrypted on read, in memory only)
  2. Environment variables, **only for the shop with slug `default`** (backward compatibility)
  3. Built-in defaults

The adapters, `health.ts`, `setup-guide.ts`, and `next-actions.ts` take the resolved config as a parameter instead of importing `config`. `hasEtsyCredentials()` and friends become methods on the resolved object.

### 3.4 Credential vault

- Algorithm: AES-256-GCM via Node `crypto`. Key: `CREDENTIALS_KEY` env var, 32 bytes base64 (`openssl rand -base64 32`). One key for the deployment.
- Stored per secret: `ciphertext`, `iv`, `tag`, and `fingerprint` (first 8 hex of SHA-256 of the plaintext) so the UI can show "set · ends …1a2b" without the value.
- Write-only UI: inputs are blank; saving replaces; "Clear" deletes the row. The value is never returned by any route or server action. `GET` endpoints return `{ set: boolean, fingerprint, updatedAt }` only.
- Rotation: `npm run secrets:rotate` re-encrypts all rows with `CREDENTIALS_KEY_NEXT`, then the operator swaps the variables. Documented in README.
- Missing `CREDENTIALS_KEY`: the vault is disabled, the Shops area shows an explanation, and the app runs exactly as today (env vars for the default shop). This is the compatibility path.
- Etsy OAuth tokens move from `settings.etsyTokens` into `shop_settings` (per shop) and are encrypted with the same vault helper; migration moves the existing row to the default shop.
- `health.ts` and Connections copy change from "env var names only" to "names and fingerprints only". The README security section is updated accordingly.

### 3.5 Adapter registry

`src/adapters/index.ts` (new):

```ts
getAdapters(ctx: ShopContext) => { etsy, printify, image, llm }
```

Internally the same classes as today. Live is chosen only when `shop.publish_mode === "live"` **and** the shop's resolved credentials are complete. Seams are reserved, not built:

- `MarketplaceAdapter` (Etsy today) — later Gumroad/Payhip mirror.
- `PodAdapter` (Printify today) — later Gelato/Printful. The business plan lists all three; Printify stays first because it already publishes to Etsy.

### 3.6 Pipeline

- `StageContext` gains `shop: ShopContext` (id, slug, resolved config, niches, pod presets, fee profile).
- `runStage(stage, trigger, { shopId })` scopes every query by `shop_id`. The concurrency guard key becomes `(shop_id, stage)`.
- Kill switch: global (`settings.automation.killSwitch`, kept) **or** per shop (`shops.kill_switch`). Either stops that shop.
- `runFullPipeline(trigger, { shopId })` unchanged in shape; `runAllShops(stage, trigger)` is the cron entry for `shop=all`.
- Spend caps: per shop (today's `dailyAiCapChf`, `monthlyAiBudgetChf`) plus a new global monthly cap in `settings.automation.globalMonthlyAiBudgetChf` so adding shops cannot multiply spend silently.

### 3.7 Niches, catalog, pricing, disclosures as data

- The five niches in `src/lib/niches.ts` become **built-in templates** (`src/lib/niche-templates.ts`) that seed the `niches` table for new shops. `seasonality()` and `scoreKeyword()` stay pure functions over a `NicheConfig` object.
- `POD_PRESETS` become rows in `pod_presets`, seeded from the same four defaults. `podCostChf(preset)` takes the row.
- `FEES` becomes a **fee profile** per shop in `shop_settings.feeProfile` with the same fields (`usdToChf`, `listingFeeUsd`, `transactionRate`, `processingRate`, `processingFixedChf`, `vatOnFeesRate`, `offsiteAdsRate`). Default profile = today's Swiss constants, so `tests/fees.test.ts` keeps passing against the default. `calculateFees` and `suggestPrice` accept an optional profile argument.
- Disclosures (`src/lib/disclosures.ts`) become editable per shop (`shop_settings.disclosures`) with the current text as default. The validator keeps requiring their presence.
- Trademark blocklist (`src/lib/listing-validator.ts`) gains a per-shop extension list merged with the built-in one.

Reporting currency stays CHF for all shops. Per-shop listing currency is recorded on `shops.currency` and used for display labels, with FX applied through the fee profile. Multi-currency reporting is a stretch item.

### 3.8 Demo mode per shop

- `isDemoMode()` becomes `shop.is_demo`. The migration creates one shop: slug `default`, `is_demo = !hasEtsyCredentials()` (today's rule), and backfills every existing row to it.
- A fresh install still seeds a demo shop so the dashboard looks alive with no keys. When the operator adds a real shop, the demo shop can be paused or archived from the Shops list.
- `visible(col)` becomes `visible(col, shop)`; the portfolio view hides demo shops unless "Include demo" is toggled.

---

## 4. Dashboard upgrade

### 4.1 Navigation

- **Shop switcher** at the top of the sidebar (desktop) and in the mobile header where "Autopilot" sits today. Shows shop color dot, name, and status pill. Items: each active shop, "All shops", divider, "Manage shops".
- **Shops** entry in the sidebar and under More on mobile. The 5-tab mobile bar is unchanged; Shops lives under More.
- Badges (`DRY-RUN`, `LIVE`, `Demo data`, `PAUSED`) reflect the active shop. In "All shops" mode the badge row shows counts (e.g. "2 dry-run · 1 live").

### 4.2 Portfolio Home ("All shops")

- Aggregated KPIs (net profit, revenue, orders, views) with the same 7d/30d toggles, plus a stacked per-shop breakdown.
- One card per shop: status, last run, pending approvals, 7-day profit sparkline, attention count. Tap opens that shop's Home.
- Attention list merges `buildNextActions()` across shops with a shop chip on each item.
- Live activity feed shows shop chips.

### 4.3 Shop Home

Today's Home, scoped to one shop. No layout change.

### 4.4 Shops area (new)

`/shops` — list with status, marketplace, health summary, last run, pending count, actions (open, pause, archive).

`/shops/new` — **Add shop wizard**, one step per screen on mobile, side-by-side review on desktop:

1. **Basics**: name, slug, color, country, currency, marketplace (Etsy only for now), marketplace shop id.
2. **Etsy app**: API key, shared secret, redirect URI (prefilled from `APP_URL`), taxonomy ids. "Connect Etsy shop" starts OAuth with the shop slug in the signed state cookie. Can be skipped and finished later.
3. **Print partner**: Printify token, shop id, optional blueprint/provider/variant override, webhook secret. "Test connection" calls `GET /v1/shops.json` and shows the matched shop name only.
4. **Providers**: image provider and LLM provider choice; keys if the shop should not use the default shop's providers.
5. **Niches & catalog**: pick from built-in templates, clone from another shop, or start empty. Toggle POD presets.
6. **Budgets & schedule**: daily/monthly AI caps, target margin, designs per run, Offsite Ads assumption, per-stage cron strings (defaults from `DEFAULT_STAGES`).
7. **Review & smoke test**: summary, then "Run dry-run pipeline" which executes research → design → listing for that shop and lands on its Queue.

`/shops/[slug]` — shop detail with tabs:
- **Overview**: health strip, last runs, quick actions.
- **Connections**: the current Connections page scoped to the shop, plus write-only credential fields with fingerprints and Test connection buttons.
- **Niches & catalog**: editable table of niches (label, seeds, style prompt, price band, product mix, peak months), POD presets with cost fields and catalog override.
- **Pricing & fees**: fee profile editor with a live example ("CHF 8.00 digital → net CHF 6.37") recomputed from `calculateFees`.
- **Automation**: kill switch, budgets, schedules, Go live control (per shop, same CONFIRM gate), `activateOnPublish` (replaces `ETSY_ACTIVATE`).
- **Content**: disclosures text, trademark blocklist additions.
- **Notifications**: push event prefs for this shop.
- **Danger zone**: pause, archive, delete (delete only when the shop has no live rows; demo shops can be purged).

### 4.5 Settings restructure

`/settings` keeps only app-level items: dashboard auth status, this device's notifications, theme, storage backend, global kill switch, global AI budget, vault status, sign out. Every shop-level control moves to `/shops/[slug]`. A short card links to the active shop's settings so the mobile path stays two taps.

### 4.6 Queue, Products, Orders

- A shop filter chip joins the existing niche and status chips. In "All shops" mode rows carry a shop chip.
- Bulk approve/reject keep working across shops; the server action re-checks each listing's shop and validation.
- Products gains "copy to shop" (clone a listing draft into another shop's queue as `pending_approval`).

### 4.7 Pipeline

- Stage cards scoped to the active shop. Header gains "Run all · this shop" and, in portfolio mode, "Run all · every shop".
- Run history filterable by shop. Logs show the shop slug.

### 4.8 Analytics

- Shop comparison chart (revenue and profit per shop, 30 days).
- Niche chart becomes niche-by-shop when in portfolio mode.
- Cost waterfall adds a per-shop breakdown.
- CSV export includes `shop` column.

### 4.9 Connections

Per-shop health (the current `connectionHealth()` output, computed from the resolved shop config) plus an app-level block (database, storage, push, auth, vault). Test-connection actions are read-only: Etsy `GET /shops/{id}`, Printify `GET /shops.json`, OpenAI-compatible `GET /models`, Higgsfield/Replicate account endpoints. Results are stored in `audit_log`.

### 4.10 UX polish

- Command palette on desktop (`⌘K`): switch shop, jump to page, run stage.
- Empty states for new shops that point to the next wizard step.
- Skeletons already exist (`loading.tsx`); extend to the Shops area.
- Toast copy includes the shop name whenever more than one shop exists.
- Accessibility pass on the wizard: labelled inputs, focus order, `aria-live` on step changes.
- i18n (de-CH) is a stretch item; copy stays in English for this blueprint.

---

## 5. New features and options

| Feature | What it does | Depends on |
| --- | --- | --- |
| Shop templates, import/export | Export a shop's niches, presets, fee profile, disclosures, schedules as JSON (no secrets). Import to a new shop or clone from an existing one. | §3.7 |
| Niche editor | Add, edit, enable, reorder niches; edit seed keywords with demand/competition heuristics and style prompts. | §3.7 |
| Product template editor | Edit POD presets, pick blueprint/provider/variants from a catalog picker backed by `src/adapters/printify/catalog.ts`. | §3.7, §3.4 |
| Pricing rules | Target margin per niche and product type; Offsite Ads assumption per shop; `.90` rounding toggle. | §3.7 |
| Per-shop scheduling | Cron per stage per shop. Cron routes accept `?shop=`. A generator produces the GitHub Actions workflow or a single `shop=all` schedule. | §3.2, §3.6 |
| Optimizer stage | Business plan §7: weekly proposals to prune, re-tag, or re-price published listings, written to the queue as `pending_approval` edits. Human gate preserved. | §3.6 |
| Test connections | Read-only probes per integration with result history. | §3.4, §4.9 |
| Audit log | Records settings changes, go-live toggles, credential set/clear, shop lifecycle, test results. Viewable per shop. | §3.1 |
| Notifications per shop | Push prefs per shop; optional daily digest event. | §3.8 |
| Compliance per shop | Editable disclosures; per-shop trademark blocklist additions. | §3.7 |
| Spend governance | Global monthly AI cap on top of per-shop caps; Home shows combined spend. | §3.6 |
| Marketing (stretch) | Pinterest auto-pin stage; share links on Products. | adapter seam |
| Backup channels (stretch) | Gumroad/Payhip mirror adapter for digital listings; KDP interior export. | adapter seam |
| Second POD partner (stretch) | Gelato or Printful adapter behind `PodAdapter`. | §3.5 |

---

## 6. Phased roadmap

Each phase ends green on `npm test`, `npm run lint`, `npm run typecheck`, and the manual demo flow (sign in, run pipeline, approve, orders), and ships behind compatibility so the single-shop deployment is unaffected.

### Phase 0 — Foundations and safety net

Scope: make the refactor safe before changing behavior.

- Add `shops` table and nullable `shop_id` columns; create the `default` shop; backfill; then a second migration makes `shop_id` not null and swaps the unique constraints. Both migrations are generated with `npm run db:generate` and verified on PGlite and a Neon branch.
- Add `getActiveShop()` returning the default shop (cookie ignored for now).
- Add `CREDENTIALS_KEY` to `.env.example` as optional; vault helper with unit tests (encrypt/decrypt round trip, tamper detection, rotation).
- Add a migration test that seeds a pre-migration PGlite database from the current `drizzle/0001_*` state and asserts the backfill.
- Extend `tests/pipeline.e2e.test.ts` to assert every inserted row carries the default `shop_id`.

Files: `src/db/schema.ts`, `drizzle/*`, `src/lib/vault.ts` (new), `src/lib/shop-context.ts` (new), `tests/vault.test.ts`, `tests/migration.test.ts`.

Acceptance: identical UI and behavior; 100% of existing tests pass; new tests pass; `drizzle/meta/_journal.json` has two new entries.

### Phase 1 — Shop context plumbing

Scope: thread the shop through queries, pipeline, adapters, and routes while there is still exactly one shop.

- `StageContext.shop`; `runStage` and `runFullPipeline` take `{ shopId }`; concurrency key `(shop_id, stage)`.
- `src/lib/shop-config.ts` with `resolveShopConfig(shop)`; adapters take the resolved config; `health.ts`, `setup-guide.ts`, `next-actions.ts` take it as input.
- Every query in `src/lib/queries.ts` and `src/app/actions.ts` filters by `shop_id`.
- `emit()` records `shop_id`; `/api/events*` filter by shop.
- Cron and pipeline routes accept `?shop=`; `shop=all` loops active shops.
- `visible(col, shop)`.

Files: `src/pipeline/*`, `src/adapters/*/index.ts`, `src/lib/{queries,events,health,setup-guide,next-actions,shop-config}.ts`, `src/app/actions.ts`, `src/app/api/{cron,pipeline,events}/**`.

Acceptance: single-shop behavior unchanged; a unit test runs two shops in one PGlite database and proves no cross-shop rows (keywords, listings, orders, events, job_runs); cron with `?shop=all` produces one `job_runs` row per shop.

### Phase 2 — Vault, connections, add-shop wizard

Scope: shops can be created and connected from the UI.

- `shop_secrets`, `shop_settings`, `audit_log` tables; move `etsyTokens` to `shop_settings` (encrypted); OAuth `start` and `callback` carry the shop slug in the signed state; callback redirects to `/shops/[slug]?etsy=…`.
- Shops list, add-shop wizard steps 1–4 and 7, shop detail with Overview, Connections, Automation, Danger zone tabs.
- Write-only credential fields with fingerprints; Test connection actions; per-shop Go live control.
- Shop switcher in the shell; `ea_shop` cookie; server action `switchShop`.
- README security section updated for the vault; `.env.example` documents `CREDENTIALS_KEY`.

Files: `src/app/(app)/shops/**` (new), `src/components/shops/**` (new), `src/components/app-shell.tsx`, `src/app/api/shops/**` (new), `src/app/api/etsy/oauth/*`, `src/lib/vault.ts`, `README.md`, `.env.example`.

Acceptance: create a second shop in the UI with dry-run adapters, run its pipeline, approve a listing, see it isolated from the default shop; secret values never appear in any response (test asserts JSON of `/api/shops/*` contains no plaintext); OAuth callback stores tokens on the right shop.

### Phase 3 — Niches, catalog, pricing, disclosures as data

Scope: the largest refactor; one shop can differ from another in what it sells.

- `niches` and `pod_presets` tables seeded from built-in templates on shop creation.
- `Niche` → `string`; `NICHES[...]` call sites replaced by `ctx.shop.niches`; chart colors from the row.
- Fee profile per shop; `calculateFees`/`suggestPrice` accept a profile; defaults preserve current numbers.
- Disclosures and blocklist additions per shop.
- Wizard steps 5–6; shop detail tabs Niches & catalog, Pricing & fees, Content.
- Import/export JSON (no secrets).

Files: `src/lib/{niches,fees,disclosures,listing-validator}.ts`, `src/lib/niche-templates.ts` (new), `src/pipeline/{research,design,listing,publish}.ts`, `src/db/seed.ts`, `src/components/{queue,products,analytics}/**`, `tests/fees.test.ts` (profile variant), `tests/niches.test.ts` (new).

Acceptance: `tests/fees.test.ts` unchanged results on the default profile; a test with a custom profile and custom niche produces a valid, priced listing; the seed produces the same demo numbers as today for the default shop.

### Phase 4 — Dashboard upgrade

Scope: portfolio mode and the restructured Settings.

- "All shops" mode on Home, Queue, Products, Orders, Analytics with shop chips and filters.
- Portfolio Home cards and aggregated KPIs; attention list across shops.
- Analytics shop comparison and per-shop waterfall; CSV `shop` column.
- Settings reduced to app-level; shop-level controls moved to `/shops/[slug]`.
- Pipeline "every shop" run; run history by shop.
- Command palette; empty states; accessibility pass on the wizard.

Files: `src/app/(app)/{page,queue,products,orders,analytics,settings,pipeline}/**`, `src/components/**`, `src/lib/queries.ts`.

Acceptance: Playwright walkthrough (like the existing demo flow) covers: switch shop, portfolio KPIs equal the sum of shop KPIs, approve from "All shops", analytics comparison renders with two shops.

### Phase 5 — New stages and operator features

- Optimizer stage (`src/pipeline/optimize.ts`) added to `STAGES` with its own schedule; proposals land in the queue as edits.
- Global AI cap; combined spend on Home.
- Notifications per shop; daily digest event.
- Audit log view on shop detail.
- Workflow generator for GitHub Actions (`?shop=all` single schedule or per-shop jobs).

Acceptance: optimizer run creates `pending_approval` edits and nothing else; approving one applies `updateListing` through the live or dry-run Etsy adapter; audit rows exist for every settings mutation.

### Phase 6 — Stretch

Second POD adapter (Gelato or Printful), Pinterest stage, Gumroad/Payhip mirror, KDP export, de-CH copy, multi-currency reporting. Each is its own proposal when reached.

---

## 7. Data migration and compatibility

1. **Default shop backfill.** Migration creates `shops` row `default` from env (`ETSY_SHOP_ID` → `marketplace_shop_id`, `is_demo` from today's rule), sets every existing row's `shop_id`, then enforces not-null and the composite uniques. Idempotent: re-running finds the shop and skips.
2. **Settings move.** `settings.automation`, `stages`, `pushPrefs` copy to `shop_settings` for the default shop; `settings.etsyTokens` moves (encrypted if `CREDENTIALS_KEY` exists, otherwise copied as-is and flagged for encryption on first save). The global `settings` table keeps `automation.killSwitch` and the new global cap.
3. **Env fallback.** The `default` shop resolves credentials from env when no vault row exists. Deployments that never set `CREDENTIALS_KEY` keep working with zero config changes.
4. **Seeds.** `seedDemo(db, shopId)`; `npm run db:seed -- --shop default`; `clearDemo` scoped by shop.
5. **Cron.** Existing schedules without `?shop` target the default shop. The workflow file gains `?shop=all` once a second shop exists; until then nothing changes.
6. **PWA and push.** `start_url` and push `url` payloads are unchanged. Push payloads gain `shop` for the toast chip.

---

## 8. Security and compliance

- Secret values are never returned by any route, action, log line, or event body. A test greps all `/api/shops/*` JSON for fingerprints only.
- Vault key is env-only. Losing it means re-entering credentials; the Shops area shows a clear warning when `CREDENTIALS_KEY` is missing but encrypted rows exist.
- Go live stays per shop with checkbox plus `CONFIRM`. Portfolio mode has no "go live for all".
- `activateOnPublish` per shop replaces `ETSY_ACTIVATE` and defaults to false (drafts only), matching today's clearance.
- Printify webhook: one callback URL; the handler matches `printify_product_id`/`etsy_listing_id` to a shop through `listings`. If a webhook secret is set per shop, the handler tries each active shop's secret and records which one verified.
- Disclosures remain mandatory in the validator even when edited.
- Audit log is append-only from the app's point of view.

---

## 9. Testing strategy

- **Unit:** vault, shop config precedence (vault → env for default → defaults), fee profile math, niche scoring over row data, cron shop parsing.
- **Integration (PGlite in-memory):** two-shop pipeline isolation; migration backfill; OAuth callback stores to the right shop; optimizer creates only `pending_approval` edits.
- **End-to-end (Playwright, headed Chrome, as in the current environment demo):** add shop wizard → dry-run pipeline → approve → orders → portfolio view. Recorded as the walkthrough artifact for each phase.
- **Compatibility gate:** a CI job runs the full suite with no `CREDENTIALS_KEY` and only today's env vars to prove the single-shop path.
- **Type gate:** `npx next typegen && npm run typecheck` stays in CI; route helpers depend on it.

---

## 10. Risks and open decisions

| Risk / decision | Options | Recommendation |
| --- | --- | --- |
| Storing credentials in the database | (a) encrypted vault with env key; (b) env-only with per-shop prefixes (`ETSY_API_KEY__SHOP2`); (c) external secret manager | (a). (b) needs a redeploy per shop, which defeats the goal; (c) adds a dependency and cost. Keep env fallback for the default shop. |
| URL scheme | cookie-based active shop vs `/shops/[slug]/…` for every page | Cookie plus `?shop=` on APIs. Preserves PWA, push links, and the mobile tab bar. |
| `Niche` type change | big-bang refactor vs keeping the union and adding a parallel data model | Big-bang in Phase 3 behind tests; a parallel model would leave two sources of truth. |
| Reporting currency | CHF for all shops vs per-shop reporting | CHF reporting now; per-shop listing currency recorded; multi-currency reporting is stretch. |
| Printify webhook with multiple shops | one URL, try each secret vs one URL per shop (`/api/webhooks/printify/[slug]`) | Per-slug URL is cleaner and avoids trying secrets. Keep the legacy URL mapped to the default shop. |
| Spend safety when adding shops | per-shop caps only vs per-shop plus global | Both. Global cap defaults to the sum of existing per-shop caps so nothing changes on migration. |
| Where the optimizer writes | directly update listings vs propose edits to the queue | Queue. Matches "nothing goes live without approval". |
| Demo shop lifecycle | auto-archive when a real shop is added vs manual | Manual, with a one-tap prompt on the Shops list. Avoids surprising data disappearance. |

---

## 11. Appendix

### 11.1 Proposed file map (new or heavily changed)

```
src/lib/vault.ts                      AES-256-GCM helpers, fingerprint, rotate
src/lib/shop-context.ts               getActiveShop(), switchShop(), shop cookie
src/lib/shop-config.ts                resolveShopConfig(shop): vault → env(default) → defaults
src/lib/niche-templates.ts            built-in niches and POD presets used to seed new shops
src/adapters/index.ts                 getAdapters(ctx)
src/pipeline/optimize.ts              optimizer stage (Phase 5)
src/app/(app)/shops/page.tsx          shops list
src/app/(app)/shops/new/page.tsx      add-shop wizard
src/app/(app)/shops/[slug]/page.tsx   shop detail with tabs
src/app/api/shops/route.ts            GET list, POST create
src/app/api/shops/[id]/route.ts       PATCH, DELETE
src/app/api/shops/[id]/secrets/route.ts     PUT (write-only), DELETE
src/app/api/shops/[id]/test/[provider]/route.ts  read-only probes
src/app/api/webhooks/printify/[slug]/route.ts    per-shop webhook (legacy path → default)
src/components/shops/**               switcher, wizard steps, credential field, niche editor, preset editor, fee profile editor
tests/vault.test.ts, tests/migration.test.ts, tests/multi-shop.test.ts, tests/niches.test.ts
```

### 11.2 API surface additions

| Route | Purpose |
| --- | --- |
| `GET /api/shops` | List shops with health summary (no secrets). |
| `POST /api/shops` | Create shop (basics only). |
| `PATCH /api/shops/[id]` | Update basics, status, automation, fee profile, disclosures. |
| `PUT /api/shops/[id]/secrets` | Set one or more secrets. Returns fingerprints. |
| `DELETE /api/shops/[id]/secrets?provider=&key=` | Clear a secret. |
| `POST /api/shops/[id]/test/[provider]` | Read-only probe; writes an audit row. |
| `GET /api/etsy/oauth/start?shop=` | Start OAuth for a shop. |
| `GET /api/cron/[stage]?shop=all\|slug` | Run a stage for all or one shop. |
| `POST /api/pipeline/[stage]/run?shop=` | Manual run for a shop. |
| `GET /api/events?shop=all\|slug` | SSE filtered by shop. |

### 11.3 Environment variable changes

| Variable | Change |
| --- | --- |
| `CREDENTIALS_KEY` | New, optional. 32-byte base64. Enables the vault. |
| `CREDENTIALS_KEY_NEXT` | New, optional. Used only by `npm run secrets:rotate`. |
| `ETSY_*`, `PRINTIFY_*`, `IMAGE_PROVIDER`, `LLM_PROVIDER`, `OPENAI_*`, `HIGGSFIELD_*`, `REPLICATE_*` | Unchanged. Act as the fallback for the `default` shop only. |
| `ETSY_ACTIVATE` | Deprecated in favor of the per-shop `activateOnPublish` setting; still honored for the default shop during the transition. |
| `DEMO_MODE` | Unchanged meaning for the `default` shop; other shops carry `is_demo` on the row. |

### 11.4 Schema sketch (Drizzle)

```ts
export const shops = pgTable("shops", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  marketplace: text("marketplace").$type<"etsy">().notNull().default("etsy"),
  marketplaceShopId: text("marketplace_shop_id"),
  country: text("country").notNull().default("CH"),
  currency: text("currency").notNull().default("CHF"),
  color: text("color").notNull().default("var(--chart-1)"),
  status: text("status").$type<"draft" | "active" | "paused" | "archived">().notNull().default("draft"),
  isDemo: boolean("is_demo").notNull().default(false),
  publishMode: text("publish_mode").$type<"dry-run" | "live">().notNull().default("dry-run"),
  killSwitch: boolean("kill_switch").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shopSecrets = pgTable(
  "shop_secrets",
  {
    id: serial("id").primaryKey(),
    shopId: integer("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    fingerprint: text("fingerprint").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.shopId, t.provider, t.key)],
);
```

The remaining tables follow the shapes in §3.1.
