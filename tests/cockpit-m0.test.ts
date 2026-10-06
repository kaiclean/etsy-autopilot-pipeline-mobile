import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShopIdentityStrip } from "@/components/shop-identity-strip";
import { buildCockpitAlerts, countListingsMissingEtsyId, countMissingEtsyIds, cronRunIsUnauthorized } from "@/lib/alerts";
import { filterQueue, titleImageMismatch } from "@/lib/catalog-filters";
import { CATALOG_DRAFT_SUMMARY } from "@/lib/catalog-draft";
import { buildShopIdentity } from "@/lib/shop-identity";
import { getDb } from "@/db";
import { listings } from "@/db/schema";
import { isDemoMode } from "@/lib/config";

describe("shop identity strip", () => {
  it("renders OmniShop CH, the handle, publish and kill pips, and never invents a shop id", () => {
    const identity = buildShopIdentity({
      publishMode: "dry-run",
      killSwitch: true,
      env: { ETSY_SHOP_ID: "", APP_URL: "https://etsy-autopilot-production-8b9f.up.railway.app" },
    });
    expect(identity.displayName).toBe("OmniShop CH");
    expect(identity.handle).toBe("OmniShopByKaiArt");
    expect(identity.shopIdLabel).toBe("—");
    expect(identity.shopIdLabel).not.toContain("68255203");
    expect(identity.host).toBe("etsy-autopilot-production-8b9f");

    const html = renderToStaticMarkup(createElement(ShopIdentityStrip, { identity }));
    expect(html).toContain("OmniShop CH");
    expect(html).toContain("OmniShopByKaiArt");
    expect(html).toContain("—");
    expect(html).toContain("dry-run");
    expect(html).toContain("Kill on");
    expect(html).toContain("etsy-autopilot-production-8b9f");
    expect(html).not.toContain("Designed by Kai");
    expect(html).not.toContain("68255203");
  });

  it("shows ETSY_SHOP_ID when the env value is present and a live warning pip", () => {
    const identity = buildShopIdentity({
      publishMode: "live",
      killSwitch: false,
      env: { ETSY_SHOP_ID: "12345", RAILWAY_PUBLIC_DOMAIN: "shop.up.railway.app" },
    });
    const html = renderToStaticMarkup(createElement(ShopIdentityStrip, { identity }));
    expect(html).toContain("12345");
    expect(html).toContain('data-mode="live"');
    expect(html).toContain("Kill off");
    expect(html).toContain("shop");
  });
});

describe("alert count query", () => {
  it("counts only rows that have media and a null etsy id", () => {
    const count = countMissingEtsyIds([
      { etsyListingId: null, imageUrl: "/art/1.png" },
      { etsyListingId: null, imageUrl: "  " },
      { etsyListingId: "4584533845", imageUrl: "/art/2.png" },
      { etsyListingId: null, imageUrl: null },
    ]);
    expect(count).toBe(1);
  });

  it("puts that count in the alert evidence", () => {
    const alerts = buildCockpitAlerts({
      cronRuns: [
        { stage: "publish", status: "failed", summary: "Etsy cron 401 unauthorized", logs: [{ msg: "401" }] },
      ],
      nullEtsyIdCount: 8,
      deploySha: "abc1234def",
      tokens: null,
      killSwitch: true,
      catalogDraftPending: true,
      now: Date.parse("2026-10-05T12:00:00Z"),
    });
    expect(alerts.find((alert) => alert.id === "null-etsy-id")?.evidence).toContain("8 listings");
    expect(alerts.map((alert) => alert.id)).toEqual(
      expect.arrayContaining(["cron-401", "null-etsy-id", "deploy-pin", "oauth-missing", "kill-switch", "catalog-draft"]),
    );
    expect(alerts.find((alert) => alert.id === "cron-secret")).toBeUndefined();
    expect(cronRunIsUnauthorized({ summary: "ok", logs: [] })).toBe(false);
  });

  it("uses the static cron note when a cron run failed without a 401", () => {
    const alerts = buildCockpitAlerts({
      cronRuns: [{ stage: "orders", status: "failed", summary: "timeout", logs: [{ msg: "network" }] }],
      nullEtsyIdCount: 0,
      deploySha: null,
      tokens: { accessToken: "token", expiresAt: Date.parse("2026-10-08T12:00:00Z") },
      now: Date.parse("2026-10-05T12:00:00Z"),
      killSwitch: false,
      catalogDraftPending: false,
    });
    expect(alerts.map((alert) => alert.id)).toEqual(["cron-secret"]);
    expect(alerts[0].evidence).toContain("CRON_SECRET");
  });

  it("queries the database count of media rows with a null etsy id", async () => {
    const db = await getDb();
    const rows = await db.select({ etsyListingId: listings.etsyListingId, imageUrl: listings.imageUrl, isDemo: listings.isDemo }).from(listings);
    const visibleRows = isDemoMode() ? rows : rows.filter((row) => !row.isDemo);
    const counted = await countListingsMissingEtsyId(db);
    expect(counted).toBe(countMissingEtsyIds(visibleRows));
  });
});

