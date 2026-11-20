# Decisions

Short records of the architecture decisions that shape this repository. Each one is traceable to code or to the README; follow the file references to check it.

## 1. Dry-run is the default; going live is a separate, confirmed step

- **Context:** The app writes to a real Etsy shop and a print-on-demand supplier.
- **Decision:** `PUBLISH_MODE` defaults to `dry-run`. Live writes need the host variable and an explicit confirmation typed in the dashboard (`goLiveDecision`, `GO_LIVE_CONFIRMATION` in `src/lib/publish-mode.ts`). The daily chain restores the previous publish mode and cannot arm go-live (`runDailyChain` in `src/pipeline/runner.ts`).
- **Consequences:** A fresh install cannot change the shop. Dry-run adapters record payloads and return `dry-...` ids (README, stage table).

## 2. A human approves every listing before it is published

- **Context:** Listings are AI-generated copy and artwork for a real shop.
- **Decision:** The publish stage only selects listings with status `approved` (`src/pipeline/publish.ts`). Approval happens in the queue (swipe, inline edit, undo). Digital drafts are never auto-activated, and POD products are not published to Etsy until a sample is recorded and the operator clicks Publish (README, "Next steps").
- **Consequences:** Throughput is bounded by the operator. Some steps stay manual because Etsy's API does not expose them (README, "What still needs a human").

## 3. Stages are plain functions behind adapter interfaces

- **Context:** The pipeline talks to image, text, marketplace and supplier services that differ per environment.
- **Decision:** Each stage is an async function `(ctx) => summary`, run through `runStage()` (`src/pipeline/runner.ts`). External services sit behind interfaces in `src/adapters/` (`image`, `llm`, `etsy`, `printify`, `supplier`, `marketplace`), each with a mock or dry-run variant next to the live one.
- **Consequences:** Demo mode and tests run without credentials; each provider switches to live when its credentials exist. Live shops fail a stage rather than fall back to a mock (README, stage table; `isMockPlaceholder` in `src/lib/publish-gates.ts`).

## 4. Kill switch and per-stage pause are checked by the runner

- **Context:** Scheduled automation needs an immediate way to stop.
- **Decision:** `runStage` checks the global kill switch, the per-shop kill switch and the per-stage pause before running (`src/pipeline/runner.ts`, settings in `src/lib/settings.ts`). Concurrent runs are guarded by a stage lock (`src/lib/stage-lock.ts`).
- **Consequences:** One setting pauses every trigger path (cron, run buttons, box worker) because they all go through the runner.

## 5. AI spend is reserved against daily and monthly caps

- **Context:** Image and text providers bill per call.
- **Decision:** Budget is reserved before a provider call and settled, released or marked uncertain afterwards (`reserveAiBudget`, `finishAiBudgetReservation` in `src/lib/ai-budget.ts`); the image fallback reserves the sum of both estimates (README, Image storage and providers).
- **Consequences:** Calls stop when a cap is reached instead of overrunning it. Covered by `tests/ai-budget.test.ts`.

## 6. Embedded Postgres locally, Neon in production

- **Context:** The app should run with no setup, but production needs a hosted database.
- **Decision:** `src/db/index.ts` uses Neon when `DATABASE_URL` is set and embedded PGlite otherwise; production requires `DATABASE_URL` and refuses PGlite. Migrations come from `drizzle/` (README, Architecture). Demo rows are flagged `is_demo` and hidden in live mode (README, Quick start and Security notes).
- **Consequences:** `npm run dev` works offline. Schema changes go through `npm run db:generate` into `drizzle/`.

## 7. Jobs are persisted first, then executed by a local worker (optional)

- **Context:** The dashboard can run on a free tier while heavy jobs run on an existing Mac.
- **Decision:** With `AUTOPILOT_EXECUTION=box`, a request stores a job and returns; `workers/box/worker.ts` claims it, holds a heartbeat lease while working and polls idly at a minimum interval (`src/lib/box-jobs.ts`, `docs/FREE_HOSTING.md`). The worker needs no inbound port. The default remains inline execution.
- **Consequences:** Two execution paths share one runner. Production jobs in box mode do not depend on GitHub Actions or Netlify scheduled functions (README, Deploy section).

## 8. Auth is a signed session cookie checked in one edge proxy

- **Context:** A single-operator dashboard with a few machine-to-machine routes.
- **Decision:** `src/proxy.ts` (Next 16's replacement for `middleware.ts`) requires a verified HMAC session cookie for every path except a short public list. Cron, webhook and bearer-token routes authenticate inside the route (`CRON_SECRET`, webhook signature, `bearerMatches` in `src/lib/bearer.ts`). Login attempts are throttled per client (`src/lib/login-limit.ts`). `tests/proxy.test.ts` pins the exemption list.
- **Consequences:** Adding a public route means editing the list in `src/proxy.ts` and its test.

## 9. Etsy types come from a reviewed OpenAPI snapshot

- **Context:** The Etsy client must match the documented API.
- **Decision:** `data/etsy-openapi.snapshot.json` (with provenance) generates `src/adapters/etsy/generated.ts`; `npm run etsy:contract:check` verifies reproducibility and runs in CI (`.github/workflows/ci.yml`, `etsy-contract.yml`).
- **Consequences:** API drift shows up as a diff in review, not at runtime.

## 10. Large modules are split behind facades

- **Context:** Several core modules grew past 500 lines.
- **Decision:** `config.ts`, `health.ts`, `listing-validator.ts`, `queries.ts` and `db/schema.ts` keep their public exports and delegate parts to sibling modules (`config-printify`, `health-providers`, `listing-rules`, `listing-repair`, `queries-runs`, `queries-settings`, `schema-core`, `schema-ops`, `schema-brain`), so existing imports are unchanged. `drizzle.config.ts` still lists `src/db/schema.ts`, which re-exports the three schema files.
- **Consequences:** `drizzle-kit generate` yields the same schema snapshot as before the split. New code should extend the sibling modules rather than regrow the facades.

## 11. Layer boundaries are enforced by lint

- **Context:** Adapters, pipeline stages and UI are meant to depend in one direction.
- **Decision:** `eslint.config.mjs` uses `no-restricted-imports`: adapters may not import `@/app`, `@/components` or `@/pipeline`; pipeline and db code may not import `@/app` or `@/components`; library code may not import `@/app`; `schema-core` is the base layer of the schema files and `schema-ops` may depend only on it.
- **Consequences:** `npm run lint` fails on a violating import (CI job `checks`). Suppressions in the code carry a reason after `--`.
