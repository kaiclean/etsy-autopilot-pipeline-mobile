import path from "node:path";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { events, jobRuns } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import type { StageContext } from "@/pipeline/types";

const stages = vi.hoisted(() => ({
  research: vi.fn(),
  design: vi.fn(),
  listing: vi.fn(),
  orders: vi.fn(),
  maintenance: vi.fn(),
}));
vi.mock("@/pipeline/research", () => ({ runResearch: stages.research }));
vi.mock("@/pipeline/design", () => ({ runDesign: stages.design }));
vi.mock("@/pipeline/listing", () => ({ runListing: stages.listing }));
vi.mock("@/pipeline/orders", () => ({ runOrders: stages.orders }));
vi.mock("@/pipeline/maintenance", () => ({ runMaintenance: stages.maintenance }));

import { runStage } from "@/pipeline/runner";

describe("long-running cron stages", () => {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema }) as unknown as DB;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  });
  afterAll(async () => { await client.close(); });
  beforeEach(async () => {
    await db.delete(jobRuns);
    await db.delete(events);
    for (const stage of Object.values(stages)) stage.mockReset().mockResolvedValue("Finished");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["daily", "orders"] as const)("keeps %s exclusive beyond five minutes, even with force", async (stage) => {
    let finish!: (summary: string) => void;
    const work = stage === "daily" ? stages.research : stages.orders;
    work.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = runStage(stage, "cron", { db, force: true });
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    try {
      // Reproduce the old five-minute overlap window without slowing the test.
      await db.update(jobRuns).set({ startedAt: new Date(Date.now() - 6 * 60_000) });
      const duplicates = await Promise.all([
        runStage(stage, "cron", { db, force: true }),
        runStage(stage, "manual", { db, force: true }),
      ]);
      expect(duplicates.map((run) => run.status)).toEqual(["skipped", "skipped"]);
      expect(duplicates.every((run) => run.summary === "Already running")).toBe(true);
      expect(work).toHaveBeenCalledOnce();
    } finally {
      finish("Finished");
      await first;
    }
    expect((await runStage(stage, "cron", { db, force: true })).status).toBe("success");
  });

  it("atomically guards simultaneous daily requests before database reads finish", async () => {
    const runs = await Promise.all([
      runStage("daily", "cron", { db, force: true }),
      runStage("daily", "cron", { db, force: true }),
    ]);
    expect(runs.map((run) => run.status).sort()).toEqual(["skipped", "success"]);
    expect(stages.research).toHaveBeenCalledOnce();
  });

  it.each(["daily", "orders"] as const)("releases the %s guard after a failure", async (stage) => {
    const work = stage === "daily" ? stages.research : stages.orders;
    work.mockRejectedValueOnce(new Error("Stage failed"));
    expect((await runStage(stage, "cron", { db, force: true })).status).toBe("failed");
    expect((await runStage(stage, "cron", { db, force: true })).status).toBe("success");
    const failures = await db.select().from(events).where(eq(events.type, "job.failed"));
    expect(failures.length).toBeGreaterThan(0);
    if (stage === "orders") expect(stages.maintenance).not.toHaveBeenCalled();
  });

  it("persists redacted logs and activity progress while daily work is still running", async () => {
    let finish!: (summary: string) => void;
    stages.research.mockImplementationOnce((ctx: StageContext) => {
      ctx.log("Working; access_token=example-test-credential");
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const automation = await getSetting(db, "automation");
    const first = runStage("daily", "cron", { db, force: true });
    await vi.waitFor(() => expect(stages.research).toHaveBeenCalledOnce());
    try {
      await vi.waitFor(async () => {
        const [research] = await db.select().from(jobRuns).where(eq(jobRuns.stage, "research"));
        expect(research.status).toBe("running");
        expect(research.logs.some((line) => line.msg === "Working; access_token=[redacted]")).toBe(true);
        const [daily] = await db.select().from(jobRuns).where(eq(jobRuns.stage, "daily"));
        expect(daily.status).toBe("running");
        expect(daily.logs.some((line) => line.msg === "Starting research")).toBe(true);
      });
      const activity = await db.select().from(events);
      expect(activity.map((event) => event.type)).toEqual(expect.arrayContaining(["job.started", "job.progress"]));
    } finally {
      finish("Finished research");
      await first;
    }
    expect((await getSetting(db, "automation"))).toEqual(automation);
  });

  it("preserves pause/kill-switch behavior and releases skipped guards", async () => {
    const automation = await getSetting(db, "automation");
    await setSetting(db, "automation", { ...automation, killSwitch: true });
    try {
      expect((await runStage("daily", "cron", { db })).status).toBe("skipped");
      expect(stages.research).not.toHaveBeenCalled();
    } finally {
      await setSetting(db, "automation", automation);
    }
    expect((await runStage("daily", "cron", { db, force: true })).status).toBe("success");
  });
  it("does not undo an operator's publish-mode change while a daily run is active",async()=>{
    let finish!:(value:string)=>void;
    stages.research.mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const old=await getSetting(db,"automation");
    await setSetting(db,"automation",{...old,publishMode:"live"});
    const run=runStage("daily","manual",{db,force:true});
    await vi.waitFor(()=>expect(stages.research).toHaveBeenCalledOnce());
    await setSetting(db,"automation",{...old,publishMode:"dry-run"});
    finish("done"); await run;
    expect((await getSetting(db,"automation")).publishMode).toBe("dry-run");
    await setSetting(db,"automation",old);
  });

});
