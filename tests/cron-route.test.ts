import { afterEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ runCronStage: vi.fn() }));

vi.mock("@/pipeline/runner", () => ({ runCronStage: runner.runCronStage }));

import { GET } from "@/app/api/cron/[stage]/route";

const savedSecret = process.env.CRON_SECRET;

function call(stage: string, search = "") {
  return GET(new Request(`http://localhost/api/cron/${stage}${search}`), {
    params: Promise.resolve({ stage }),
  });
}

describe("cron stage route", () => {
  afterEach(() => {
    runner.runCronStage.mockReset();
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });

  it("accepts the hot stage and preserves cron authorization", async () => {
    process.env.CRON_SECRET = "unit-test-cron-secret";
    const denied = await call("hot");
    expect(denied.status).toBe(401);
    expect(runner.runCronStage).not.toHaveBeenCalled();
    runner.runCronStage.mockResolvedValue({ status: "success", summary: "Hot scan: no sales estimated", runs: [], unknown: false });
    const res = await GET(new Request("http://localhost/api/cron/hot", {
      headers: { authorization: ["Bearer", process.env.CRON_SECRET].join(" ") },
    }), { params: Promise.resolve({ stage: "hot" }) });
    expect(res.status).toBe(200);
    expect(runner.runCronStage).toHaveBeenCalledWith("hot", { force: false, business: null });
  });

  it("returns the failed summary with HTTP 500", async () => {
    delete process.env.CRON_SECRET;
    runner.runCronStage.mockResolvedValue({ status: "failed", summary: "Published 0, failed 1 (live)", runs: [], unknown: false });
    const res = await call("publish");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      stage: "publish",
      status: "failed",
      summary: "Published 0, failed 1 (live)",
      businesses: [],
    });
    expect(runner.runCronStage).toHaveBeenCalledWith("publish", { force: false, business: null });
  });

  it("returns 200 when a stage finishes with a warning", async () => {
    delete process.env.CRON_SECRET;
    runner.runCronStage.mockResolvedValue({ status: "warning", summary: "Briefed 0, generated 1/3 designs", runs: [], unknown: false });
    const res = await call("design");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stage: "design",
      status: "warning",
      summary: "Briefed 0, generated 1/3 designs",
      businesses: [],
    });
  });

  it("returns 200 when the stage succeeds", async () => {
    delete process.env.CRON_SECRET;
    runner.runCronStage.mockResolvedValue({ status: "success", summary: "Published 1, failed 0 (dry-run)", runs: [{ slug: "omnishop-ch", status: "success", summary: "Published 1, failed 0 (dry-run)" }], unknown: false });
    const res = await call("publish");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stage: "publish",
      status: "success",
      summary: "Published 1, failed 0 (dry-run)",
      businesses: [{ slug: "omnishop-ch", status: "success", summary: "Published 1, failed 0 (dry-run)" }],
    });
  });

  it("passes force=1 through and still requires the cron secret", async () => {
    delete process.env.CRON_SECRET;
    runner.runCronStage.mockResolvedValue({ status: "success", summary: "Daily chain finished", runs: [], unknown: false });
    const open = await call("daily", "?force=1");
    expect(open.status).toBe(200);
    expect(runner.runCronStage).toHaveBeenCalledWith("daily", { force: true, business: null });

    process.env.CRON_SECRET = "unit-test-cron-secret";
    runner.runCronStage.mockClear();
    const denied = await call("daily", "?force=1");
    expect(denied.status).toBe(401);
    expect(runner.runCronStage).not.toHaveBeenCalled();

    const allowed = await call("daily", "?force=1");
    expect(allowed.status).toBe(401);
    const authed = await GET(new Request("http://localhost/api/cron/daily?force=1&business=pinterest", { headers: { authorization: "Bearer unit-test-cron-secret" } }), {
      params: Promise.resolve({ stage: "daily" }),
    });
    expect(authed.status).toBe(200);
    expect(runner.runCronStage).toHaveBeenCalledWith("daily", { force: true, business: "pinterest" });
  });

  it("returns 404 for an unknown business slug", async () => {
    delete process.env.CRON_SECRET;
    runner.runCronStage.mockResolvedValue({ status: "failed", summary: "Unknown business nope", runs: [], unknown: true });
    const res = await call("publish", "?business=nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown business", business: "nope" });
  });
});
