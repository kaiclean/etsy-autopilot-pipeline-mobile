---
title: "Online Selling Business Plan: Kai (KaiLean Lienhard), Switzerland"
date: "24 September 2026"
---

# Online Selling Business Plan: Kai (KaiLean Lienhard), Switzerland

*Prepared 24 Sep 2026. All sources were accessed 24 Sep 2026 unless noted otherwise. FX rate used: 1 USD = 0.8278 CHF, 1 EUR = 0.9409 CHF (ECB reference rate via frankfurter.app, 24 Sep 2026). If a figure could not be verified, the plan says so. It does not estimate a number to fill the gap.*

---

## 0. Executive summary

**Recommendation #1: an Etsy shop that combines AI-assisted digital downloads with print-on-demand (POD), fulfilled by Printful, Printify or Gelato.**
**Backup: Amazon KDP**, publishing low- and medium-content paperbacks such as coloring, activity and puzzle books. KDP can reuse the same art pipeline.

Decisive reasons:

1. **Built-in buyer traffic with near-zero capital.** Similarweb put etsy.com at **465.9M visits in Aug 2026**, up 22% year over year. That compares with ebay.com at 670M, amazon.com at 2.8B, ricardo.ch at about 6.7M and tutti.ch at about 4.5M (Semrush, Aug 2026). Etsy's buyer base is **86.97M active buyers** (Q2 2026). A Shopify store, Gumroad, Payhip or Lemon Squeezy gives you no comparable free traffic.
2. **Swiss sellers are fully supported.** Etsy Payments lists **Switzerland** as a supported country, with payouts in CHF to a Swiss bank. Since 1 Jan 2025, Etsy collects **8.1% Swiss VAT** on orders to Swiss addresses.
3. **Low, per-use fees.** The costs are a **USD 0.20 listing fee**, a **6.5% transaction fee** and **4% + CHF 0.50 payment processing**, plus 8.1% VAT on those fees for Swiss sellers. The only fixed cost is a one-time setup fee. Etsy now says it "varies by location", and sellers have reported USD 15–29. There is no monthly fee.
4. **The policy explicitly allows this model.** Etsy's Creativity Standards allow "seller-prompted AI creations" (you must disclose AI use in the description) and "original designs produced by a production partner" (POD). **Reselling dropshipped goods is not allowed**, and eBay also bans retail-arbitrage dropshipping, so a design-based model is the compliant one.
5. **The highest share of automation among the candidates.** Digital files are delivered automatically by Etsy. For POD, Printful, Printify and Gelato import orders, then produce and ship them automatically. Listings can be created through the **Etsy Open API v3** and the **Printify API**. Design generation can run through Kai's existing **Higgsfield** account, whose terms grant commercial rights to outputs.
6. **Fastest path to first profit.** A digital download keeps about **80% of the price** after all Etsy fees (CHF 6.37 of CHF 8.00; see §6). A POD poster keeps about **41%** before ads. Neither needs inventory, and 30 days of Etsy Ads at the USD 1/day minimum costs CHF 24.83.
7. **Demand now.** eRank's August 2026 list of top US Etsy searches includes "wall art" (#3), "digital products" (#6), "halloween shirt" (#14), "christmas" (#15, a month earlier than last year), "poster" (#16) and "personalized gift" (#18). The 30-day launch runs straight into Q4.

**Budget:** about **CHF 76 in total** (§5), under the CHF 100 target.

**Honest expectation:** Etsy's average GMS per active seller works out to about **USD 450 per quarter** (USD 2.583B GMS ÷ 5.706M sellers, Q2 2026). That is a mean, and the distribution is heavily skewed toward a few large shops. A realistic target for the first 90 days is a few sales to a few hundred CHF in revenue, not a full income (§10).

---

## 1. Candidate comparison

### 1.1 Traffic (monthly visits)

