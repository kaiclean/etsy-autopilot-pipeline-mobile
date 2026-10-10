import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertRail } from "@/components/alert-rail";
import { OpsCards } from "@/components/home/ops-cards";
import { ProductsList } from "@/components/products/products-list";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { jobRuns, listings, shops, type Listing } from "@/db/schema";
import { buildCockpitAlerts } from "@/lib/alerts";
import { withDisclosures } from "@/lib/disclosures";
import { draftListing } from "@/pipeline/listing";
import { PUBLISH_RETRY_MS, publishRetryBlocked } from "@/pipeline/publish";
import { runStage } from "@/pipeline/runner";
import { maskSecrets } from "@/pipeline/stage-log";
import { repairTrivialCopy, validateListing } from "@/lib/listing-validator";

const adapters = vi.hoisted(() => ({
  getEtsyAdapter: vi.fn(),
  getPrintifyAdapter: vi.fn(),
}));

vi.mock("@/adapters/etsy", () => ({ getEtsyAdapter: adapters.getEtsyAdapter }));
vi.mock("@/adapters/printify", () => ({ getPrintifyAdapter: adapters.getPrintifyAdapter }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));

const TAGS = [
  "swiss alps art", "mountain wall art", "alpine decor", "minimalist poster", "nature print",
  "scandi wall art", "switzerland gift", "hiking gift", "cabin decor", "matterhorn",
  "travel poster", "gallery wall", "neutral wall art",
];

async function memoryDb() {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db as unknown as DB;
}

describe("stage log masking", () => {
  it("redacts env secrets and bearer tokens", () => {
    const token = "unit-test-token-value";
    const line = maskSecrets(`Printify said ${token} and Bearer ${token} access_token=${token} at https://shop.example`, {
      PRINTIFY_API_TOKEN: token,
      APP_URL: "https://shop.example",
    } as unknown as NodeJS.ProcessEnv);
    expect(line).not.toContain(token);
    expect(line).toContain("[redacted]");
    expect(line).toContain("Bearer [redacted]");
    expect(line).toContain("access_token=[redacted]");
    expect(line).toContain("https://shop.example");
  });
});

describe("trivial listing repair", () => {
  it("fixes title length, tag length, and tag count before the gate", async () => {
    const longTag = "this tag is way too long";
    const repaired = repairTrivialCopy({
      title: `Alpine lake ${"decor ".repeat(40)}`,
      tags: [longTag, "alpine art"],
      description: "x",
      priceChf: 24.9,
      productType: "pod",
    });
    expect(repaired.fixes).toEqual([
      "shortened the title to 140 characters",
      "shortened tags to 20 characters",
      "set the tag list to 13",
    ]);
    expect(repaired.draft.title.length).toBeLessThanOrEqual(140);
    expect(repaired.draft.tags).toHaveLength(13);
    expect(repaired.draft.tags.every((tag) => tag.length <= 20)).toBe(true);
    expect(repaired.draft.tags.join(" ")).not.toMatch(/\bmugs?\b/i);

    const drafted = await draftListing({
      niche: "alpine",
      keyword: "alpine lake",
      product: { type: "pod", pod: "posterA3" },
      seed: 1,
      assumeOffsiteAds: false,
      llm: {
        name: "test",
        async writeListing() {
          return {
            title: "T".repeat(160),
            tags: ["only"],
            body: "A calm alpine print for the wall and a quiet room.",
            costChf: 0,
            provider: "test",
          };
        },
      },
    });
    expect(drafted.fixes.length).toBeGreaterThan(0);
    expect(drafted.draft.title.length).toBeLessThanOrEqual(140);
    expect(drafted.draft.tags).toHaveLength(13);
    const codes = drafted.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);
    expect(codes).not.toEqual(expect.arrayContaining(["title_too_long", "tags_too_few", "tags_too_many", "tag_too_long"]));
  });
});

