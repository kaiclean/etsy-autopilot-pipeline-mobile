import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/upscale-jobs", () => ({ authorizedUpscaleJob: () => false }));
describe("live-audit route", () => {
  it("rejects unauthorized callers", async () => {
    const { GET } = await import("@/app/api/cron/live-audit/route");
    expect((await GET(new Request("http://x/api/cron/live-audit"))).status).toBe(401);
  });
});
