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
