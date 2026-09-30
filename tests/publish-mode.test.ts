import { afterEach, describe, expect, it } from "vitest";
import { GO_LIVE_ACK, GO_LIVE_CONFIRMATION, effectivePublishMode, goLiveDecision } from "@/lib/publish-mode";
import { etsyRedirectUri, publicAppOrigin, setupChecklist, setupPresence, stepStatus, SETUP_STEPS } from "@/lib/setup-guide";

const ENV_KEYS = ["APP_URL", "DATABASE_URL", "ETSY_API_KEY", "OPENAI_API_KEY", "DASHBOARD_PASSWORD"] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("go-live gate", () => {
  it("defaults every unrecognized choice to dry-run", () => {
    expect(effectivePublishMode(undefined)).toBe("dry-run");
    expect(effectivePublishMode("dry-run")).toBe("dry-run");
    expect(effectivePublishMode("LIVE")).toBe("dry-run");
    expect(effectivePublishMode(true)).toBe("dry-run");
    expect(effectivePublishMode("live")).toBe("live");
  });

  it("rejects live writes without the checkbox and the exact confirmation", () => {
    expect(GO_LIVE_ACK).toBe("I understand this publishes to Etsy/Printify");
    expect(GO_LIVE_CONFIRMATION).toBe("CONFIRM");
    expect(goLiveDecision({ mode: "live", understood: false, confirmation: "CONFIRM" })).toEqual({
      ok: false,
      error: "Check the box to confirm this publishes to Etsy and Printify.",
    });
    expect(goLiveDecision({ mode: "live", understood: true, confirmation: "confirm" }).ok).toBe(false);
    expect(goLiveDecision({ mode: "live", understood: true, confirmation: "" }).ok).toBe(false);
    expect(goLiveDecision({ mode: "live", understood: true, confirmation: "CONFIRM" })).toEqual({ ok: true, mode: "live" });
  });

  it("lets dry-run through without a confirmation", () => {
    expect(goLiveDecision({ mode: "dry-run" })).toEqual({ ok: true, mode: "dry-run" });
    expect(goLiveDecision({ mode: "sometimes" }).ok).toBe(false);
  });
});

describe("setup guide", () => {
  it("lists where to connect each store and never includes a secret value", () => {
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    process.env.DATABASE_URL = "postgres://autopilot:s3cret-db-password@ep-example.neon.tech/shop";
    process.env.OPENAI_API_KEY = "sk-live-should-not-leak";
    process.env.APP_URL = "https://user:pass@shop.example";
    const checklist = setupChecklist();
    const blob = JSON.stringify({ steps: SETUP_STEPS, checklist, presence: setupPresence(), origin: publicAppOrigin() });
    expect(checklist).toContain("PUBLISH_MODE=dry-run");
    expect(checklist).not.toContain("PUBLISH_MODE=live");
    expect(SETUP_STEPS.map((step) => step.id)).toEqual(["neon", "etsy", "printify", "llm", "storage", "push", "auth", "app"]);
    expect(SETUP_STEPS.find((step) => step.id === "etsy")?.envVars).toEqual([
      "ETSY_API_KEY",
      "ETSY_SHARED_SECRET",
      "ETSY_SHOP_ID",
      "ETSY_REDIRECT_URI",
    ]);
    expect(blob).not.toContain("s3cret-db-password");
    expect(blob).not.toContain("sk-live-should-not-leak");
    expect(blob).not.toContain("postgres://");
    expect(publicAppOrigin()).toBe("https://shop.example");
    expect(etsyRedirectUri()).toBe("https://shop.example/api/etsy/oauth/callback");
    expect(setupPresence().DATABASE_URL).toBe(true);
    expect(setupPresence().OPENAI_API_KEY).toBe(true);
  });

  it("marks Etsy partial until OAuth tokens exist", () => {
    const etsy = SETUP_STEPS.find((step) => step.id === "etsy")!;
    const presence = Object.fromEntries(etsy.envVars.map((name) => [name, true]));
    expect(stepStatus(etsy, presence, false)).toBe("partial");
    expect(stepStatus(etsy, presence, true)).toBe("ready");
    expect(stepStatus(etsy, {}, false)).toBe("missing");
  });
});