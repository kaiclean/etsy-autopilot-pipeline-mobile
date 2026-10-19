---
status: idea
type: software feature
effort: M
potential: high
source_reels: ["[[2026-10-16 restructureai DeihbtONYtH]]", "[[2026-10-12 shanepduggan DeZJG4Oib3b]]", "[[2026-09-26 liamjohnston.ai Ddw2K7_CtrK]]", "[[2026-10-04 adilet.fndr DeEiGKKIKqB]]", "[[2026-10-03 opusjake DeB6QU6N4Ec]]", "[[2026-09-29 joshmakesmula Dd48pTIAMN_]]"]
created: 2026-10-18
tags: [idea, software-feature]
---
# Comment-to-DM Funnel for OmniShop

## Problem
Six of the 22 saved reels use the same growth trick: 'Comment X and I'll DM you the link.' It boosts comments (and so reach) and moves viewers straight to a product. OmniShop needs this to turn reel viewers into Etsy visitors.

## Concept
Every OmniShop reel gets a keyword (for example 'PLANNER'). When someone comments it, they get a DM with the matching Etsy listing link (UTM/Etsy source tracking) and a public reply. Buyer-intent comments ('how much?', 'ship to Germany?') are tagged and answered, following Module 2 of the AI-marketing-team reel.

## How to build it for real
1. Make OmniShop an Instagram Professional (Business) account connected to a Facebook Page.
2. Option A (fast): ManyChat or a similar Meta-approved tool with keyword-to-DM flows, which is the official route.
3. Option B (own): a small Meta app using the Instagram Graph API webhooks (comments) + Instagram Messaging API (private replies). Needs Meta app review for instagram_manage_comments / instagram_manage_messages. Host the webhook on the existing Vercel/Railway stack and store mappings keyword → Etsy listing URL in Neon.
4. Track clicks with a redirect (/go/planner → Etsy listing with ?utm_source=omnishop_ig) to measure reel → visit.
5. Weekly report in OmniBrain: comments, DMs sent, clicks per reel.

## Etsy fit
Directly drives traffic to the Etsy listings, which is OmniShop's core goal.

## Next step
- [ ] Once OmniShop is created, switch it to a Business account and set up a ManyChat keyword flow for the first product reel.

## Source reels
- [[2026-10-16 restructureai DeihbtONYtH]]
- [[2026-10-12 shanepduggan DeZJG4Oib3b]]
- [[2026-09-26 liamjohnston.ai Ddw2K7_CtrK]]
- [[2026-10-04 adilet.fndr DeEiGKKIKqB]]
- [[2026-10-03 opusjake DeB6QU6N4Ec]]
- [[2026-09-29 joshmakesmula Dd48pTIAMN_]]