describe("publish retry and dashboard", () => {
  const previousToken = process.env.PRINTIFY_API_TOKEN;

  afterEach(() => {
    if (previousToken === undefined) delete process.env.PRINTIFY_API_TOKEN;
    else process.env.PRINTIFY_API_TOKEN = previousToken;
  });

  it("skips an unchanged error for 24h and prints the masked reason", async () => {
    const token = "unit-test-token-value";
    process.env.PRINTIFY_API_TOKEN = token;
    const db = await memoryDb();
    const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
    const description = withDisclosures(
      "Bring the calm of the Swiss Alps into your home with this minimalist printable. One PNG for personal printing at home or at a local print shop.",
      "pod",
    );
    const draft = {
      title: "Swiss Alps Wall Art Printable, Minimalist Mountain Poster, Alpine Decor",
      tags: TAGS,
      description,
      priceChf: 24.9,
      productType: "pod" as const,
    };
    expect(validateListing(draft).valid).toBe(true);
    const [row] = await db
      .insert(listings)
      .values({
        shopId: shop.id,
        niche: "alpine",
        podProvider: "printify:posterA3",
        ...draft,
        imageUrl: "/api/mockup/posterA3?niche=alpine",
        priceChf: 24.9,
        podCostChf: 8,
        netChf: 5,
        marginPct: 20,
        validation: [],
        status: "approved",
        isDemo: false,
      })
      .returning();

    const createAndPublish = vi.fn(async () => {
      throw new Error(`Printify rejected ${token} Bearer ${token}`);
    });
    adapters.getEtsyAdapter.mockResolvedValue({ mode: "live" });
    adapters.getPrintifyAdapter.mockResolvedValue({ mode: "live", createAndPublish });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });

    const firstNow = new Date("2026-10-07T07:00:00.000Z");
    try {
      const first = await runStage("publish", "cron", { db, now: firstNow, random: () => 0 });
      expect(first.status).toBe("failed");
      expect(first.summary).toBe("Published 0, failed 1 (live)");
      expect(createAndPublish).toHaveBeenCalledTimes(1);
      expect(errors.some((line) => line.startsWith("[stage:publish] error #") && line.includes("publish failed"))).toBe(true);
      expect(errors.some((line) => line === "[stage:publish] error Published 0, failed 1 (live)")).toBe(true);
      expect(errors.join("\n")).not.toContain(token);
      expect(JSON.stringify(first.logs)).not.toContain(token);

      const [failed] = await db.select().from(listings).where(eq(listings.id, row.id));
      expect(failed.publishError).not.toContain(token);
      expect(failed.publishError).toContain("[redacted]");
      expect(failed.publishAttemptedAt).toEqual(firstNow);

      const second = await runStage("publish", "cron", { db, now: new Date(firstNow.getTime() + 60 * 60_000), random: () => 0 });
      expect(second.status).toBe("success");
      expect(second.summary).toMatch(/skipped 1 \(same error within 24h\)/);
      expect(createAndPublish).toHaveBeenCalledTimes(1);

      const third = await runStage("publish", "cron", { db, now: new Date(firstNow.getTime() + PUBLISH_RETRY_MS), random: () => 0 });
      expect(third.status).toBe("failed");
      expect(createAndPublish).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("blocks only a recent failed row whose error is still stored", () => {
    const now = new Date("2026-10-07T07:00:00.000Z");
    const recent = new Date(now.getTime() - PUBLISH_RETRY_MS + 1);
    const due = new Date(now.getTime() - PUBLISH_RETRY_MS);
    expect(publishRetryBlocked({ status: "failed", publishError: "same", publishAttemptedAt: recent }, now)).toBe(true);
    expect(publishRetryBlocked({ status: "failed", publishError: "same", publishAttemptedAt: due }, now)).toBe(false);
    expect(publishRetryBlocked({ status: "failed", publishError: null, publishAttemptedAt: recent }, now)).toBe(false);
    expect(publishRetryBlocked({ status: "approved", publishError: "same", publishAttemptedAt: recent }, now)).toBe(false);
  });

  it("does not retry an interrupted external publish without operator reconciliation", async () => {
    const db = await memoryDb();
    const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
    const attemptedAt = new Date("2026-10-07T06:00:00.000Z");
    const [row] = await db
      .insert(listings)
      .values({
        shopId: shop.id,
        niche: "alpine",
        productType: "pod",
        podProvider: "printify:posterA3",
        title: "Swiss Alps wall art poster",
        tags: TAGS,
        description: withDisclosures("Swiss alpine poster artwork for a calm home.", "pod"),
        imageUrl: "/api/mockup/posterA3?niche=alpine",
        priceChf: 24.9,
        podCostChf: 8,
        netChf: 5,
        marginPct: 20,
        validation: [],
        status: "publishing",
        publishAttemptedAt: attemptedAt,
        isDemo: true,
      })
      .returning();
    adapters.getEtsyAdapter.mockResolvedValue({ mode: "dry-run" });
    adapters.getPrintifyAdapter.mockResolvedValue({ mode: "dry-run", createAndPublish: vi.fn() });

    const result = await runStage("publish", "cron", {
      db,
      now: new Date(attemptedAt.getTime() + 16 * 60_000),
      random: () => 0,
    });
    const [recovered] = await db.select().from(listings).where(eq(listings.id, row.id));

    expect(recovered.status).toBe("failed");
    expect(recovered.publishError).toMatch(/check Etsy or Printify/i);
    expect(result.summary).toMatch(/skipped 1 \(same error within 24h\)/);
  });

  it("shows the publish error on the products page and the alert rail", () => {
    const alerts = buildCockpitAlerts({
      cronRuns: [],
      nullEtsyIdCount: 0,
      deploySha: null,
      tokens: { accessToken: "present", expiresAt: Date.parse("2026-10-20T00:00:00Z") },
      now: Date.parse("2026-10-07T12:00:00Z"),
      killSwitch: false,
      catalogDraftPending: false,
      publishFailures: [{ id: 9, title: "Alpine poster", publishError: "Printify rejected the shop" }],
    });
    expect(alerts.find((alert) => alert.id === "publish-error-9")?.evidence).toBe("Printify rejected the shop");
    const rail = renderToStaticMarkup(createElement(AlertRail, { alerts }));
    expect(rail).toContain("Printify rejected the shop");
    expect(rail).toContain("Alpine poster");

    const listing = {
      id: 9,
      title: "Alpine poster",
      tags: ["alpine art"],
      niche: "alpine",
      productType: "pod",
      podProvider: "printify:posterA3",
      description: "A poster",
      imageUrl: "/api/mockup/posterA3?niche=alpine",
      priceChf: 24.9,
      podCostChf: 8,
      netChf: 5,
      marginPct: 20,
      validation: [{ field: "title", severity: "error", code: "title_chars", message: "Title contains characters Etsy does not allow." }],
      status: "failed",
      publishError: "Printify rejected the shop",
      publishMode: "live",
      etsyListingId: null,
      isDemo: false,
      views: 0,
      favorites: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Listing;
    const products = renderToStaticMarkup(createElement(ProductsList, { listings: [listing] }));
    expect(products).toContain("Printify rejected the shop");
    expect(products).toContain("Title contains characters Etsy does not allow.");

    const home = renderToStaticMarkup(
      createElement(OpsCards, {
        failures: [],
        failureCount: 0,
        needsFixes: [
          {
            id: 4,
            title: "Holiday mug",
            imageUrl: "/api/mockup/mug",
            niche: "christmas",
            validation: [{ field: "tags", severity: "error", code: "trademark", message: "Contains trademarked term(s): disney." }],
          },
        ],
        report: null,
        stalled: [],
      }),
    );
    expect(home).toContain("Needs fixes");
    expect(home).toContain("Contains trademarked term(s): disney.");
  });
});

describe("daily chain force", () => {
  const trends = process.env.RESEARCH_GOOGLE_TRENDS;
  afterEach(() => {
    if (trends === undefined) delete process.env.RESEARCH_GOOGLE_TRENDS;
    else process.env.RESEARCH_GOOGLE_TRENDS = trends;
  });

  it("?force=1 bypasses a success already recorded today", async () => {
    process.env.RESEARCH_GOOGLE_TRENDS = "false";
    const db = await memoryDb();
    const [shop] = await db.select().from(shops).where(eq(shops.slug, "omnishop-ch"));
    const now = new Date();
    for (const stage of ["daily", "research", "design", "listing"] as const) {
      await db.insert(jobRuns).values({
        shopId: shop.id,
        stage,
        status: "success",
        trigger: "cron",
        summary: "already",
        startedAt: now,
        finishedAt: now,
      });
    }
    const skipped = await runStage("daily", "cron", { db, now, random: () => 0.2 });
    expect(skipped.summary).toMatch(/already completed/);
    const forced = await runStage("daily", "cron", { db, now, random: () => 0.2, force: true });
    expect(forced.status).toBe("success");
    expect(forced.summary).not.toMatch(/already completed/);
    expect(forced.summary).toMatch(/Nothing was activated/);
    const drafts = await db.select().from(listings);
    expect(drafts.length).toBeGreaterThan(0);
  }, 60_000);

  it("workflow_dispatch passes force=1 and keeps the secret out of the file", () => {
    const yaml = readFileSync(new URL("../.github/workflows/autopilot-cron.yml", import.meta.url), "utf8");
    expect(yaml).toContain("force:");
    expect(yaml).toContain("type: boolean");
    expect(yaml).toContain("?force=1");
    expect(yaml).toContain('"${url}/api/cron/daily${query}"');
    expect(yaml).toContain("FORCE: ${{ inputs.force }}");
    expect(yaml).not.toMatch(/Bearer [A-Za-z0-9+/=]{8,}/);
  });
});
