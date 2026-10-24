# Audit remediation and rollout

This branch implements the engineering changes identified in the 24 October 2026 audit. It does not assert that external credentials, supplier evidence, existing artwork, Etsy settings, backups or infrastructure failover have been repaired by changing source code.

## Changes

- Database-backed renewable stage leases replace process-local admission checks. Side-effect dispatch checks the current lease, global pause, shop pause and effective publish mode.
- All approval entry points check design review and print-file holds. Edit, single approval, bulk approval and human publishing use the same listing lease.
- Printify creates and publishes record durable intent before dispatch. Unknown outcomes are held for operator reconciliation. Replaying a completed identical attempt returns its saved result.
- Daily/orders requests persist durable jobs before returning 202. Upscale completion persists validated bytes and a durable completion job before acknowledgment. The five-minute recovery schedule drains interrupted jobs. Long-job workflows poll terminal status instead of equating acceptance with success.
- Upscale claims are fenced by worker tokens. Completion is idempotent, verifies the stored hash, and rejects stale source revisions. Failure counting is atomic and supports idempotency keys.
- Budget reservations cover image, fallback, text and vision operations in pipeline/recovery execution contexts. Failed or uncertain calls retain their reservations. Limits remain estimates until model-specific prices and actual billing are reconciled.
- Existing Printify products synchronize approved variant prices and verify them before publication. Read retries are bounded; writes are never blindly retried. HTTP bodies, deadlines and redirects are bounded.
- Fulfillment rank advances atomically. Webhook storage retains operational identifiers instead of buyer payloads. Webhook ingress has a byte limit before parsing.
- Shared login admission supplements per-client throttles. Session tokens require the exact signed format.
- Artwork DNS destinations are validated and pinned to the HTTPS connection. The temporary artwork cache has a 64 MiB budget. Existing font assets are self-hosted with their licenses to remove a build-time Google Fonts dependency.
- Queue pages include blocked quality work, distinguish simulated inventory, and show recovery jobs and worker contact. Unsupported presets remain gated. Daily statistics, queues, history and principal data reads are scoped to the selected shop.
- A clean release workflow runs tests, lint, route generation, type checking and build. Migration 0032 adds only tables, columns and indexes.

## Finding disposition

“Implemented” means code and local regression coverage, not a production certification. Review the test results in the PR. Multi-process Postgres and production-provider validation remain rollout checks.

| Finding | Disposition |
|---|---|
| F01 kill switch | Dispatch-time policy and lease checks implemented; test pause during a real staging batch before release. |
| F02 duplicate stages | Database leases implemented; concurrent synthetic regression passes. Repeat with two PostgreSQL app instances. |
| F03 approval inconsistency | Shared design checks applied to edit, single, bulk and publication paths; listing operations serialized. |
| F04 duplicate provider work | Durable intent and cached results; uncertain outcomes cannot dispatch again without reconciliation. |
| F05 lost background work | Durable jobs plus recovery cron and terminal-status polling. Interrupted-worker regression included. |
| F06 upload retries | Replays return the same durable job; source revision and stored hash are checked. |
| F07 lost failure increments | Atomic SQL counter and optional report idempotency key. |
| F08 stale supplier price | Variant price synchronization and read-back verification. Verify the linked Etsy store actually uses CHF. |
| F09 scheduler failures | Bounded requests, independent maintenance, recovery and completion polling implemented. Existing failing account secrets/destination/deployment still require live verification. |
| F10 false live labels | Header uses effective mode; settings distinguish host block and pause. |
| F11 false success with no usable output | Quota and quality holds return warnings; completed warnings do not regenerate the same daily chain automatically. |
| F12 false webhook success | Skips are labeled as skips. Current provider registrations/secrets still need an authenticated delivery check. |
| F13 long orders/maintenance coupling | Maintenance removed from orders execution and retains its independent schedule. |
| F14 undersized existing art | Gates retained; budgeted repair queue available. Existing assets are not magically repaired by deployment. |
| F15 exhausted blank-edge retries | Operator repair creates a new source with additional print-size headroom; gates remain intact. Run and inspect the affected designs. |
| F16 box worker dependency | Fenced worker claims, heartbeat and recovery visibility; install the updated worker and verify its supervisor/availability. |
| F17 supplier evidence | Unknown timings, stock and landed costs remain blocked. Supply verified, current country/variant-specific evidence; no fallback facts are fabricated. |
| F18 unsupported preset coverage | Readiness considers enabled presets; disabled/preview products stay gated. Finish pins/evidence only for products actually being enabled. |
| F19 quota/throughput mismatch | Shared quota preserved; daily-chain warnings do not cause duplicate daily generation; AI reservations cover all calls. Confirm real capacity before raising targets or enabling a paid fallback. |
| F20 demand quality | Seed-derived scores remain labeled by source. External demand coverage is not repaired by inventing data; verify source access and freshness before scaling. |
| F21 hidden repair backlog | Quality-failed items appear in the review queue and are counted separately from ready items. |
| F22 inventory ambiguity | Simulated and real Etsy records are separated; “Approved” no longer includes supplier-created/waiting rows. Verify active state in Etsy independently. |
| F23 budgets | Shared reservations implemented. Set conservative AI_TEXT_RESERVE_CHF/AI_VISION_RESERVE_CHF and reconcile actual model pricing before claiming an actual-spend guarantee. |
| F24 Printify transport | Deadlines, response bounds, redirect refusal, cautious read retries and uncertain-write holds implemented. |
| F25 fulfillment races | Atomic monotone transitions shared by webhook and polling; shuffled concurrent-event regression included. |
| F26 ingress/privacy | Streaming body limit and allowlisted persisted facts. Existing historical payload retention still needs review. |
| F27 shop isolation | Stage leases, provider guards, queue/listing/history reads and daily stats scoped. Global Printify credentials are refused for another shop; provision separate credentials before multi-shop expansion. |
| F28 missing old health history | Latest run queried per shop/stage rather than a global 200-row window. |
| F29 finance | Simulated publish fees are demo rows; actual-profit uncertainty remains explicit. Complete financial reconciliation is external work, not assumed from forecast figures. |
| F30 misleading readiness | Presence and configured status distinguished; no claim of successful live operation from a nonempty variable. Verify OAuth refresh and representative real operations. |
| F31 instance-local throttle | Shared global login admission cannot be bypassed with changing forwarded IPs. |
| F32 image memory | Byte-capped cache and leased work reduce unbounded growth; measure process RSS under realistic image concurrency. |
| F33 DNS rebinding | Public addresses checked and pinned to the actual HTTPS connection. |
| F34 release verification | Release workflow added; use clean lockfile dependencies and the validation below. Required branch protection is an account setting to enable separately. |
| F35 external metadata | No external setting is silently asserted complete. Verify How it’s made, production partners, samples and catalog changes in the source accounts. |

