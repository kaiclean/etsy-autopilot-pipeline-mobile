import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { orders, shops } from "@/db/schema";
import { getOrders } from "@/lib/queries";

const state = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/db", () => ({ getDb: state.getDb }));

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  vi.stubEnv("DEMO_MODE", "false");
  client = new PGlite("memory://");
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  state.getDb.mockResolvedValue(db as unknown as DB);
  const [shop] = await db.insert(shops).values({ slug: "orders-summary-test", displayName: "Orders Summary" }).returning();
  await db.insert(orders).values((["paid", "canceled", "refund_pending", "unpaid"] as const).map((status, index) => ({
    shopId: shop.id,
    etsyReceiptId: `summary-${index + 1}`,
    etsyPaymentStatus: status,
    buyerCountry: "CH",
    totalChf: 100,
    feesChf: 10,
    profitChf: 70 + index,
    fulfillmentStatus: "delivered_digital" as const,
    isDemo: false,
  })));
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

it("keeps audit rows but summarizes only recent paid orders", async () => {
  const { rows, summary } = await getOrders();
  expect(rows).toHaveLength(4);
  expect(summary).toMatchObject({ count30d: 1, revenue30d: 100, profit30d: 70 });
});
