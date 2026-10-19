---
status: idea
type: software feature
effort: L
potential: medium
source_reels: ["[[2026-09-29 joshmakesmula Dd48pTIAMN_]]", "[[2026-10-03 opusjake DeB6QU6N4Ec]]", "[[2026-10-05 peterstewiestartup DeHYCIpColc]]"]
created: 2026-10-18
tags: [idea, software-feature]
---
# Own Storefront Next to Etsy

## Problem
Etsy fees (listing + 6.5% transaction + payment processing + offsite ads) eat margin, and Kai doesn't own the customer relationship. The 'Claude rebuilt a Shopify store' reels show a full storefront can be generated quickly.

## Concept
A designedbykai storefront on Kai's existing Vercel + Neon stack: products synced from Etsy listings, Stripe (TWINT via Stripe for CH) checkout, instant digital delivery via signed R2/Blob links, email capture. Etsy stays the discovery engine and the own shop handles repeat customers and bundles. Built from Kai's own listings, not by cloning other brands.

## How to build it for real
1. Next.js storefront generated from the Etsy listing export (images, titles, descriptions).
2. Stripe Checkout + webhook → signed download link email (Resend).
3. Neon tables: products, orders, customers; discount codes for Etsy buyers (insert card in POD packages).
4. PostHog for funnel analytics (free tier, from the free-stack reel).
5. Legal: Swiss Impressum, AGB, privacy (revDSG), VAT check.

## Etsy fit
Complements Etsy rather than replacing it. Higher margin on returning buyers.

## Next step
- [ ] Decide after the first 50 Etsy sales; prototype only the digital-download checkout first.

## Source reels
- [[2026-09-29 joshmakesmula Dd48pTIAMN_]]
- [[2026-10-03 opusjake DeB6QU6N4Ec]]
- [[2026-10-05 peterstewiestartup DeHYCIpColc]]
