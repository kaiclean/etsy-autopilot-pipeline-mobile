import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), getDb: vi.fn(), resolveRequestShop: vi.fn(), importFinancialEvidence: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/shops", () => ({ resolveRequestShop: mocks.resolveRequestShop }));
vi.mock("@/lib/etsy-finance", async (original) => ({
  ...await original<typeof import("@/lib/etsy-finance")>(),
  importFinancialEvidence: mocks.importFinancialEvidence,
}));
import { POST } from "@/app/api/etsy/finance/import/route";
import { FinanceImportError } from "@/lib/etsy-finance";

describe("authorized read-only Etsy financial ingestion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(undefined);
    mocks.getDb.mockResolvedValue("database");
    mocks.resolveRequestShop.mockResolvedValue({ id: "selected-shop" });
    mocks.importFinancialEvidence.mockResolvedValue({ accepted: 1, profitStatus: "unavailable" });
  });

  it("requires authorization before reading headers, body, shop or database", async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Error("unauthorized"));
    const read = vi.fn(() => { throw new Error("Request read before auth"); });
    const request = { get headers() { return read(); }, get body() { return read(); } } as unknown as Request;
    expect((await POST(request)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.importFinancialEvidence).not.toHaveBeenCalled();
  });

  it("uses the selected server-side shop, never a request-supplied local shop id", async () => {
    const payload = { etsyShopId: "111", observations: [] };
    const response = await POST(new Request("http://localhost/api/etsy/finance/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(200);
    expect(mocks.importFinancialEvidence).toHaveBeenCalledWith("database", "selected-shop", payload);
    expect(await response.json()).toMatchObject({ profitStatus: "unavailable" });
  });

  it("rejects malformed or oversized data before database reads", async () => {
    for (const [body, status] of [["{bad", 400], [" ".repeat(256_001), 413]] as const) {
      const response = await POST(new Request("http://localhost/api/etsy/finance/import", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }));
      expect(response.status).toBe(status);
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects raw CSV and exposes only safe validation errors", async () => {
    expect((await POST(new Request("http://localhost/api/etsy/finance/import", {
      method: "POST", headers: { "content-type": "text/csv" }, body: "buyer,amount",
    }))).status).toBe(415);
    mocks.importFinancialEvidence.mockRejectedValueOnce(new FinanceImportError("Shop mismatch.", 403));
    const response = await POST(new Request("http://localhost/api/etsy/finance/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(403);
    mocks.importFinancialEvidence.mockRejectedValueOnce(new Error("private database detail"));
    const failed = await POST(new Request("http://localhost/api/etsy/finance/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("private database detail");
  });
});
