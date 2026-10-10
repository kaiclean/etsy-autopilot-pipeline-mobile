import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bulkSetListingStatus, savePodProducts, setListingStatus, updateListing } from "@/app/actions";
import { PodProductsForm } from "@/components/settings/settings-client";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { config, hasGelatoCredentials, integrationStatus } from "@/lib/config";
import { requiredDisclosures } from "@/lib/disclosures";
import { DEFAULT_POD_PRESETS, POD_PRESETS, podCostChf, type PodPreset } from "@/lib/fees";
import { connectionHealth } from "@/lib/health";
import { getSettingsData } from "@/lib/queries";
import { requireAuth } from "@/lib/session";
import { DEFAULT_AUTOMATION, DEFAULT_POD_PRODUCTS, getSetting, normalizePodProductSettings, setSetting } from "@/lib/settings";
import { revalidatePath } from "next/cache";

vi.mock("@/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireAuth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/pipeline/runner", () => ({ runFullPipeline: vi.fn(), runStage: vi.fn() }));

const drizzleDir = path.join(process.cwd(), "drizzle");
const supplierSql = readFileSync(path.join(drizzleDir, "0014_suppliers.sql"), "utf8");
const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string; when: number; breakpoints: boolean }[];
};
const presets = Object.keys(POD_PRESETS) as PodPreset[];
const originalGelatoKey = process.env.GELATO_API_KEY;

afterEach(() => {
  if (originalGelatoKey === undefined) delete process.env.GELATO_API_KEY;
  else process.env.GELATO_API_KEY = originalGelatoKey;
  vi.restoreAllMocks();
});

describe("POD settings normalization", () => {
  it("defaults to only the current four, with Printify implicitly selected", () => {
    expect(DEFAULT_POD_PRODUCTS).toEqual({ enabledPresets: [...DEFAULT_POD_PRESETS], suppliers: {} });
    for (const value of [undefined, null, false, 12, "bad", [], {}, { enabledPresets: "tote", suppliers: [] }]) {
      expect(normalizePodProductSettings(value)).toEqual(DEFAULT_POD_PRODUCTS);
    }
  });

  it("filters unknown presets, duplicates, invalid suppliers and prototype keys", () => {
    const value = JSON.parse('{"enabledPresets":["mug","tote","mug","unknown",null,3,"__proto__","constructor"],"suppliers":{"mug":"gelato","tote":"printify","canvas":"unknown","unknown":"gelato","__proto__":"gelato","constructor":"gelato"}}');
    expect(normalizePodProductSettings(value)).toEqual({
      enabledPresets: ["mug", "tote"],
      suppliers: { mug: "gelato", tote: "printify" },
    });
  });

  it("preserves disabling every product and accepts all eleven presets", () => {
    expect(normalizePodProductSettings({ enabledPresets: [], suppliers: {} }).enabledPresets).toEqual([]);
    expect(presets).toHaveLength(11);
    expect(normalizePodProductSettings({ enabledPresets: presets, suppliers: { hoodie: "gelato" } })).toEqual({
      enabledPresets: presets,
      suppliers: { hoodie: "gelato" },
    });
  });

  it("returns independent defaults so mutation cannot enable new products globally", () => {
    const first = normalizePodProductSettings(undefined);
    first.enabledPresets.push("tote");
    first.suppliers.mug = "gelato";
    expect(normalizePodProductSettings(undefined)).toEqual(DEFAULT_POD_PRODUCTS);
  });
});

describe("Gelato configuration and health", () => {
  it("skips absent or blank credentials without requesting a connection", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const key of [undefined, "", "   "]) {
      if (key === undefined) delete process.env.GELATO_API_KEY;
      else process.env.GELATO_API_KEY = key;
      expect(config.gelato.apiKey).toBeUndefined();
      expect(hasGelatoCredentials()).toBe(false);
      expect(integrationStatus(false).find((row) => row.id === "gelato")?.status).toBe("skipped");
      const check = connectionHealth({ etsyConnected: false }).find((row) => row.id === "gelato");
      expect(check).toMatchObject({ label: "Skipped", level: "yellow", envVars: ["GELATO_API_KEY"] });
      expect(check?.detail).toContain("dry-run only");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports configured credentials without leaking the secret or allowing writes", () => {
    process.env.GELATO_API_KEY = "  fixture-gelato-secret-do-not-display  ";
    expect(config.gelato.apiKey).toBe("fixture-gelato-secret-do-not-display");
    expect(hasGelatoCredentials()).toBe(true);
    const integrations = integrationStatus(false);
    const checks = connectionHealth({ etsyConnected: false, publishMode: "live" });
    expect(integrations.find((row) => row.id === "gelato")).toMatchObject({ status: "configured", envVars: ["GELATO_API_KEY"] });
    expect(checks.find((row) => row.id === "gelato")).toMatchObject({ label: "Configured", level: "green" });
    expect(checks.find((row) => row.id === "gelato")?.detail).toContain("dry-run only");
    expect(JSON.stringify({ integrations, checks })).not.toContain("fixture-gelato-secret-do-not-display");
  });
});