| Marketplace | Monthly visits | Source / date |
|---|---|---|
| amazon.com | 2.8B (amazon.de 423.4M) | Similarweb Top-100, Aug 2026 [S1] |
| ebay.com | 670.0M | Similarweb Top-100, Aug 2026 [S1] |
| etsy.com | 465.9M (+22.0% YoY) | Similarweb Top-100, Aug 2026 [S1] |
| pinterest.com (free traffic source) | 1.6B | Similarweb, Aug 2026 [S1] |
| ricardo.ch | ~6.74M | Semrush, Aug 2026 [S2] (no Similarweb figure retrieved) |
| tutti.ch | ~4.53M | Semrush, Aug 2026 [S2] |
| gumroad.com / payhip.com / lemonsqueezy.com | **not verified** | Their marketplaces do not send buyers the way Etsy does |
| TikTok Shop | not available in CH | [S14] |

### 1.2 Scorecard

| Model | Can a Swiss resident sell? | Startup cost | Seller fees (verified) | Dropshipping / AI policy | Margin potential | Automation | Verdict |
|---|---|---|---|---|---|---|---|
| **Etsy: digital + POD** | Yes. Etsy Payments supports CH, 4% + CHF 0.50 [S3][S4] | Setup fee "varies by location" (reported USD 15–29) [S5]; USD 0.20 per listing | 6.5% transaction + 4% + CHF 0.50 processing; Offsite Ads 15% on attributed sales (opt-out possible under USD 10k/yr) [S3][S12]; 8.1% VAT on fees [S13] | AI allowed with disclosure; POD allowed with production-partner disclosure; resale/dropshipping not allowed [S6][S7] | Digital ~80%; POD ~30–45% before ads (§6) | High: API, POD sync, automatic digital delivery | **#1** |
| **Amazon KDP** | Yes. Swiss residents file a W-8BEN; the US–CH treaty generally sets 0% withholding on royalties [S15] | CHF 0 | eBook 70%/35%; paperback 60% of list price minus printing ($1.00 + $0.012/page for 110–828 pages, regular trim) [S15][S16] | AI content allowed but must be disclosed privately; upload limit cut to **2 new titles per format per week** (reported 24 Sep 2026) [S17] | About USD 2–4 per paperback at typical prices | High for fulfillment; the upload cap limits volume | **Backup** |
| Amazon Merch on Demand | Unclear for CH. Invite-only; reported marketplaces are US/UK/DE/FR/IT/ES/JP [S18] | CHF 0 | Royalty per product | Invite-only, approval not guaranteed | n/a | High | Apply in parallel (free) |
| Amazon FBA (EU) | Yes, but storing inventory in DE requires **German VAT registration from the first sale** [S19] | €39/month Professional plan + inventory + VAT compliance [S20] | 8–15% referral on most categories [S20] | Own inventory required | Varies | Medium | Rejected: capital and compliance |
| eBay (dropshipping / reselling) | Yes (ebay.ch) | Free listings (quota) | ebay.ch private sellers: 11% up to CHF 1,990 + 0.35% regulatory fee [S21] | **Buying from another retailer/marketplace to ship to the buyer is prohibited**; wholesale dropshipping only [S8] | Thin | Medium | Rejected as main channel |
| Ricardo.ch | Yes (Swiss) | Listing free (except vehicles) | 8–12% success commission, min CHF 0.10, max CHF 290 [S9] | C2C/secondhand oriented | Depends on sourcing | Low (manual shipping) | Only for one-off cash-flow reselling |
| Tutti.ch | Yes | Free up to 50 active ads; tuttiPRO from CHF 39/month [S10] | No commission [S10] | Classifieds, mostly no checkout | n/a | Low | Rejected |
| Shopify + AliExpress/CJ/Zendrop | Yes | CHF 1/month for 3 months, then CHF 29/month (Basic, CH) [S22] | Plus payment and app fees | Allowed, but **no built-in traffic**, so paid ads are needed. Typical CAC **not verified** | Varies; ad-driven | High technically | Rejected at <CHF 100 (ads budget) |
| Gumroad | Yes (merchant of record) | CHF 0 | **10% + $0.50** direct; **30%** via Discover [S23] | Digital only | ~85–90% | High | Later: off-Etsy channel |
| Payhip / Lemon Squeezy | Yes | CHF 0 | Payhip free plan 5% + Stripe/PayPal; LS 5% + 50¢ (merchant of record) [S24] | Digital only | ~90% | High | Later: own-audience channel |
| TikTok Shop | **No.** Not live in CH; EU seller countries include DE, FR, IT, ES, IE, PL, NL, BE, AT, PT, HU, CZ, GR, UK [S14] | n/a | n/a | n/a | n/a | n/a | Not available |

