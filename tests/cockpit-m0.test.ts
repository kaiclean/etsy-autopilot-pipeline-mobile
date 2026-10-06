import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ShopIdentityStrip } from "@/components/shop-identity-strip";
import { CatalogDraftPanel } from "@/components/catalog-draft-panel";
import { DeployPinBadge } from "@/components/deploy-pin";
import { AlertRail } from "@/components/alert-rail";
import { buildCockpitAlerts, countListingsMissingEtsyId, countMissingEtsyIds, cronRunIsUnauthorized, railwayDeploySha } from "@/lib/alerts";
import { filterProducts, filterQueue, titleImageMismatch } from "@/lib/catalog-filters";
import { CATALOG_DRAFT_SUMMARY } from "@/lib/catalog-draft";
import { readCatalogDraftMarkdown } from "@/lib/catalog-draft-document";
import { buildShopIdentity } from "@/lib/shop-identity";
import { getDb } from "@/db";
import { costs, listings, settings } from "@/db/schema";
import { isDemoMode } from "@/lib/config";
import { DEFAULT_AUTOMATION, getSetting } from "@/lib/settings";
import { setCatalogDraftReviewed } from "@/app/actions";
import { requireAuth } from "@/lib/session";
import { getCockpitAlerts, getShellData } from "@/lib/queries";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireAuth: vi.fn() }));

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
  it("reports only commit SHAs, without inferring deployment pinning", () => {
    expect(railwayDeploySha({ RAILWAY_DEPLOYMENT_ID: "deployment-uuid" })).toBeNull();
    expect(railwayDeploySha({ RAILWAY_GIT_COMMIT_SHA: "  ", RAILWAY_DEPLOYMENT_ID: "deployment-uuid" })).toBeNull();
    expect(railwayDeploySha({ RAILWAY_GIT_COMMIT_SHA: " abc1234567890 " })).toBe("abc1234567890");
    const html = renderToStaticMarkup(createElement(DeployPinBadge, { sha: "abc1234567890" }));
    expect(html).toContain("abc123456789");
    expect(html).not.toContain("Pinned");
  });

  it("does not claim cron authentication is healthy without endpoint telemetry", () => {
    const html = renderToStaticMarkup(createElement(AlertRail, { alerts: [] }));
    expect(html).toContain("CRON_SECRET");
    expect(html).toContain("401 responses are not stored");
    expect(html).not.toContain("Cron auth,");
  });

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
    expect(alerts.find((alert) => alert.id === "cron-401")?.evidence).toContain("not at the cron endpoint");
    expect(alerts.find((alert) => alert.id === "deploy-pin")?.title).toBe("Railway deployed commit");
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
  it("uses real poster mockup evidence, not unrelated description prose", () => {
    const row = {
      title: "Cozy Christmas Mug",
      tags: ["mug"],
      niche: "christmas",
      status: "draft",
      validation: [],
      imageUrl: "/api/mockup/posterA3?design=42",
    };
    expect(titleImageMismatch(row)).toBe(true);
    expect(titleImageMismatch({ ...row, imageUrl: null, mockupMeta: "posterA3" })).toBe(true);
    expect(titleImageMismatch({ ...row, imageUrl: "/api/mockup/mug", description: "Pair with a poster from our shop." })).toBe(false);
    const filter = { query: "", niche: "all", status: "all", triage: "title_image_mismatch" } as const;
    expect(filterProducts([row], filter)).toEqual([row]);
    expect(filterQueue([row], filter)).toEqual([row]);
  });

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
  it.each([false, true])("renders consistent review status (%s) and a single diff link", (reviewed) => {
    const html = renderToStaticMarkup(createElement(CatalogDraftPanel, { reviewed }));
    expect(html).toContain(reviewed ? "Reviewed by Kai" : "Pending Kai");
    if (reviewed) expect(html).not.toContain("Pending Kai");
    expect(html).toContain(`aria-pressed="${reviewed}"`);
    expect(html).toMatch(/<a\b[^>]*href="\/catalog-draft"[^>]*>Open diff<\/a>/);
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });

  it("loads the committed document with a browser-safe summary module", async () => {
    const doc = await readCatalogDraftMarkdown();
    expect(doc.available).toBe(true);
    expect(doc.markdown).toContain("Nothing live changes until Kai OKs");
    const summary = readFileSync(new URL("../src/lib/catalog-draft.ts", import.meta.url), "utf8");
    expect(summary).not.toMatch(/node:|readFile/);
  });

  it("requires authentication before recording a review", async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
    const db = await getDb();
    const before = await db.select().from(settings);
    await expect(setCatalogDraftReviewed(true)).rejects.toThrow("Unauthorized");
    expect(await db.select().from(settings)).toEqual(before);
  });

  it("only changes catalog review settings, never listings, spend, publish mode, or remote APIs", async () => {
    const db = await getDb();
    const beforeSettings = (await db.select().from(settings)).filter((row) => row.key !== "catalogDraft");
    const beforeListings = await db.select().from(listings);
    const beforeCosts = await db.select().from(costs);
    const beforeAutomation = await getSetting(db, "automation");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    try {
      expect(DEFAULT_AUTOMATION.publishMode).toBe("dry-run");
      for (const reviewed of [true, false]) {
        expect(await setCatalogDraftReviewed(reviewed)).toEqual({ ok: true, reviewed });
        expect(await getSetting(db, "catalogDraft")).toMatchObject({ reviewedByKai: reviewed, pending: !reviewed });
        expect((await getCockpitAlerts()).some((alert) => alert.id === "catalog-draft")).toBe(!reviewed);
        expect((await getShellData()).publishMode).toBe(beforeAutomation.publishMode);
      }
      expect(await getSetting(db, "automation")).toEqual(beforeAutomation);
      expect((await db.select().from(settings)).filter((row) => row.key !== "catalogDraft")).toEqual(beforeSettings);
      expect(await db.select().from(listings)).toEqual(beforeListings);
      expect(await db.select().from(costs)).toEqual(beforeCosts);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

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
