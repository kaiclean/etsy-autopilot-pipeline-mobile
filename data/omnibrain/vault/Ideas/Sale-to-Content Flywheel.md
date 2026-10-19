---
status: idea
type: software feature
effort: M
potential: high
source_reels: ["[[2026-10-12 shanepduggan DeZJG4Oib3b]]", "[[2026-10-09 bobbby.rn DeSfhW0sHKX]]", "[[2026-10-16 restructureai DeihbtONYtH]]"]
created: 2026-10-18
tags: [idea, software-feature]
---
# Sale-to-Content Flywheel

## Problem
Each sale and 5-star review is proof that could become content, but making posts by hand doesn't happen consistently.

## Concept
Following the contractor-flywheel reel: when an Etsy order or review comes in, the pipeline generates (1) an OmniShop post or reel draft with the product mockup + review quote, (2) a Pinterest pin, (3) an FAQ entry for the listing/shop (GEO, so AI search answers cite the shop). Kai approves each draft before it goes out.

## How to build it for real
1. Reuse the existing orders-digest / orders-sync scripts on the box to detect new orders and reviews via the Etsy Open API.
2. Template engine: product mockup + review text → 1080×1350 post and 1080×1920 story (Pillow or Satori/Vercel OG).
3. LLM writes the caption + hashtags + comment-keyword (links to [[Comment-to-DM Funnel for OmniShop]]).
4. Queue drafts in a Neon table and send Kai a daily approval digest; publishing happens only after approval, via the Instagram Content Publishing API.
5. Append FAQ snippets to an 'FAQ' section in listing descriptions monthly.

## Etsy fit
Turns social proof into reach; reviews in posts raise trust for new buyers.

## Next step
- [ ] Add a 'new review' hook to the orders script and make one post template.

## Source reels
- [[2026-10-12 shanepduggan DeZJG4Oib3b]]
- [[2026-10-09 bobbby.rn DeSfhW0sHKX]]
- [[2026-10-16 restructureai DeihbtONYtH]]