**Why Etsy beats eBay, Ricardo, Tutti and Amazon FBA for this goal.** eBay's policy says sellers must not "list an item on eBay and then purchase the item from another retailer or marketplace that sends it directly to the customer" [S8]. That rules out the zero-capital version of eBay dropshipping. The Swiss marketplaces have roughly 1–2% of Etsy's traffic and suit one-off secondhand sales, not automatable original products. Amazon FBA needs inventory capital and EU VAT registration.

**Why Etsy beats Shopify dropshipping.** Shopify has no organic marketplace traffic, so first sales depend on paid ads, and CHF 100 does not buy a statistically useful ad test.

**Time to first sale.** No platform publishes reliable time-to-first-sale data, and none was found. Anecdotally, Etsy sellers commonly report their first sale within weeks when they have 20+ well-keyworded listings, but treat that as **unverified**.

---

## 2. Recommended model in detail

**Model:** "Designed by Kai" Etsy shop, in two product lines that share one design pipeline.

- **Line A: digital downloads (starts cash flow).** Printable wall-art sets, editable party invitations (sold as template links such as Canva or Corjl), coloring pages and stream overlays/emotes. Etsy delivers the file automatically, so there is no fulfillment cost.
- **Line B: POD physical products (bigger basket, gift season).** Posters and art prints produced by **Gelato**, which routes orders to local production in 32 countries [S25], or **Printful/Printify** [S11]. Add apparel (Halloween/Christmas shirts, sweatshirts) and mugs from the same designs.

**Compliance that must be built in.** Include an AI disclosure sentence in every description. Set "Designed by" and add the production partner and its correct ship-from location in Etsy's production-partner settings [S6][S7]. Use only original prompts: since the June 2025 wording change, designs must be "based on a seller's original design" [S26]. Do not sell prompt bundles.

## 3. Niche selection method and example niches

**Method (repeat weekly):**

1. **Seed from demand data.** Use eRank Trend Buzz (free plan: 5 keyword lookups/day; Basic USD 5.99/month for 100/day [S27]) and eRank's monthly "Top keywords" report. Also use Etsy's **Marketplace Insights** in Shop Manager (last 30 days of Etsy search data) and Etsy search autocomplete.
2. **Filter.** Keep long-tail phrases with high click-through rates (eRank flags 125%+ as strong purchase intent) and **low competition**. Drop anything trademarked; check USPTO and Swissreg.
3. **Validate supply.** Count results for the exact phrase on Etsy, and look at price bands and review counts of the top 20 listings.
4. **Test cheaply.** Publish 5–10 listings per niche, give them 14–21 days, then scale the niches that get views and favorites and prune the ones that don't.

**Five example niches, with the demand signals available as of Sep 2026.** Absolute search volumes are behind eRank's paywall and were **not verified**. The signals below are ranks and CTRs from eRank's public reports [S28][S29].

