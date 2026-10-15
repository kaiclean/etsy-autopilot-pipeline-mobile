import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import OrdersPage from "@/app/(app)/orders/page";
import { chf } from "@/lib/format";

const mocks = vi.hoisted(() => ({ getOrders: vi.fn() }));
vi.mock("@/lib/queries", () => ({ getOrders: mocks.getOrders }));
vi.mock("@/components/run-button", () => ({ RunStageButton: () => null }));

describe("estimated financial order audit display", () => {
  it("retains canceled and refund-pending receipt amounts without presenting their profit as eligible", async () => {
    const base = {
      isDemo: false, buyerCountry: "CH", quantity: 1, createdAt: new Date("2026-10-15T12:00:00Z"),
      fulfillmentStatus: "delivered_digital", matchStatus: "matched", totalChf: 100,
    };
    const rows = [
      { id: 1, etsyReceiptId: "10001", etsyPaymentStatus: "paid", profitChf: 10, title: "Paid receipt" },
      { id: 2, etsyReceiptId: "10002", etsyPaymentStatus: "canceled", profitChf: 777, title: "Canceled receipt" },
      { id: 3, etsyReceiptId: "10003", etsyPaymentStatus: "refund_pending", profitChf: 888, title: "Refund receipt" },
      { id: 4, etsyReceiptId: "10004", etsyPaymentStatus: "unpaid", profitChf: 999, title: "Unpaid receipt" },
    ].map(({ title, ...order }) => ({ order: { ...base, ...order }, title, imageUrl: null, productType: "digital" }));
    mocks.getOrders.mockResolvedValue({
      rows, summary: { unmatched: 0, count30d: 1, revenue30d: 100, profit30d: 10, openPod: 0 },
    });
    const html = renderToStaticMarkup(await OrdersPage());
    expect(html).toContain("Paid receipt");
    expect(html).toContain("Canceled receipt");
    expect(html).toContain("Refund receipt");
    expect(html).toContain("Unpaid receipt");
    expect(html).toContain("Canceled · excluded");
    expect(html).toContain("Refund pending · excluded");
    expect(html).toContain("Unpaid · excluded");
    expect(html).toContain("Audit only · profit unavailable");
    expect(html).not.toContain(chf(777).replace("CHF ", ""));
    expect(html).not.toContain(chf(888).replace("CHF ", ""));
    expect(html).not.toContain(chf(999).replace("CHF ", ""));
    expect(html).toContain("Eligible paid orders");
    expect(html).toContain("reporting estimates");
    expect(html).toContain("partial refund amounts remain unknown");
  });
});
