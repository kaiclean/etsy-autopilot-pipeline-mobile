import { afterEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ runStage: vi.fn() }));
const background = vi.hoisted(() => ({ callbacks: [] as Array<() => Promise<void>> }));

vi.mock("@/pipeline/runner", () => ({ runStage: runner.runStage }));
vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: (callback: () => Promise<void>) => background.callbacks.push(callback),
}));

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
    background.callbacks.length = 0;
    vi.restoreAllMocks();
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });

  it.each(["daily", "orders"])("accepts %s without waiting for stage execution", async (stage) => {
    delete process.env.CRON_SECRET;
    let finish!: () => void;
    runner.runStage.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const res = await call(stage);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stage, status: "accepted" });
    expect(runner.runStage).not.toHaveBeenCalled();
    expect(background.callbacks).toHaveLength(1);
    const work = background.callbacks[0]();
    expect(runner.runStage).toHaveBeenCalledWith(stage, "cron", { force: false });
    finish();
    await work;
  });

  it("handles unexpected background failures without an unhandled rejection", async () => {
    delete process.env.CRON_SECRET;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    runner.runStage.mockRejectedValue(new Error("Could not start background run"));
    expect((await call("daily")).status).toBe(202);
    await expect(background.callbacks[0]()).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Could not start background run"));
  });

  it.each(["daily", "orders"])("does not schedule unauthorized %s work", async (stage) => {
    process.env.CRON_SECRET = "unit-test-cron-secret";
    expect((await call(stage)).status).toBe(401);
    expect(background.callbacks).toHaveLength(0);
    expect(runner.runStage).not.toHaveBeenCalled();
  });

  it("does not schedule an unknown stage", async () => {
    delete process.env.CRON_SECRET;
    expect((await call("unknown")).status).toBe(404);
    expect(background.callbacks).toHaveLength(0);
    expect(runner.runStage).not.toHaveBeenCalled();
  });

  it("accepts the hot stage and preserves cron authorization", async () => {
    process.env.CRON_SECRET = "unit-test-cron-secret";
    const denied = await call("hot");
    expect(denied.status).toBe(401);
    expect(runner.runStage).not.toHaveBeenCalled();
    runner.runStage.mockResolvedValue({ status: "success", summary: "Hot scan: no sales estimated" });
    const res = await GET(new Request("http://localhost/api/cron/hot", {
      headers: { authorization: ["Bearer", process.env.CRON_SECRET].join(" ") },
    }), { params: Promise.resolve({ stage: "hot" }) });
    expect(res.status).toBe(200);
    expect(runner.runStage).toHaveBeenCalledWith("hot", "cron", { force: false });
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

  it("returns 200 when a stage finishes with a warning", async () => {
    delete process.env.CRON_SECRET;
    runner.runStage.mockResolvedValue({ status: "warning", summary: "Briefed 0, generated 1/3 designs" });
    const res = await call("design");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stage: "design",
      status: "warning",
      summary: "Briefed 0, generated 1/3 designs",
    });
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
    expect(open.status).toBe(202);
    await background.callbacks[0]();
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
    expect(authed.status).toBe(202);
    await background.callbacks[1]();
    expect(runner.runStage).toHaveBeenCalledWith("daily", "cron", { force: true });
  });
});