| # | Niche | Demand signal | Line | Why it fits Kai |
|---|---|---|---|---|
| 1 | **Alpine / Swiss-mountain minimalist wall art** (printable sets + POD posters) | "wall art" #3 and "poster" #16 in US Etsy searches (Aug 2026); "art print" and "painting" at 150% monthly CTR; eRank notes European buyers favor heritage, countryside and woodland themes [S28][S29] | A + B | Authentic Swiss angle, and Higgsfield can do the art |
| 2 | **Gothic / dark-floral autumn-Halloween designs** (shirts, prints, phone cases) | "halloween" #2 and "halloween shirt" #14; eRank Fall 2026: "Autumn florals get a gothic twist", plum/burgundy palettes; "halloween png" has a high CTR [S28][S29] | B (+ PNG downloads) | Seasonal; must launch by early October |
| 3 | **Christmas / "cozymaxxing" gifts** (ornament designs, mugs, cozy prints) | "christmas" up to #15 from #29, "personalized gift" #18 from #48, "mug" #17, "christmas ornaments" high CTR [S28]; eRank's cozy-home trend [S29] | B | Q4 peak |
| 4 | **Editable birthday invitations** (non-trademarked themes, e.g. "one silly goose") | "one silly goose birthday invitation": 150% CTR, +115,800% YoY, flagged as low competition (Aug 2026) [S28] | A | Pure digital; templating can be automated |
| 5 | **Stream overlays / Twitch emotes / VTuber assets** | "vtuber model" 140% CTR, "twitch overlay" and "twitch emotes" high CTR in the top 200; eRank notes this category is also strong in the UK, CA and AU [S28] | A | Technical, global and no shipping; watch AI-disclosure expectations in the gamer niche |

**Avoid:** trademarked themes such as "pokemon", "spiderman" and "sonic birthday invitation", even though they sit in the top-20 lists [S28]. They are the fastest way to lose the account.

## 4. 30-day launch timeline (starts Fri 25 Sep 2026)

**Week 1 (Days 1–7): accounts, research, pipeline**

