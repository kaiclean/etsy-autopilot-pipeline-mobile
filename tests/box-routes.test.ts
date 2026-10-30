import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), runStage: vi.fn(), runFullPipeline: vi.fn(), auth: vi.fn(), after: vi.fn() }));
vi.mock("@/pipeline/runner", () => ({ runStage: mocks.runStage, runFullPipeline: mocks.runFullPipeline }));
vi.mock("@/lib/session", () => ({ requireAuth: mocks.auth }));
vi.mock("@/db", () => ({ getDb: async () => "db" }));
vi.mock("@/lib/shops", () => ({ resolveActiveShop: async () => ({ id: "shop" }) }));
vi.mock("@/lib/settings", () => ({ getSetting: async () => ({ daily: { cron: "0 5 * * *" } }) }));
vi.mock("@/lib/box-jobs", () => ({ boxExecutionEnabled: () => true, enqueueBoxJob: mocks.enqueue, dueBoxScheduleSlot: () => new Date("2026-10-30T05:00:00Z") }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
import { POST } from "@/app/api/pipeline/[stage]/run/route";
import { GET } from "@/app/api/cron/[stage]/route";
const ctx = (stage: string) => ({ params: Promise.resolve({ stage }) });
beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "test-cron");
  mocks.enqueue.mockResolvedValue({ id: "queued-id", stage: "daily", status: "queued" });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe("hosted box submission boundaries", () => {
  it.each(["daily", "all"])("queues authenticated %s without inline execution", async stage => {
    const res = await POST(new Request(`http://localhost/api/pipeline/${stage}/run?force=1`, { method: "POST" }), ctx(stage));
    expect(res.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith("db", expect.objectContaining({ shopId: "shop", stage, trigger: "manual", force: stage === "daily" }));
    expect(mocks.runStage).not.toHaveBeenCalled(); expect(mocks.runFullPipeline).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
  it("refuses unauthenticated manual work", async () => {
    mocks.auth.mockRejectedValueOnce(new Error("unauthorized"));
    expect((await POST(new Request("http://localhost", { method: "POST" }), ctx("daily"))).status).toBe(401);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("refuses invalid stages", async () => {
    expect((await POST(new Request("http://localhost", { method: "POST" }), ctx("nope"))).status).toBe(404);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("requires cron authorization before enqueuing", async () => {
    expect((await GET(new Request("http://localhost"), ctx("daily"))).status).toBe(401);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("durably queues cron with the scheduler's slot key and no after callback", async () => {
    const res = await GET(new Request("http://localhost", { headers: { authorization: "Bearer test-cron" } }), ctx("daily"));
    expect(res.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith("db", expect.objectContaining({ idempotencyKey: "schedule:daily:2026-10-30T05:00:00.000Z", trigger: "cron" }));
    expect(mocks.runStage).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled();
  });
});
