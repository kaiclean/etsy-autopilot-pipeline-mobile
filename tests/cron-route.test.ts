import { afterEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ runStage: vi.fn() }));

vi.mock("@/pipeline/runner", () => ({ runStage: runner.runStage }));

import { GET } from "@/app/api/cron/[stage]/route";

const savedSecret = process.env.CRON_SECRET;

function call(stage: string, search = "") {
  return GET(new Request(`http://localhost/api/cron/${stage}${search}`), {
    params: Promise.resolve({ stage }),
  });
}

describe("cron stage route", () => {
  afterEach(() => {
    runner.runStage.mockReset();
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });

  it("returns the failed summary with HTTP 500", async () => {
    delete process.env.CRON_SECRET;
    runner.runStage.mockResolvedValue({ status: "failed", summary: "Published 0, failed 1 (live)" });
    const res = await call("publish");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      stage: "publish",
      status: "failed",
      summary: "Published 0, failed 1 (live)",
    });
    expect(runner.runStage).toHaveBeenCalledWith("publish", "cron", { force: false });
  });

  it("returns 200 when the stage succeeds", async () => {
    delete process.env.CRON_SECRET;
    runner.runStage.mockResolvedValue({ status: "success", summary: "Published 1, failed 0 (dry-run)" });
    const res = await call("publish");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stage: "publish",
      status: "success",
      summary: "Published 1, failed 0 (dry-run)",
    });
  });

  it("passes force=1 through and still requires the cron secret", async () => {
    delete process.env.CRON_SECRET;
    runner.runStage.mockResolvedValue({ status: "success", summary: "Daily chain finished" });
    const open = await call("daily", "?force=1");
    expect(open.status).toBe(200);
    expect(runner.runStage).toHaveBeenCalledWith("daily", "cron", { force: true });

    process.env.CRON_SECRET = "unit-test-cron-secret";
    runner.runStage.mockClear();
    const denied = await call("daily", "?force=1");
    expect(denied.status).toBe(401);
    expect(runner.runStage).not.toHaveBeenCalled();

    const allowed = await call("daily", "?force=1");
    expect(allowed.status).toBe(401);
    const authed = await GET(new Request("http://localhost/api/cron/daily?force=1", { headers: { authorization: "Bearer unit-test-cron-secret" } }), {
      params: Promise.resolve({ stage: "daily" }),
    });
    expect(authed.status).toBe(200);
    expect(runner.runStage).toHaveBeenCalledWith("daily", "cron", { force: true });
  });
});