describe("POD product settings UI", () => {
  it("renders all presets with enabled defaults, disabled Gelato and only verified costs", () => {
    const html = renderToStaticMarkup(createElement(PodProductsForm, { podProducts: DEFAULT_POD_PRODUCTS, gelatoConfigured: false }));
    for (const preset of presets) {
      expect(html).toContain(POD_PRESETS[preset].label);
      expect(html).toContain(`id="pod-${preset}"`);
      const cost = podCostChf(preset);
      if (cost !== null) expect(html).toContain(`CHF ${cost.toFixed(2)}`);
    }
    expect(html.match(/role="switch"/g)).toHaveLength(11);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(4);
    expect(html.match(/<option value="gelato" disabled=""/g)).toHaveLength(11);
    expect(html.match(/class="tabular">—/g)).toHaveLength(7);
    expect(html).toContain("skipped when drafting listings");
    expect(html).toContain("legacy plan estimates, not verified live catalog quotes");
    expect(html.match(/Legacy plan estimate \(cost \+ shipping\)/g)).toHaveLength(4);
    expect(html).toContain("do not enable publishing");
    expect(html).toContain("draft previews held for review, not live fulfillment");
  });

  it("shows no Printify cost as a Gelato quote", () => {
    const html = renderToStaticMarkup(createElement(PodProductsForm, {
      podProducts: { enabledPresets: ["mug"], suppliers: { mug: "gelato" } },
      gelatoConfigured: true,
    }));
    expect(html).toContain('<option value="gelato" selected="">');
    expect(html).not.toContain('<option value="gelato" disabled=""');
    expect(html).not.toContain(`CHF ${podCostChf("mug").toFixed(2)}`);
    expect(html.match(/class="tabular">—/g)).toHaveLength(8);
  });
});