## Safe rollout order

1. Keep host publishing in dry-run. Back up PostgreSQL and record the deployed app and box-worker revisions. Run migration 0032 on a restored staging database first; verify preservation of existing rows and hashes.
2. Deploy the app and updated `workers/upscaler/pull.ts` together. Worker tokens are returned by the job list and must accompany completion requests. The normal worker operating window remains unchanged.
3. Confirm GitHub `CRON_SECRET` and optional `AUTOPILOT_URL` match the intended deployment without printing values. The new workflow must be on the default branch for schedules to execute.
4. Confirm `/api/cron/jobs` can drain durable work and that daily/orders jobs reach terminal state. A returned 202 alone is insufficient. Check unfinished/failed jobs and the upscaler heartbeat in Connections.
5. Verify one digital delivery and one enabled POD preset end to end: actual file hash/size, review verdict, provider mockups, verified country-specific delivery times, current landed cost, approved sample, shop currency and final external price/state. Keep human verification/activation gates.
6. Run the fault matrix from the audit with real PostgreSQL and two app workers: concurrent admission, process death after acknowledgment, missing object, altered object, delayed/duplicate webhook, pause during a batch and provider response loss. Test a database restore and app rollback; additive tables may remain after app rollback.
7. Enable live publishing only after these checks and a review of the concrete release. Do not automatically publish the historical held/rejected backlog.

## Recovery operations

- A completed replay returns the saved job/provider result. Do not delete intent rows simply to force a repeat.
- An uncertain provider attempt needs inspection in Printify/Etsy before the matching local result is reconciled. The app intentionally does not guess whether an external write happened.
- Use Queue artwork repair for a failed physical design. This queues generation within existing budgets; it never approves, publishes or activates the replacement. A successful new source clears old upscale failure counts. Repairs that exhaust quota/budget stay visible as unfinished/failed work.
- Durable jobs retry a bounded number of times. A missing callback is recoverable by the five-minute drain; a provider-ambiguous write remains held.
- Model rates, currency conversion, supplier quotes, shipping, fees and ad spend remain estimates until supported by current evidence. Do not optimize autonomously using unverified profit.

## Validation commands

```sh
npm ci
npm test
npm run lint
npx --no-install next typegen
npm run typecheck
npm run build
```

In a worktree whose node_modules points outside the Turbopack project root, `npm run build -- --webpack` validates a production build without that symlink restriction. Clean CI uses dependencies installed within its project root.
