import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runStage: vi.fn(),
  after: vi.fn(),
  getDb: vi.fn(),
  rows: vi.fn(),
}));

vi.mock("@/pipeline/runner", () => ({ runStage: mocks.runStage }));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: mocks.after,
}));

import { GET } from "@/app/api/cron/[stage]/route";

function call(search: string, authorized = true) {
  return GET(new Request(`http://localhost/api/cron/daily${search}`, {
    headers: authorized ? { authorization: ["Bearer", "unit-test-cron-secret"].join(" ") } : {},
  }), { params: Promise.resolve({ stage: "daily" }) });
}

describe("background daily cron", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("acknowledges a persisted run before executing the daily chain", async () => {
    vi.stubEnv("CRON_SECRET", "unit-test-cron-secret");
    const execute = vi.fn().mockResolvedValue({ id: 42, status: "success" });
    mocks.runStage.mockImplementation(async (_stage, _trigger, opts) => {
      opts.defer(execute);
      return { id: 42, status: "running", summary: null };
    });
    const res = await call("?async=1&force=1");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: 42, stage: "daily", status: "running", summary: null });
    expect(mocks.runStage).toHaveBeenCalledWith("daily", "cron", {
      force: true, defer: expect.any(Function),
    });
    expect(execute).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["?async=1", "?runId=42"])("requires authorization for %s", async (search) => {
    vi.stubEnv("CRON_SECRET", "unit-test-cron-secret");
    expect((await call(search, false)).status).toBe(401);
    expect(mocks.runStage).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each([
    ["running", 202],
    ["success", 200],
    ["warning", 200],
    ["skipped", 200],
    ["failed", 500],
  ])("polls %s without starting another run", async (status, expected) => {
    vi.stubEnv("CRON_SECRET", "unit-test-cron-secret");
    mocks.rows.mockResolvedValue([{ id: 42, status, summary: "stage summary" }]);
    mocks.getDb.mockResolvedValue({ select: () => ({ from: () => ({ where: mocks.rows }) }) });
    const res = await call("?runId=42&force=1&async=1");
    expect(res.status).toBe(expected);
    expect(await res.json()).toEqual({ id: 42, stage: "daily", status, summary: "stage summary" });
    expect(mocks.runStage).not.toHaveBeenCalled();
  });

  it.each(["", "0", "-1", "abc", "1.5", "Infinity"])("rejects invalid run id %s", async (id) => {
    vi.stubEnv("CRON_SECRET", "unit-test-cron-secret");
    expect((await call(`?runId=${id}`)).status).toBe(400);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns 404 when the run does not exist for this stage", async () => {
    vi.stubEnv("CRON_SECRET", "unit-test-cron-secret");
    mocks.rows.mockResolvedValue([]);
    mocks.getDb.mockResolvedValue({ select: () => ({ from: () => ({ where: mocks.rows }) }) });
    expect((await call("?runId=42")).status).toBe(404);
    expect(mocks.runStage).not.toHaveBeenCalled();
  });
});