- **Day 1:** (1) Open the Etsy shop with a Swiss bank account and CHF currency, pay the setup fee, and enable 2FA. (2) Create free Gelato and Printful (or Printify) accounts and connect them to Etsy. (3) Register an Etsy developer app (Open API v3, own-shop use) and a Printify API token. Run eRank's free plan on the 5 niches.
- **Day 2:** Fill in the shop profile, About section (production-partner story), policies and shipping profiles. Pick 2 launch niches (suggested: #1 Alpine wall art and #2 or #3 seasonal).
- **Day 3–4:** Build the design pipeline: Higgsfield (generate → upscale) → Google Drive folder → Neon `designs` table. Generate 30–40 candidate designs; a human (Kai) selects 20.
- **Day 5:** Build the listing-writer prompt (140-char title, 13 tags of ≤20 characters, description with AI disclosure and production-partner line). Build the Printify/Printful mockup step.
- **Day 6–7:** Order **one physical sample** (poster) for quality checks and real photos. Publish the first **10 digital listings** manually, to learn the UI and set "How it's made" / AI tools, which the API does not expose [S30].

**Week 2 (Days 8–14): volume**

- Publish 15 POD listings through Printify/Printful→Etsy (API or dashboard). Complete the production-partner and AI fields in the Etsy UI.
- Reach **25–30 live listings** in total. Start **Etsy Ads at USD 1/day** on the 5 best listings from Day 10.
- Set up Pinterest (1.6B monthly visits [S1]) and auto-pin every listing.

**Week 3 (Days 15–21): automate and iterate**

- Deploy Vercel cron jobs: a daily pull of listing stats and receipts into Neon, plus a Sentry alert if a job fails.
- Add 15–20 listings in the winning niche. Test price points (for example, digital sets at CHF 6 / 8 / 12).
- Write message templates for common CS questions (for use as Etsy saved replies).

**Week 4 (Days 22–30): optimize, add the backup**

- Prune or rework listings with no views, and rewrite titles and tags on those with views but no favorites.
- Reach **~50 listings**. Launch Christmas designs by Day 30; Etsy's Q4 demand is already rising [S28].
- Start the backup: turn 30 of the best line-art designs into **one KDP coloring book** (the upload cap is 2 per format per week [S17]). Submit a Merch on Demand invitation request (free).
- **Day 30 review:** views, CTR, conversion and CHF profit per niche. Go/no-go for month 2.

## 5. Starting budget (CHF)

| Item | Cost | Note / source |
|---|---|---|
| Etsy setup fee | **24.00** (worst case, ≈USD 29) | Varies by location; reports range USD 15–29 [S5]. Exact CH amount shown at onboarding, **not verified** |
| 50 listings × USD 0.20 | 8.28 | [S3] |
| Etsy Ads, 20 days × USD 1 | 16.56 | USD 1/day minimum [S12] |
| Physical sample (A3 poster + shipping to CH) | 20.00 (estimate) | Printful A3 matte poster USD 10.90 in the catalog API; shipping to CH **not verified** |
| eRank Basic, 1 month (optional) | 4.96 | USD 5.99 [S27]; the free plan works too |
| 8.1% VAT on Etsy fees | ~2.00 | [S13] |
| Higgsfield, Gamma, Vercel, Neon, Google Drive | 0 incremental | Kai's existing accounts; free tiers suffice. Higgsfield free-plan images are **watermarked**, so a paid plan is needed for sellable files [S31] |
| POD platforms (Gelato / Printful / Printify free plans) | 0 | [S11][S25] |
| KDP / Merch application | 0 | |
| **Total** | **≈ CHF 76** | Buffer to CHF 100 for extra ads or a second sample |

POD production cost is paid **per order** from the customer's money. Etsy may hold new-seller funds for about 14 days and apply reserves [S32], so keep about CHF 50–100 of card headroom to pre-fund the first POD orders. This is working capital, not spend.

## 6. Unit economics (real fee numbers)

**A. Digital printable set, listed at CHF 8.00, buyer outside CH**

| Line | CHF |
|---|---|
| Price | 8.00 |
| Listing fee (USD 0.20) | −0.17 |
| Transaction fee 6.5% | −0.52 |
| Processing 4% + CHF 0.50 | −0.82 |
| 8.1% VAT on fees | −0.12 |
| **Net** | **6.37 (79.7%)** |
| If attributed to Offsite Ads (15%) | −1.20 → 5.17 |

**B. POD poster (Printful Enhanced Matte A3), listed at CHF 29.00 with free shipping, US buyer**

| Line | CHF |
|---|---|
| Price | 29.00 |
| Printful A3 base USD 10.90 + US shipping USD 4.99 [S11b] | −13.15 |
| Listing + transaction + processing | −3.71 |
| VAT on fees | −0.30 |
| **Net profit** | **11.84 (40.8%)** |
| If attributed to Offsite Ads (15%) | 7.49 |

**C. KDP paperback (backup), 6×9", 120 pages, black ink, USD 8.99 on amazon.com**
Royalty = 60% × 8.99 − (1.00 + 120 × 0.012) = **USD 2.95 ≈ CHF 2.45 per copy** [S16].

*Notes.* Listing in CHF avoids Etsy's 2.5% currency-conversion fee [S3]. Etsy calculates processing fees on the total including any tax it collects [S4], so the real fee is slightly higher on taxed orders. Onsite Etsy Ads are paid per click, and their cost per sale is not known until you test.

## 7. Automation architecture

```
[Research agent] eRank (manual/limited) + Etsy Marketplace Insights + Etsy autocomplete
        │   keywords → Neon `keywords`
        ▼
[Design agent] Higgsfield MCP: generate_image → upscale_image / outpaint_image / remove_background
        │   files → Google Drive; metadata → Neon `designs`
        ▼  (HUMAN GATE: Kai approves designs; IP/trademark check)
[Listing agent] LLM writes title/13 tags/description (+AI & production-partner disclosure)
        │
        ├─ POD:     Printify API  POST /v1/shops/{id}/products.json → publish.json (→ Etsy)  [S33]
        │           or Printful/Gelato dashboard sync; mockups auto-generated
        └─ Digital: Etsy Open API v3 createDraftListing + listing file/image upload  [S34]
        ▼  (HUMAN GATE: set "How it's made"/AI-tools field in Etsy UI, then activate) [S30]
[Fulfillment] Etsy auto-delivers digital files; POD partner auto-imports orders, prints, ships, pushes tracking
        ▼
[Analytics agent] Vercel cron → Etsy API (receipts, listings) → Neon; Sentry monitors jobs
        ▼
[Optimizer agent] weekly: prune/re-tag/re-price via Etsy API updateListing; propose new designs
[Marketing] Pinterest auto-pins; Etsy Ads (UI only); optional X Ads / Gamma lookbooks later
[CS] Etsy has NO messaging API [S35] → saved replies + AI-drafted answers pasted by Kai
```

**What the agents can run:** trend and keyword research summaries, design generation and upscaling, mockups, listing copy and SEO, bulk creation of POD products and Etsy drafts, re-pricing and re-tagging, order and stat syncing into Neon, reporting, and generating KDP interiors and covers.

**What still needs a human:**

- Approving designs and screening them for IP.
- The per-listing "How it's made" / AI-tool disclosure, which the API does not expose. This comes from an open developer feature request on GitHub, Jun 2026 [S30].
- Replying to buyer messages. There is no messaging API [S35].
- Etsy Ads settings.
- Checking sample quality.
- Handling disputes, account verification and taxes.

**API limits:** Etsy applies per-app QPS/QPD rate limits, prohibits scraping, and prohibits using Etsy data for AI training [S34b].

## 8. Key risks and mitigations

| Risk | Detail | Mitigation |
|---|---|---|
| Account suspension | New shops are verified; policy violations lead to removal or suspension; funds can be held (≈14-day holds, reserves) [S32] | Truthful disclosures, realistic processing times, no trademark terms, one shop only |
| AI/Creativity policy | AI allowed only from your own prompts, with disclosure; standards tightened in June 2025 [S6][S26] | Disclosure template in every listing; no prompt bundles; keep prompt logs in Neon as proof of original direction |
| IP / trademark | Top searches are full of trademarks (pokemon, spiderman, sonic) [S28] | Check USPTO/Swissreg/EUIPO; automated blocklist in the listing agent |
| Saturation | 5.7M active sellers [S36]; "digital products" is very competitive | Long-tail niches, a Swiss/Alpine angle, quality mockups |
| KDP policy | Upload cap reduced to 2 titles per format per week (reported 24 Sep 2026) [S17]; AI disclosure required [S15b] | Quality over volume |
| Swiss VAT / customs | Etsy collects 8.1% on orders to CH; POD parcels to CH need Etsy's VAT data on the label to avoid double VAT [S37]. Kai's own MWST obligation starts only at **CHF 100k** turnover [S38] | Use POD integrations that transmit Etsy VAT data (Prodigi and Gelato do; verify for your provider) |
| Income tax / social security | Profit is taxable income. For a side business, AHV/IV/EO contributions on net profit up to **CHF 2,500/year** are charged only on request [S38]. Commercial-register entry is mandatory from **CHF 100k** revenue [S38] | Keep simple bookkeeping (CSV exports into Neon); report to the AHV Ausgleichskasse once activity is regular |
| US royalties (KDP) | 30% withholding without a W-8BEN; 0% under the treaty [S15] | Complete the tax interview |
| Platform concentration | One Etsy account is a single point of failure | Month 2+: mirror digital products to Gumroad/Payhip; KDP backup |

## 9. Backup plan: Amazon KDP (details)

- **Why:** zero cost, Amazon's traffic (2.8B visits/month on amazon.com alone [S1]), fulfillment and printing fully handled by Amazon, and Swiss residents supported through a W-8BEN at a 0% treaty rate [S15].
- **Product:** coloring books built from the same Alpine, gothic-floral and cozy line-art designs, plus puzzle and activity books.
- **Constraints:** 2 new titles per format per week [S17]; AI must be disclosed to KDP [S15b]; royalties of about USD 2–4 per paperback.
- **Trigger to switch weight to KDP:** if Etsy restricts the account, or after 60 days fewer than 10 Etsy sales from 50+ listings.

## 10. Honest expectations

- **Benchmark:** Etsy marketplace GMS was USD 2.583B in Q2 2026 across 5.706M active sellers, about **USD 453 per seller per quarter** on average [S36]. The median is much lower, because a few large shops drive most GMS. A median figure is **not published**.
- **Scenario assumptions** (not measured data): 50 listings by Day 30, rising to 150–200 by month 4. Many new listings get very little search visibility for weeks.
  - **Month 1:** 0–10 sales is a normal outcome. Profit is probably negative after the ~CHF 76 of spend.
  - **Months 2–3:** tens of sales per month if at least one niche works. At the unit margins in §6 (CHF 5–12 per sale), that is roughly **CHF 50–500/month profit**.
  - **Months 4–12:** a shop with a proven niche and 200+ listings could plausibly reach **CHF 500–2,000/month revenue**. Many shops never do. Treat this as a target range, not a forecast.
- **What cannot be fully automated:** IP judgment, the per-listing AI/process disclosure field, buyer messages, disputes and account verification, Etsy Ads management, final taste and quality control, and tax filings.

## 11. Things that could not be verified

- The exact Etsy setup fee for Switzerland (Etsy only says it "varies by location").
- Traffic for Gumroad, Payhip and Lemon Squeezy.
- A Similarweb figure for ricardo.ch and tutti.ch (Semrush figures were used instead).
- Ricardo's per-category commission table (the page was blocked by Cloudflare; figures come from Ricardo's help-center search snippet).
- Absolute Etsy search volumes (eRank paywall).
- Printful/Gelato shipping cost to Switzerland.
- Whether Swiss residents are accepted for Merch on Demand.
- Typical Shopify dropshipping CAC.
- Time-to-first-sale statistics.
- The KDP upload-limit change: only The Bookseller's headline (24 Sep 2026) and a secondary summary were confirmed.
- Kai's current Higgsfield plan and whether it is watermark-free.

