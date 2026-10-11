# Multi-marketplace foundation (blocked pending Etsy traction)

Dependency order: **4 of 4**, after issues 1–3 and [#36](https://github.com/kaiclean/etsy-autopilot-pipeline-mobile/issues/36). This is design and an isolated adapter contract only, not permission to launch another channel. Etsy remains the sole publishing path. No change to `PUBLISH_MODE`, publish-mode resolution, the publish pipeline, activation, or publish gates.

## Data flow and interface

```text
Existing listing + verified supplier options + gallery/mockup URLs
    → explicit URL-only MarketplaceListing projection
    → Marketplace.upsertListing
        EtsyMarketplace → existing Etsy adapter selected by getEtsyAdapter
        ShopifyDryRunAdapter → { query, variables } productSet preview only
    → human review (future optional marketplace_listings persistence)
```

There is no adapter registry, cron integration, Shopify connection action, live Shopify adapter, or network call in the Shopify adapter. Neither new adapter is wired into the existing publish pipeline.

`src/adapters/marketplace/types.ts` defines `Marketplace` (`id`, `mode`, `upsertListing`, `getListingStatus`, `listOrders`) and portable listing, result, status, and order types. Mode is adapter-local: Shopify is always `dry-run`, regardless of credentials or global publish settings. A Shopify result has no external ID for a new product (`null`); an explicitly supplied ID is echoed as a target, not proof it exists. No synthetic products, sales, stock, or status reads are generated.

The Etsy wrapper accepts an **already-selected** `EtsyAdapter`; the existing factory remains responsible for credentials and read/write intent. It delegates draft creation, image/file uploads, and receipts with unchanged inputs, order, prices, quantities, mode, and simulation options. It does not activate listings. Existing Etsy methods remain untouched. Because Etsy's adapter has no update or listing-state read operation, updates and supplied variants fail before writes, and status reads return `unknown`. `getListingStats` is not an authoritative state read. Existing dry-run receipt simulation is preserved, not expanded.

Shopify status reads likewise return `unknown`; order reads return `[]` (no sync implemented). These values must not be presented as a successful connection or a confirmed empty live order feed.

## Listing field mapping

| Source / portable field | Etsy wrapper | Shopify `productSet` preview |
| --- | --- | --- |
| `title` | unchanged draft title | `input.title` |
| Plain-text `description` | unchanged | HTML-escaped `input.descriptionHtml`; line breaks become `<br>` |
| `tags` | unchanged | `input.tags`, without new tags |
| `priceChf` | unchanged CHF number | variant `price` as a two-decimal string |
| `productType` | digital → `download`; POD → `physical` | variant `inventoryItem.requiresShipping`: false / true |
| Optional `quantity` | passed to draft creation | not mapped to inventory: stock/location data is not known |
| Optional `variants[].optionValues` | unsupported; fails before writes | named `productOptions[].values` objects and variant `optionValues` objects |
| Optional `variants[].priceChf` | unsupported | explicit variant price, otherwise the listing price |
| `images[].url`, optional `alt` | image URLs passed to existing uploader | `input.files[]`: `originalSource`, `contentType: IMAGE`, supplied `alt` only |
| Optional delivery `files[]` | separate existing file uploads | deliberately excluded; product media is not digital delivery |
| Optional `externalId` | unsupported update; no duplicate creation | `variables.identifier.id` (Shopify product GID); omitted for create |
| State | draft only | always `DRAFT`; no publication or channel assignment |

The current database has one `priceChf` and one gallery `imageUrl`, **not** a verified variant catalog. The portable projection uses `images: [{ url: row.imageUrl }]`; additional mockups/options must come from verified inputs, not guessed sizes, SKUs, or supplier defaults. No variants supplied means Shopify's structural single-variant convention (`Title` / `Default Title`), not a claim about product features. An explicitly empty variant list is rejected. Supplied variants must have one to three distinct named options, consistent option names, unique combinations, and finite non-negative prices.

Shopify prices use the shop's currency. This preview assumes **CHF**, matching `priceChf`; there is no exchange-rate conversion or shop-currency verification. Before any live implementation, verify store currency and reject mismatches or use an explicit, audited conversion. Never reuse Etsy margin estimates as Shopify profit.

The payload follows the official [productSet mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet), [ProductSetInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductSetInput), [OptionSetInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/OptionSetInput), [ProductVariantSetInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantSetInput), and [FileSetInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FileSetInput). It is a preview, not a server-validated response. A future live adapter must pin and revalidate a supported API version and handle `userErrors` and media processing.

**Destructive-update risk:** `productSet` synchronizes supplied list fields; existing variants omitted from an update can be deleted. This preview does not reconcile remote variant/media IDs. Do not execute it against an existing product without read-before-write reconciliation, ownership checks, and human approval. Repeated create previews are not remote idempotent upserts.

## Image and mockup reuse

Reuse owned, verified gallery previews/mockups by URL; retain the original artwork separately. The Shopify adapter accepts absolute HTTP(S) URLs without embedded credentials, rejects `data:`, `blob:`, and relative URLs, and never fetches or copies bytes. Resolve application-relative previews against an explicitly configured public origin before projection; do not invent an origin or fall back to the delivery file.

Future live media must use durable, publicly reachable HTTPS URLs and verified rights/quality. Avoid expiring worker URLs and credential-bearing query strings in persisted previews/logs. An Etsy preview URL may need public hosting for Shopify ingestion; availability is currently unverified. Digital delivery URLs must never become public product media. Shopify digital delivery and POD fulfillment require separate, reviewed integrations; `requiresShipping: false` does not deliver a download.

Future list queries must select explicit scalar fields and URL references; never include image blobs/base64, download bytes, or private delivery material in list payloads. This change adds no queries.

## Order sync (future design only)

- Poll official order APIs or consume verified webhooks only after each channel is explicitly enabled. Authenticate requests and verify webhook signatures before accepting events.
- Scope external IDs and cursors by shop and marketplace. Normalize order **line items**; preserve Etsy's receipt/transaction composite ID. Use marketplace + shop + external order/line-item ID as the deduplication key.
- Match lines through `marketplace_listings` to local listings. Unmatched IDs stay unmatched; never guess a listing or silently place a supplier order.
- Record actual currency, quantities, taxes, refunds, fulfillment state, and paid amounts. Advance durable cursors only after successful idempotent processing; allow an overlap window for retries and paginate.
- Keep demo events separate from live sales. Existing orders use Etsy-specific identifiers and CHF fields; cross-marketplace order storage needs a separate additive design/migration before real sync.
- No Shopify order sync, webhook registration, inventory reservation, or fulfillment writes are included here.

## Fees and channel economics

| Marketplace | Evaluation / required inputs |
| --- | --- |
| Etsy | Existing `src/lib/fees.ts` is a Swiss seller CHF model: USD 0.20 listing fee at its configured FX rate, 6.5% transaction, 4% + CHF 0.50 payment processing, 8.1% VAT on seller fees, and optional 15% Offsite Ads. POD base/shipping costs are separate. This change does not alter these estimates. Verify actual rates against [Etsy fees](https://www.etsy.com/legal/fees/) before decisions. |
| Shopify | Monthly plan allocation, country/plan-dependent payment processing, applicable third-party transaction fees, apps (digital delivery/POD), taxes, FX, refunds, and customer acquisition. No fee rate is fabricated or implemented. Obtain actual store terms from [Shopify pricing](https://www.shopify.com/pricing) and payment settings. No Etsy-like built-in demand is assumed. |
| Amazon Merch on Demand | Royalty = sale price less Amazon's applicable costs/taxes under its current royalty schedule; not Etsy fee math. Evaluate actual product/marketplace royalty tables, eligibility, advertising costs, and demand before comparing. See the [official Merch portal](https://merch.amazon.com/landing) and its current help/royalty resources. Unknown inputs remain unknown. |

## Amazon Merch on Demand: manual evaluation only

Amazon Merch on Demand has **no public listing API**. Amazon Selling Partner API is not a substitute for Merch. There is no Amazon integration code, console scraping, browser automation, private endpoint usage, or automated upload in this project.

After account approval, an operator uses the official Merch console: choose an eligible product/marketplace, upload owned artwork, enter reviewed copy and permitted options/pricing, inspect the preview, and submit manually. Check current console specifications, content/IP policies, account tier limits, royalty tables, and moderation requirements. Approval, revenue, and upload capacity are not assumed.

### Export helper specification (not implemented)

An explicit authenticated action could export an operator-selected **CSV + PNG bundle**, with:

- `listings.csv`: local listing/design IDs, title, plain description, tags (JSON in a properly quoted CSV cell), source price and currency (`CHF`), relative PNG filename, and only verified optional product/marketplace selections. Unknown values remain blank.
- Owned source PNG artwork per design, not gallery mockups; validate current Merch product-specific pixel/transparency/file-size requirements without silently resizing or claiming compliance.
- Relative sanitized filenames; no path traversal, credentials, personal/order data, delivery URLs, or remote identifiers invented by the helper. Neutralize spreadsheet formula prefixes in text cells.
- An explicit validation report for missing rights confirmation, artwork, metadata, or size compatibility. Invalid rows are flagged for review rather than filled with fictional details.

The CSV is an operator worksheet, **not** an Amazon bulk-import format or API payload. The operator still uploads each design and enters copy in the console. Any future export must comply with the current Merch terms and retain human control.

## Optional storage and deployment

`drizzle/0017_marketplace_listings.sql` is additive and journaled after `0016_sourcing.sql`. The app applies it automatically on database connection. Its `IF NOT EXISTS` statement safely supports databases where it was already applied manually. The dry-run adapters do not write to this table.

```sql
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id serial PRIMARY KEY,
  listing_id integer NOT NULL REFERENCES listings(id),
  marketplace text NOT NULL,
  external_id text,
  status text NOT NULL DEFAULT 'draft',
  payload_preview jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, marketplace)
);
```

Future persistence must verify availability, enforce listing/shop ownership, upsert by `(listing_id, marketplace)`, update `updated_at` explicitly, and distinguish a preview from confirmed remote state. Never mark the existing listing published on the strength of a Shopify preview. Preserve this table during future migration generation.

`SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ADMIN_ACCESS_TOKEN` are **documented future configuration only**. They are not required, read, validated, or displayed by this implementation. Do not set them to test dry-run. If enabled later, keep tokens server-side, use least-privilege official Admin API scopes, and validate the store domain before sending credentials.

Connections shows **Shopify — Planned / not connected** unconditionally, with no connect/test button. Supplying environment variables cannot enable it.

## Risks and release criteria

Etsy traction remains the release gate. Other risks include incorrect fees/currency, stale supplier availability, destructive product synchronization, duplicate creates, cross-shop ID leakage, public exposure of digital originals, invalid media/options, API version drift/rate limits, moderation/IP rules, and confusing simulation with sales. Draft status alone is not authorization to bypass existing gates.

Before live Shopify work: approve channel economics, select a supported API version, implement remote ID/idempotency and ownership reconciliation, authoritative status reads, protected digital delivery/POD mapping, explicit Shopify-specific permission/approval gates, rate-limit/retry handling, and signed order sync. None is enabled by this foundation.

Validation: fixture-based tests cover unchanged Etsy delegation, Shopify title/description/tags/price/options/URL media mapping, invalid inputs, missing remote facts, private-file exclusion, and fetch prohibition. The manual SQL is tested for opt-in behavior, idempotence, uniqueness, and foreign keys. Acceptance commands: `npm run lint`, `npx next typegen && npm run typecheck`, `npm test`, `npm run build`.
