import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_STAGES } from "@/lib/settings";
import { dailyStatsCsv } from "@/lib/analytics-csv";
import { filterProducts, filterQueue, planBulkStatus } from "@/lib/catalog-filters";
import { buildNextActions, type NextActionInput, type StageSnapshot } from "@/lib/next-actions";
import { externalCronExample, printifyCallbackUrl, printifyEventLog, PRINTIFY_WEBHOOK_TOPICS } from "@/lib/ops-copy";
import { pushEventEnabled, DEFAULT_PUSH_PREFS } from "@/lib/push-prefs";
import { dashboardTrendForRange } from "@/lib/dashboard-metrics";

const stages = (status: StageSnapshot["lastStatus"]): StageSnapshot[] =>
  (["research", "design", "listing", "publish", "orders", "analytics"] as const).map((id, index) => ({
    id,
    label: id,
    paused: false,
    cron: "0 5 * * *",
    lastStatus: status,
    lastStartedAt: status ? `2026-09-30T0${index}:00:00.000Z` : null,
    lastSummary: status === "failed" ? "boom" : null,
  }));

describe("dashboard trends", () => {
  const series = Array.from({ length: 30 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    revenue: index * 10,
    profit: index * 5,
  }));

  it("matches the visible revenue/profit trend to the selected KPI range", () => {
    expect(dashboardTrendForRange(series, "today")).toEqual(series.slice(-1));
    expect(dashboardTrendForRange(series, "7d")).toEqual(series.slice(-7));
    expect(dashboardTrendForRange(series, "30d")).toEqual(series);
    expect(dashboardTrendForRange([], "today")).toEqual([]);
  });
});

function input(patch: Partial<NextActionInput> = {}): NextActionInput {
  return {
    etsyConnected: true,
    etsyKeysReady: true,
    printifyConfigured: true,
    webhookSecretSet: true,
    printifyEventCount: 3,
    killSwitch: false,
    publishMode: "dry-run",
    stages: stages("success"),
    checks: [],
    ...patch,
  };
}

