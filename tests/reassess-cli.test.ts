import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getLLMProvider: vi.fn(), reassessDesigns: vi.fn() }));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/adapters/llm", () => ({ getLLMProvider: mocks.getLLMProvider }));
vi.mock("@/pipeline/reassess-designs", async (original) => ({
  ...await original<typeof import("@/pipeline/reassess-designs")>(),
  reassessDesigns: mocks.reassessDesigns,
}));

const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.resetModules();
});

it.each([
  [["68", "69"], { apply: false, rescore: false }, [68, 69]],
  [["--rescore", "73", "74"], { apply: false, rescore: true }, [73, 74]],
  [["73", "--apply", "--rescore"], { apply: true, rescore: true }, [73]],
])("passes CLI arguments %j to guarded re-assessment", async (args, options, ids) => {
  process.argv = ["node", "reassess-designs.ts", ...args];
  const db = {};
  const vision = { name: "test" };
  mocks.getDb.mockResolvedValue(db);
  mocks.getLLMProvider.mockReturnValue(vision);
  mocks.reassessDesigns.mockResolvedValue([]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("@/db/reassess-designs");
  await vi.waitFor(() => expect(log).toHaveBeenCalled());
  expect(mocks.getLLMProvider).toHaveBeenCalledWith({ demo: false });
  expect(mocks.reassessDesigns).toHaveBeenCalledWith(db, ids, vision, options);
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({ applied: options.apply, assessments: [] });
});

it("prints a sanitized top-level failure without a stack or database URL", async () => {
  process.argv = ["node", "reassess-designs.ts", "68"];
  vi.stubEnv("OLLAMA_API_KEY", "test-private-credential");
  mocks.getDb.mockRejectedValue(new Error("Database unavailable https://db.example/?token=private-url-value test-private-credential"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("@/db/reassess-designs");
  await vi.waitFor(() => expect(log).toHaveBeenCalled());
  expect(log).toHaveBeenCalledWith("Design re-assessment failed: Database unavailable [URL redacted] [redacted]. No listings were approved.");
  expect(process.exitCode).toBe(1);
});
