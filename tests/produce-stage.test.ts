import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, type DB } from "@/db";
import { designs, listings, type Deliverable } from "@/db/schema";
import { PRINT_SPECS, printPackBlurb } from "@/lib/deliverables";
import { DIGITAL_FILE_BLURB } from "@/lib/delivery";
import { AI_DISCLOSURE, DIGITAL_DELIVERY_NOTE } from "@/lib/disclosures";
import { runStage } from "@/pipeline/runner";

const puts: string[] = [];
vi.mock("@/lib/deliverable-store", () => ({
  getDeliverableStore: () => ({
    kind: "object-storage",
    put: async (name: string) => {
      puts.push(name);
      return { url: `https://cdn.test/${name}`, stored: true };
    },
  }),
}));

const unstored: Deliverable[] = PRINT_SPECS.map((s) => ({
  name: `print-${s.ratio}.jpg`,
  ratio: s.ratio,
  width: s.width,
  height: s.height,
  bytes: 1000,
  url: `dry-run://print-files/print-${s.ratio}.jpg`,
  stored: false,
  method: "resample" as const,
  upscale: 3.9,
}));

describe("produce stage with object storage", () => {
  let db: DB;
  beforeAll(async () => {
    process.env.PRODUCE_SCALE = "0.05";
    db = await getDb();
  });

  async function insert(values: Partial<typeof listings.$inferInsert>) {
    const [design] = await db.select().from(designs).limit(1);
    const [row] = await db
      .insert(listings)
      .values({
        designId: design.id,
        niche: "alpine",
        productType: "digital",
        title: "Minimal Swiss Alps Wall Art Printable",
        tags: Array.from({ length: 13 }, (_, i) => `alpine tag ${i}`),
        description: ["Calm alpine print.", DIGITAL_FILE_BLURB, DIGITAL_DELIVERY_NOTE, AI_DISCLOSURE].join("\n\n"),
        imageUrl: design.imageUrl,
        priceChf: 8,
        podCostChf: 0,
        netChf: 6.37,
        marginPct: 79.7,
        validation: [],
        status: "pending_approval",
        isDemo: true,
        ...values,
      })
      .returning();
    return row;
  }

  it("stores files that an earlier run could only measure, without touching the approval", async () => {
    const approved = await insert({
      status: "approved",
      deliverables: unstored,
      description: ["Calm alpine print.", printPackBlurb(unstored), DIGITAL_DELIVERY_NOTE, AI_DISCLOSURE].join("\n\n"),
    });
    const pod = await insert({ productType: "pod", podProvider: "printify:posterA3" });
    const invite = await insert({ niche: "birthday" });

    const r = await runStage("produce", "manual", { db });
    expect(r.status).toBe("success");

    const [after] = await db.select().from(listings).where(eq(listings.id, approved.id));
    expect(after.status).toBe("approved");
    expect(after.deliverables).toHaveLength(5);
    expect(after.deliverables.every((d) => d.stored && d.url.startsWith("https://cdn.test/"))).toBe(true);
    expect(puts.length).toBeGreaterThanOrEqual(5);

    for (const id of [pod.id, invite.id]) {
      const [skipped] = await db.select().from(listings).where(eq(listings.id, id));
      expect(skipped.deliverables).toEqual([]);
    }
  });
});