## Sources (accessed 24 Sep 2026)

- [S1] Similarweb, Top 100 most visited websites, Aug 2026 (published 17 Sep 2026): https://www.similarweb.com/blog/research/market-research/most-visited-websites/
- [S2] Semrush, ricardo.ch / tutti.ch overviews, Aug 2026: https://www.semrush.com/website/ricardo.ch/overview/ ; https://www.semrush.com/website/tutti.ch/overview/ ; https://www.semrush.com/trending-websites/ch/retail
- [S3] Etsy Fees & Payments Policy: https://www.etsy.com/legal/fees/
- [S4] Etsy Payments Policy / processing fees table: https://www.etsy.com/legal/etsy-payments/ ; https://help.etsy.com/hc/en-us/articles/115015628847
- [S5] Etsy setup fee: https://help.etsy.com/hc/en-us/articles/115014483627 ; https://www.valueaddedresource.net/etsy-variable-shop-setup-fee/
- [S6] Etsy Creativity Standards: https://www.etsy.com/legal/creativity/
- [S7] Etsy production partners: https://help.etsy.com/hc/en-us/articles/360000336547
- [S8] eBay third-party fulfilment / dropshipping policy: https://www.ebay.com.au/help/policies/selling-policies/third-party-fulfilment-policy?id=4718
- [S9] Ricardo commissions: https://help.ricardo.ch/hc/de/articles/360000171809 ; https://help.ricardo.ch/hc/de/articles/115002854885
- [S10] tutti.ch tuttiPRO: https://www.tutti.help/hc/de/articles/14176828838802
- [S11] Printify pricing: https://printify.com/pricing/ ; [S11b] Printful catalog API (product 1, A3 USD 10.90): https://api.printful.com/products/1 ; Printful shipping: https://www.printful.com/shipping
- [S12] Etsy Ads / Offsite Ads: https://help.etsy.com/hc/en-us/articles/360033701174 ; https://help.etsy.com/hc/en-us/articles/360000338367
- [S13] VAT on Etsy seller fees: https://help.etsy.com/hc/en-us/articles/360040584433
- [S14] TikTok Shop Switzerland: https://www.openstream.ch/wann-startet-tiktok-shop-in-der-schweiz/ ; https://vorsprung-schweiz.ch/tiktok-shop-marktplatz-zehn-europaeische-laender/ ; https://newsroom.tiktok.com/tiktok-shop-expands-across-europe?lang=en-150
- [S15] KDP eBook royalties: https://kdp.amazon.com/help/topic/G200644210 ; US–Swiss tax treaty: https://www.irs.gov/pub/irs-trty/swiss.pdf ; [S15b] KDP content guidelines (AI disclosure): https://kdp.amazon.com/help/topic/G200672390
- [S16] KDP paperback printing cost: https://kdp.amazon.com/en_US/help/topic/G201834340
- [S17] The Bookseller, "Amazon reduces weekly KDP uploads from 10 to two per format", 24 Sep 2026: https://www.thebookseller.com/news/amazon-reduces-weekly-kdp-uploads-from-10-to-two-per-format
- [S18] Merch on Demand: https://merch.amazon.com/resource/201858580 ; https://merchtitans.com/blog/amazon-merch-on-demand-application-guide
- [S19] German VAT for Swiss FBA sellers: https://vaytax.com/switzerland-sellers ; https://vaytax.com/amazon-fba
- [S20] Amazon.de pricing: https://sell.amazon.de/preisgestaltung
- [S21] ebay.ch fees: https://www.ebay.ch/verkaeuferportal/verkaeufer-news/2022-februar/gebuehren ; https://www.ebay.ch/verkaeuferportal/gesetzliche-steuerliche-vorgaben/gebuehr-gesetzliche-betriebskosten
- [S22] Shopify CH pricing: https://www.shopify.com/ch/preise
- [S23] Gumroad pricing: https://gumroad.com/pricing
- [S24] Payhip / Lemon Squeezy comparison: https://www.wearefounders.uk/best-platforms-for-selling-digital-products-in-2026/
- [S25] Gelato: https://www.gelato.com/print-on-demand/etsy ; https://www.gelato.com/print-on-demand/switzerland
- [S26] Etsy AI policy change analysis (June 2025): https://iscompliant.app/Blog/etsy-creativity-standards-pod-sellers-guide
- [S27] eRank plans: https://erank.com/plans
- [S28] eRank "Top Keywords on Etsy Now" (3 Sep 2026): https://help.erank.com/blog/top-keywords-on-etsy/
- [S29] eRank "Fall 2026 Trends" (4 Aug 2026): https://help.erank.com/blog/fall-2026-trends-etsy-sellers/
- [S30] Etsy open-api GitHub discussion #1630 (Jun 2026): https://github.com/etsy/open-api/discussions/1630
- [S31] Higgsfield ownership / watermark: https://higgsfield.ai/terms-of-use-agreement ; https://higgsfield.ai/creator-hub/help-center/credits/watermark-and-how-to-remove
- [S32] Etsy deposits / holds: https://help.etsy.com/hc/en-us/articles/360002080688
- [S33] Printify API: https://developers.printify.com/ ; https://help.printify.com/hc/en-us/articles/4483626447249
- [S34] Etsy Open API v3 listings tutorial: https://developer.etsy.com/documentation/tutorials/listings ; [S34b] Etsy API Terms: https://www.etsy.com/legal/api/
- [S35] Etsy open-api discussion #677 (no messages API): https://github.com/etsy/open-api/discussions/677
- [S36] Etsy Q2 2026 results: https://investors.etsy.com/news-events/press-releases/detail/225/etsy-inc-reports-second-quarter-2026-results
- [S37] Prodigi, Etsy orders to Switzerland (VAT since 1 Jan 2025): https://support.prodigi.com/hc/en-us/articles/19582822905628 ; ESTV platform info: https://www.estv.admin.ch/dam/en/sd-web/zSFiW4RSJF7o/mwst-publ-mi27-elektronische-plattformen-en.pdf
- [S38] Canton Zurich, side self-employment: https://www.zh.ch/de/wirtschaft-arbeit/unternehmensportal/opu/firma-gruenden/selbstaendig-werden/selbstaendigkeit-im-nebenerwerb.html ; AHV leaflet 2.02: https://www.ahv-iv.ch/Portals/0/Documents/Merkblaetter/Gruppe_2/2.02_d.pdf ; KMU sole proprietorship: https://www.kmu.admin.ch/de/rechtsform-einzelunternehmen
