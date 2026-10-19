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
