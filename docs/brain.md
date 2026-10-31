# OmniGram Brain (`/brain`)

The OmniGram second-brain dashboard, merged into Autopilot. It used to be the standalone `omnigram-brain` service.

- **Pages:** `/brain` (overview), `graph`, `ideas` (approval queue), `reels`, `insights`, `timeline`, `search`, `note/...`. They share Autopilot's login (`ea_session`).
- **Vault:** markdown in `data/omnibrain/vault`, thumbnails in `data/omnibrain/thumbs`. Refresh both with `scripts/brain/sync-vault.sh [--push]`. Override the paths with `BRAIN_VAULT_DIR` and `BRAIN_THUMBS_DIR`.
- **Thumbnails:** served by `/api/brain/thumb/<code>`. The URL has no file extension, so `proxy.ts` session-checks it, and the route checks the session again.
- **Decisions:** stored in the `brain_decisions` table (migration `0024`, additive). The latest row per idea wins.
- **Approve flow:**
  - A product idea that fits an active niche shows a theme select and an editable search phrase.
  - Only when Kai ticks the confirm box does approving create a `selected` keyword (`source = omnibrain:<idea>`) and its design brief. The next design run picks it up, and the result still goes through the quality gate and the approval queue.
  - Without the tick, or for ideas that don't fit, the approval stays in the backlog.
- **Hermes API:** `GET /api/brain/decisions[?since=ISO]` with `Authorization: Bearer $OMNIGRAM_API_TOKEN`. It returns `{decisions:[...]}`.

## Brain → product pipeline

- **Themes** (`/brain/themes`, table `themes`, migration 0025): editable registry on top of the production niches. Only active themes with no blocker, an unpaused niche and an image-pipeline product (wall art, poster, POD apparel/mug) feed research. Planners, templates and prompt packs stay blocked until a hand-built file exists.
- **Idea mapper** (`src/lib/brain/mapper.ts`): each vault idea is classed product / software / content. Products get a proposed theme, buyer phrase and product type. Software and content get an honest Etsy derivative (marked as needing a hand-built file). Nothing enters the pipeline until Kai ticks the confirm box.
- **Daily idea feed** (`src/lib/brain/idea-feed.ts`): runs at the end of the research cron with no AI calls and no spend. It adds up to 8 pending candidates per day (seasonal seeds, hot signals) and proposes themes for unmatched artwork ideas.
- **OmniGram hook**: `process.py` runs `/workspace/ap-sync/scripts/brain/sync-vault.sh --push` after each batch. Opt out with `OMNIBRAIN_AUTOSYNC=0`.
- **Road to the first sale**: the card on `/brain` shows the funnel.
- **Status API**: `GET /api/brain/status` with bearer `OMNIGRAM_API_TOKEN` returns the publish mode, the image provider name, AI caps/spend and the funnel counts. It returns no secrets.
- **Skill rules** in `listing-validator.ts`: titles must be 6–14 words with the primary phrase in the first 40 characters; empty praise in a title or tag is an error; using one phrase in more than 2 tags gets a warning.

## Reel-backed original products

Open a reel note to define an original visual direction, active theme, supported product and buyer phrase. Confirming creates a scoped design brief with immutable source note/reel hashes. In box mode it queues one idempotent keyword-scoped `daily` job (Design → Listing only); Research and Publish are excluded. Scoped runs do not mark the shop-wide daily schedule complete. The explicit approved product overrides the niche's random product mix, and Listing only makes that product type.

Research also imports runnable **product ideas linked to resolved saved reels** into the candidate queue before seasonal suggestions. Operational/software reels are not blindly turned into merchandise. Missing reel links and unsupported planners/templates remain blocked. Use **Refresh reel ideas** on Ideas; approve the product and edit its original direction. Existing phrases with different approved briefs cannot be silently reused or overwrite old products.

`/brain/products` shows source evidence, artwork provider and measured pixels, actual listing state, and buyer-file links. These are generation/provenance records, not certificates of originality. Review source rights, visual originality and downloaded bytes before the existing approval/publish actions. Demo artwork is labeled and existing pixel/quality/manifest gates remain enforced.

Migration `0034_brain_product_origins` adds provenance on briefs/candidates and keyword scope on jobs/runs. The Mac worker refreshes its vault cache after local syncs. New cloud catalogue notes still require a release deploy; persisted candidate source snapshots can be approved even before those note files reach the web deployment. No additional AI calls run during candidate extraction. Keep the existing free-only provider policy and Mac setup from `FREE_HOSTING.md`.

Validation uses a synthetic provider fixture returning real PNG bytes through the real Design/Listing stages, including read-back SHA-256 and isolation from unrelated keywords. This is not evidence of live provider generation. A live smoke test requires the configured real image/text/vision providers, permanent storage and Mac worker; missing credentials must fail visibly and cannot fall back to demo products.