describe("POD settings persistence and action", () => {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: drizzleDir });
    vi.mocked(getDb).mockResolvedValue(db);
  });
  afterAll(async () => { await client.close(); });
  beforeEach(async () => {
    await db.delete(schema.settings);
    await db.delete(schema.listings);
    vi.mocked(requireAuth).mockReset().mockResolvedValue(undefined);
    vi.mocked(getDb).mockClear();
    vi.mocked(revalidatePath).mockClear();
    delete process.env.GELATO_API_KEY;
  });

  it("defaults old databases and normalizes invalid persisted JSON at read time", async () => {
    expect(await getSetting(db, "podProducts")).toEqual(DEFAULT_POD_PRODUCTS);
    await db.insert(schema.settings).values({
      key: "podProducts",
      value: { enabledPresets: ["tote", "mug", "tote", "constructor"], suppliers: { tote: "other", mug: "gelato" } },
    });
    expect(await getSetting(db, "podProducts")).toEqual({ enabledPresets: ["tote", "mug"], suppliers: { mug: "gelato" } });
  });

  it("returns podProducts from the existing settings query", async () => {
    await setSetting(db, "podProducts", { enabledPresets: ["tote"], suppliers: { tote: "printify" } });
    const data = await getSettingsData();
    expect(data.podProducts).toEqual({ enabledPresets: ["tote"], suppliers: { tote: "printify" } });
    expect(data.checks.find((check) => check.id === "gelato")?.label).toBe("Skipped");
  });

  it("authenticates before inspecting input or opening the database", async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
    const input = { get enabledPresets() { throw new Error("Input accessed before auth"); }, suppliers: {} };
    await expect(savePodProducts(input)).rejects.toThrow("Unauthorized");
    expect(getDb).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects invalid payloads and Gelato without credentials before writing", async () => {
    const invalid = [null, [], {}, { enabledPresets: "mug", suppliers: {} }, { enabledPresets: ["unknown"], suppliers: {} },
      { enabledPresets: ["mug"], suppliers: { mug: "other" } }, { enabledPresets: ["mug"], suppliers: { unknown: "printify" } }];
    for (const value of invalid) expect(await savePodProducts(value)).toMatchObject({ ok: false });
    expect(await savePodProducts({ enabledPresets: ["mug"], suppliers: { mug: "gelato" } })).toEqual({
      ok: false, error: "Set GELATO_API_KEY before selecting Gelato.",
    });
    expect(await db.select().from(schema.settings)).toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("saves normalized settings separately without changing automation or listings", async () => {
    process.env.GELATO_API_KEY = "fixture-gelato-save";
    await setSetting(db, "automation", DEFAULT_AUTOMATION);
    const input = { enabledPresets: ["mug", "mug", "tote"], suppliers: { mug: "gelato" as const } };
    expect(await savePodProducts(input)).toEqual({
      ok: true, podProducts: { enabledPresets: ["mug", "tote"], suppliers: { mug: "gelato" } },
    });
    expect(await getSetting(db, "podProducts")).toEqual({ enabledPresets: ["mug", "tote"], suppliers: { mug: "gelato" } });
    expect(await getSetting(db, "automation")).toEqual(DEFAULT_AUTOMATION);
    expect(await db.select().from(schema.listings)).toEqual([]);
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
    expect(await savePodProducts({ enabledPresets: [], suppliers: {} })).toMatchObject({ ok: true });
    expect((await getSetting(db, "podProducts")).enabledPresets).toEqual([]);
  });

  it("stores supplier product provenance, null costs and the unique supplier/preset/uid key", async () => {
    const fetchedAt = new Date("2026-10-10T22:00:00Z");
    const row = { supplier: "gelato", preset: "tote", externalProductUid: "fixture-product", title: "Catalog tote",
      baseCostUsd: null, currency: "USD", sourceUrl: "https://order.gelatoapis.com", fetchedAt };
    await db.insert(schema.supplierProducts).values(row);
    const [stored] = await db.select().from(schema.supplierProducts);
    expect(stored).toMatchObject(row);
    expect(stored.fetchedAt).toEqual(fetchedAt);
    await expect(db.insert(schema.supplierProducts).values(row)).rejects.toThrow();
    await db.insert(schema.supplierProducts).values({ ...row, supplier: "printify" });
    await db.insert(schema.supplierProducts).values({ ...row, preset: "canvas" });
    await db.insert(schema.supplierProducts).values({ ...row, externalProductUid: "fixture-other" });
    expect(await db.select().from(schema.supplierProducts)).toHaveLength(4);
  });

  async function approvalListing(supplier: string | null, podProvider: string | null) {
    const [listing] = await db.insert(schema.listings).values({
      niche: "alpine",
      productType: "pod",
      supplier,
      podProvider,
      title: "Alpine landscape art",
      tags: ["alpine art", "mountain scene", "swiss landscape", "nature print", "wall decor", "forest art", "lake scenery",
        "cabin decor", "cozy room", "rustic style", "blue sky", "green valley", "snowy peak"],
      description: `An alpine landscape artwork for a calm room. ${requiredDisclosures("pod").join("\n")}`,
      imageUrl: "/art/fixture.png",
      priceChf: 25,
      podCostChf: 10,
      netChf: 8,
      marginPct: 32,
      status: "quality_failed",
    }).returning();
    return listing;
  }

  it("refuses approval via editing and status actions for Gelato, new types and unknown presets", async () => {
    const held = [
      { supplier: "gelato", podProvider: "printify:mug" },
      { supplier: null, podProvider: "gelato:mug" },
      ...presets.filter((preset) => !DEFAULT_POD_PRESETS.includes(preset)).map((preset) => ({ supplier: "printify", podProvider: `printify:${preset}` })),
      { supplier: "printify", podProvider: "printify:unknown" },
    ];
    for (const input of held) {
      const listing = await approvalListing(input.supplier, input.podProvider);
      const error = { ok: false, error: "This supplier/product type is dry-run only; live fulfillment is not enabled." };
      expect(await updateListing(listing.id, { title: "Edited preview", tags: listing.tags, priceChf: 30 }, true)).toEqual(error);
      expect(await setListingStatus(listing.id, "approved")).toEqual(error);
      const [stored] = await db.select().from(schema.listings).where(eq(schema.listings.id, listing.id));
      expect(stored).toEqual(listing);
    }
  });

  it("keeps editing held previews available without approving them", async () => {
    const listing = await approvalListing("gelato", "gelato:mug");
    expect(await updateListing(listing.id, { title: "Edited preview", tags: listing.tags, priceChf: 30 })).toMatchObject({ ok: true });
    const [stored] = await db.select().from(schema.listings).where(eq(schema.listings.id, listing.id));
    expect(stored).toMatchObject({ title: "Edited preview", status: "quality_failed", approvedAt: null });
    expect(await setListingStatus(listing.id, "pending_approval")).toMatchObject({ ok: true });
    expect(await setListingStatus(listing.id, "approved")).toMatchObject({ ok: false });
  });

  it("still allows the existing four Printify presets through both approval actions", async () => {
    for (const preset of DEFAULT_POD_PRESETS) {
      const listing = await approvalListing("printify", `printify:${preset}`);
      expect(await setListingStatus(listing.id, "approved")).toMatchObject({ ok: true });
      const edited = await approvalListing(null, `printify:${preset}`);
      expect(await updateListing(edited.id, { title: edited.title, tags: edited.tags, priceChf: edited.priceChf }, true)).toMatchObject({ ok: true });
    }
  });

  it("cannot bypass the preview hold by bulk approving a mixed selection", async () => {
    const legacy = await approvalListing("printify", "printify:mug");
    const gelato = await approvalListing("gelato", "gelato:mug");
    const newType = await approvalListing("printify", "printify:tote");
    const result = await bulkSetListingStatus([legacy.id, gelato.id, newType.id], "approved");
    expect(result).toMatchObject({
      ok: true,
      changed: [legacy.id],
      skipped: [
        { id: gelato.id, error: "This supplier/product type is dry-run only; live fulfillment is not enabled." },
        { id: newType.id, error: "This supplier/product type is dry-run only; live fulfillment is not enabled." },
      ],
    });
    const rows = await db.select().from(schema.listings);
    expect(rows.find((row) => row.id === legacy.id)?.status).toBe("approved");
    expect(rows.find((row) => row.id === gelato.id)?.status).toBe("quality_failed");
    expect(rows.find((row) => row.id === newType.id)?.status).toBe("quality_failed");
  });

  it("authenticates before any approval lookup", async () => {
    vi.mocked(requireAuth).mockRejectedValue(new Error("Unauthorized"));
    await expect(updateListing(1, { title: "Preview", tags: [], priceChf: 20 }, true)).rejects.toThrow("Unauthorized");
    await expect(setListingStatus(1, "approved")).rejects.toThrow("Unauthorized");
    await expect(bulkSetListingStatus([1], "approved")).rejects.toThrow("Unauthorized");
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("0014 additive supplier migration", () => {
  it("registers next journal entry and includes the requested SQL with statement breakpoints", () => {
    expect(journal.entries.at(-1)).toMatchObject({ idx: 12, tag: "0014_suppliers", breakpoints: true });
    expect(journal.entries.at(-1)!.when).toBeGreaterThan(journal.entries.at(-2)!.when);
    expect(journal.entries.at(-1)!.when).toBeLessThanOrEqual(Date.now());
    expect(supplierSql.split("--> statement-breakpoint")).toHaveLength(3);
    expect(supplierSql).toContain("ALTER TABLE listings ADD COLUMN IF NOT EXISTS supplier text;");
    expect(supplierSql).toContain("ALTER TABLE listings ADD COLUMN IF NOT EXISTS supplier_product_id text;");
    expect(supplierSql).toContain("UNIQUE (supplier, preset, external_product_uid)");
    expect(supplierSql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);
  });

  it("retries a partial migration twice and leaves existing listing publish data unchanged", async () => {
    const client = new PGlite("memory://");
    try {
      for (const entry of journal.entries.slice(0, -1)) {
        for (const statement of readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) {
          if (statement.trim()) await client.exec(statement);
        }
      }
      await client.exec("INSERT INTO listings (niche, product_type, pod_provider, title, tags, description, image_url, price_chf, net_chf, margin_pct, status, printify_product_id, publish_mode) VALUES ('alpine', 'pod', 'printify:mug', 'Existing mug', '[]', 'Description', '/art', 20, 5, 25, 'pod_created', 'existing-printify-id', 'dry-run')");
      const before = (await client.query<Record<string, unknown>>("SELECT * FROM listings")).rows[0];
      const parts = supplierSql.split("--> statement-breakpoint");
      await client.exec(parts[0]);
      for (let run = 0; run < 2; run++) for (const statement of parts) await client.exec(statement);
      const after = (await client.query<Record<string, unknown>>("SELECT * FROM listings")).rows[0];
      expect(after).toEqual({ ...before, supplier: null, supplier_product_id: null });
      const columns = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
        "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'listings' AND column_name IN ('supplier', 'supplier_product_id') ORDER BY column_name",
      );
      expect(columns.rows).toEqual([
        { column_name: "supplier", is_nullable: "YES", data_type: "text" },
        { column_name: "supplier_product_id", is_nullable: "YES", data_type: "text" },
      ]);
      const productColumns = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'supplier_products' ORDER BY ordinal_position",
      );
      expect(productColumns.rows.map((row) => row.column_name)).toEqual([
        "id", "supplier", "preset", "external_product_uid", "title", "base_cost_usd", "currency", "source_url", "fetched_at",
      ]);
      const db = drizzle(client, { schema });
      await db.update(schema.listings).set({ supplier: "gelato", supplierProductId: "fixture-created-id" }).where(eq(schema.listings.id, Number(after.id)));
      const [stored] = await db.select().from(schema.listings);
      expect(stored).toMatchObject({ supplier: "gelato", supplierProductId: "fixture-created-id", printifyProductId: "existing-printify-id", status: "pod_created", publishMode: "dry-run" });
    } finally {
      await client.close();
    }
  });
});
