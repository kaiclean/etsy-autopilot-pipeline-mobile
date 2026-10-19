---
status: idea
type: software feature
effort: M
potential: high
source_reels: ["[[2026-10-09 bobbby.rn DeSfhW0sHKX]]", "[[2026-10-05 peterstewiestartup DeHYCIpColc]]"]
created: 2026-10-18
tags: [idea, software-feature]
---
# Etsy SEO and GEO Optimizer

## Problem
Listing titles/tags decide Etsy visibility, and increasingly AI assistants (ChatGPT, Google AI Overviews) recommend products. Kai has no systematic keyword loop.

## Concept
An agent skill that (1) pulls listing stats (views, visits, favourites) from the Etsy API, (2) finds keywords each listing almost ranks for (the same idea as the GSC MCP 'close to ranking' trick), (3) rewrites titles/13 tags/descriptions, (4) adds GEO-friendly FAQ blocks and keeps an off-Etsy page (a Designed by Kai site on Vercel) with structured data so AI search can cite it.

## How to build it for real
1. Export the listing data via the Etsy Open API v3 into Neon.
2. Keyword source: Etsy search autocomplete + eRank/Marmalead export (manual CSV at first).
3. LLM proposes title/tag changes → diff view for Kai → apply via API after approval.
4. A/B log: track views 14 days before vs after each change in OmniBrain.
5. Add Google Search Console + an Open SEO-style audit for the shop's own site; GEO: FAQ schema, llms.txt.

## Etsy fit
Core lever for organic Etsy traffic; zero ad spend.

## Next step
- [ ] Pull 30-day stats for all listings and pick the 5 with views but no sales for the first rewrite.

## Source reels
- [[2026-10-09 bobbby.rn DeSfhW0sHKX]]
- [[2026-10-05 peterstewiestartup DeHYCIpColc]]
