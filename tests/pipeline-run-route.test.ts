import { afterEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({
  runStage: vi.fn(),
  runFullPipeline: vi.fn(),
}));
const session = vi.hoisted(() => ({ requireAuth: vi.fn() }));

vi.mock("@/pipeline/runner", () => ({
  runStage: runner.runStage,
  runFullPipeline: runner.runFullPipeline,
}));
vi.mock("@/lib/session", () => ({ requireAuth: session.requireAuth }));

import { POST } from "@/app/api/pipeline/[stage]/run/route";

function call(stage: string, search = "") {
  return POST(new Request(`http://localhost/api/pipeline/${stage}/run${search}`, { method: "POST" }), {
    params: Promise.resolve({ stage }),
  });
}

describe("dashboard pipeline run", () => {
  afterEach(() => {
    runner.runStage.mockReset();
    runner.runFullPipeline.mockReset();
    session.requireAuth.mockReset();
  });

  it("rejects ?force=1 when the dashboard session is missing", async () => {
    session.requireAuth.mockRejectedValue(new Error("Unauthorized"));
    const res = await call("daily", "?force=1");
    expect(res.status).toBe(401);
    expect(runner.runStage).not.toHaveBeenCalled();
  });

  it("passes ?force=1 for the daily chain after login", async () => {
    session.requireAuth.mockResolvedValue(undefined);
    runner.runStage.mockResolvedValue({ id: "run-1", stage: "daily", status: "success", summary: "Daily chain finished", logs: [] });
    const res = await call("daily", "?force=1");
    expect(res.status).toBe(200);
    expect(runner.runStage).toHaveBeenCalledWith("daily", "manual", { force: true });
  });

  it("does not force a non-daily stage", async () => {
    session.requireAuth.mockResolvedValue(undefined);
    runner.runStage.mockResolvedValue({ id: "run-2", stage: "design", status: "success", summary: "ok", logs: [] });
    const res = await call("design", "?force=1");
    expect(res.status).toBe(200);
    expect(runner.runStage).toHaveBeenCalledWith("design", "manual", { force: false });
  });
});