describe("title image mismatch heuristic", () => {
  it("flags a mug or sweatshirt title when tags or mockup meta say poster", () => {
    expect(titleImageMismatch({ title: "Cozy Christmas Mug", tags: ["a3 poster"], productType: "pod" })).toBe(true);
    expect(
      titleImageMismatch({
        title: "Personalized Gift for Her for Grandma - Cozy Christmas Sweatshirt",
        tags: ["gift"],
        mockupMeta: "poster mockup",
      }),
    ).toBe(true);
    expect(titleImageMismatch({ title: "Alpine Christmas Print Vintage Mug", tags: ["mug"], productType: "pod", imageUrl: "/mugs/1.png" })).toBe(false);
    expect(titleImageMismatch({ title: "Moody Botanical Art Printable", tags: ["poster"], productType: "digital" })).toBe(false);
  });

  it("filters the queue without editing the row", () => {
    const rows = [
      {
        id: 1,
        title: "Cozy Christmas Mug",
        tags: ["christmas poster"],
        niche: "christmas",
        validation: [],
        productType: "pod",
        etsyListingId: null,
        imageUrl: "/poster.png",
      },
      {
        id: 2,
        title: "Matterhorn Print",
        tags: ["alps"],
        niche: "alpine",
        validation: [],
        productType: "digital",
        etsyListingId: "1",
        imageUrl: "/alps.png",
      },
    ];
    expect(filterQueue(rows, { query: "", niche: "all", status: "all", triage: "title_image_mismatch" }).map((row) => row.id)).toEqual([1]);
    expect(filterQueue(rows, { query: "", niche: "all", status: "all", triage: "needs_etsy_id" }).map((row) => row.id)).toEqual([1]);
    expect(filterQueue(rows, { query: "", niche: "all", status: "all", triage: "digital" }).map((row) => row.id)).toEqual([2]);
    expect(rows[0].title).toBe("Cozy Christmas Mug");
  });
});

describe("catalog draft", () => {
  it("keeps the summary counts and the committed diff, with no apply action", () => {
    expect(CATALOG_DRAFT_SUMMARY).toMatchObject({
      retitles: 7,
      imageGaps: 2,
      setCoverGaps: 3,
      exitCandidates: 1,
      sections: 5,
    });
    const doc = readFileSync(new URL("../docs/omnishop-catalog-diff-2026-10-05.md", import.meta.url), "utf8");
    expect(doc).toContain("VTuber");
    expect(doc).toContain("Nothing live changes until Kai OKs");
    const panel = readFileSync(new URL("../src/components/catalog-draft-panel.tsx", import.meta.url), "utf8");
    expect(panel).toContain("Mark reviewed by Kai");
    expect(panel).toContain("Open diff");
    expect(panel).not.toMatch(/Apply/);
  });
});