describe("next actions", () => {
  it("lists Etsy OAuth, a quiet webhook, and a cron that has never run from stored facts", () => {
    const items = buildNextActions(
      input({
        etsyConnected: false,
        etsyKeysReady: true,
        printifyEventCount: 0,
        stages: stages(null),
      }),
    );
    expect(items.map((item) => item.id)).toEqual(["etsy-oauth", "printify-webhook-quiet", "cron-never"]);
    expect(items[0].detail).toContain("billing onboarding");
    expect(items[0].href).toBe("/connections");
    expect(items[1].detail).toContain("printify_events");
    expect(items[1].detail).not.toMatch(/api\.printify\.com/i);
    expect(items[2].href).toBe("/connections#cron");
  });

  it("does not treat dry-run, demo, or an unconfigured Printify shop as a fake outage", () => {
    const items = buildNextActions(
      input({
        printifyConfigured: false,
        webhookSecretSet: false,
        printifyEventCount: 0,
        checks: [
          { id: "publish", name: "PUBLISH_MODE", level: "yellow", detail: "dry-run" },
          { id: "demo", name: "DEMO_MODE", level: "yellow", detail: "on" },
          { id: "printify", name: "Printify API", level: "yellow", detail: "dry-run adapter" },
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  it("prefers a missing webhook secret over a zero event count and surfaces failed runs", () => {
    const failed = stages("success").map((stage) => (stage.id === "publish" ? { ...stage, lastStatus: "failed" as const } : stage));
    const items = buildNextActions(input({ webhookSecretSet: false, printifyEventCount: 0, stages: failed, killSwitch: true }));
    expect(items.map((item) => item.id)).toEqual(["printify-webhook-secret", "cron-failed", "kill-switch"]);
    expect(items.find((item) => item.id === "kill-switch")?.href).toBe("/settings");
  });

  it("points live mode back at Connections without arming instructions", () => {
    const items = buildNextActions(input({ publishMode: "live" }));
    expect(items.map((item) => item.id)).toEqual(["publish-live"]);
    expect(items[0].detail).toContain("Return to dry-run");
    expect(items[0].detail).not.toContain("CONFIRM");
  });

  it("includes red health checks that are not already covered", () => {
    const items = buildNextActions(
      input({
        checks: [{ id: "auth", name: "Dashboard auth", level: "red", detail: "Set DASHBOARD_PASSWORD and AUTH_SECRET." }],
      }),
    );
    expect(items[0]).toMatchObject({ id: "health-auth", href: "/connections#setup" });
  });
});

describe("ops copy", () => {
  it("builds the Printify callback from APP_URL and lists the recommended topics", () => {
    expect(printifyCallbackUrl("https://etsy-autopilot-production-8b9f.up.railway.app")).toBe(
      "https://etsy-autopilot-production-8b9f.up.railway.app/api/webhooks/printify",
    );
    expect(printifyCallbackUrl(undefined)).toBe("/api/webhooks/printify");
    expect(PRINTIFY_WEBHOOK_TOPICS).toContain("order:shipment:delivered");
    expect(PRINTIFY_WEBHOOK_TOPICS).toContain("product:publish:started");
  });

  it("prints an external cron example that keeps the secret placeholder", () => {
    const example = externalCronExample("https://shop.example");
    expect(example).toContain("Authorization: Bearer $CRON_SECRET");
    expect(example).toContain("https://shop.example/api/cron/orders");
    expect(example).toContain("CRON_SECRET");
    expect(example).toContain("AUTOPILOT_URL");
    expect(example).not.toMatch(/Bearer [A-Za-z0-9+/=]{8,}/);
    expect(externalCronExample(undefined)).toContain('"$APP_URL/api/cron/research"');
  });

  it("keeps only ids, topics, and timestamps in the webhook log", () => {
    const log = printifyEventLog([
      {
        id: 4,
        eventId: "evt-1",
        topic: "order:created",
        createdAt: "2026-09-30T12:00:00.000Z",
        verified: true,
        payload: { email: "buyer@example.com", address1: "secret street" },
      } as never,
    ]);
    expect(log).toEqual([
      { id: 4, eventId: "evt-1", topic: "order:created", createdAt: "2026-09-30T12:00:00.000Z", verified: true },
    ]);
    expect(JSON.stringify(log)).not.toContain("buyer@example.com");
  });
});

describe("catalog filters", () => {
  const rows = [
    { id: 1, title: "Alpine lake print", tags: ["alps"], niche: "alpine", status: "pending_approval", validation: [] },
    { id: 2, title: "Gothic poster", tags: ["bat"], niche: "gothic", status: "pending_approval", validation: [{ severity: "error" }] },
    { id: 3, title: "Birthday card", tags: ["invite"], niche: "birthday", status: "published", validation: [] },
  ];

  it("filters the queue by search, niche, and validation status", () => {
    expect(filterQueue(rows, { query: "lake", niche: "all", status: "all" }).map((row) => row.id)).toEqual([1]);
    expect(filterQueue(rows, { query: "", niche: "gothic", status: "all" }).map((row) => row.id)).toEqual([2]);
    expect(filterQueue(rows, { query: "bat", niche: "all", status: "needs_fixes" }).map((row) => row.id)).toEqual([2]);
    expect(filterQueue(rows, { query: "", niche: "all", status: "ready" }).map((row) => row.id)).toEqual([1, 3]);
  });

  it("filters products and skips invalid approvals in a bulk plan", () => {
    expect(filterProducts(rows, { query: "", niche: "all", status: "published" }).map((row) => row.id)).toEqual([3]);
    const plan = planBulkStatus(
      [
        { id: 1, title: "Ok", hasErrors: false },
        { id: 2, title: "Bad", hasErrors: true },
      ],
      "approved",
    );
    expect(plan.changed).toEqual([1]);
    expect(plan.skipped.map((row) => row.id)).toEqual([2]);
    expect(planBulkStatus([{ id: 2, title: "Bad", hasErrors: true }], "rejected").changed).toEqual([2]);
  });
});

describe("analytics csv", () => {
  it("exports the visible range with CHF formatting", () => {
    const csv = dailyStatsCsv([
      { date: "2026-09-30", views: 12, favorites: 1, orders: 1, revenueChf: 8, profitChf: 6.37 },
    ]);
    expect(csv.split("\n")[0]).toBe("date,views,favorites,orders,revenue_chf,profit_chf");
    expect(csv).toContain("2026-09-30,12,1,1,CHF 8.00,CHF 6.37");
  });
});

describe("github actions cron", () => {
  it("matches the default stage schedules and keeps secrets in GitHub, not the file", () => {
    const yaml = readFileSync(new URL("../.github/workflows/autopilot-cron.yml", import.meta.url), "utf8");
    for (const [stage, settings] of Object.entries(DEFAULT_STAGES)) {
      expect(yaml).toContain(`cron: "${settings.cron}"`);
      expect(yaml).toContain(`/api/cron/${stage}`);
    }
    expect(yaml).toContain("workflow_dispatch");
    expect(yaml).toContain("secrets.CRON_SECRET");
    expect(yaml).toContain("secrets.AUTOPILOT_URL");
    expect(yaml).toContain("https://etsy-autopilot-production-8b9f.up.railway.app");
    expect(yaml).not.toMatch(/Bearer [A-Za-z0-9+/=]{8,}/);
    expect(yaml).not.toMatch(/CRON_SECRET:\s*["'][^$]/);
  });
});

describe("push prefs", () => {
  it("gates the three event groups and maps publish failures onto failed jobs", () => {
    expect(pushEventEnabled(DEFAULT_PUSH_PREFS, "order.new")).toBe(true);
    expect(pushEventEnabled({ ...DEFAULT_PUSH_PREFS, "order.new": false }, "order.new")).toBe(false);
    expect(pushEventEnabled({ ...DEFAULT_PUSH_PREFS, "job.failed": false }, "listing.failed")).toBe(false);
    expect(pushEventEnabled(DEFAULT_PUSH_PREFS, "design.generated")).toBe(false);
  });
});
