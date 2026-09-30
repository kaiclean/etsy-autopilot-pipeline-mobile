import { afterEach, describe, expect, it } from "vitest";
import { connectionHealth } from "@/lib/health";
import { listingProvenance, orderProvenance } from "@/lib/provenance";

const ENV_KEYS = [
  "DATABASE_URL",
  "DEMO_MODE",
  "PUBLISH_MODE",
  "ETSY_API_KEY",
  "ETSY_SHARED_SECRET",
  "ETSY_SHOP_ID",
  "ETSY_REDIRECT_URI",
  "PRINTIFY_API_TOKEN",
  "PRINTIFY_SHOP_ID",
  "PRINTIFY_BLUEPRINT_ID",
  "LLM_PROVIDER",
  "IMAGE_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_IMAGE_MODEL",
  "HIGGSFIELD_API_KEY",
  "REPLICATE_API_TOKEN",
  "DASHBOARD_PASSWORD",
  "AUTH_SECRET",
  "PRINTIFY_WEBHOOK_SECRET",
  "VAPID_PRIVATE_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "S3_BUCKET",
] as const;

const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearModeEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  restoreEnv();
});

describe("connection health", () => {
  it("reports the dry-run demo defaults without secret values", () => {
    clearModeEnv();
    process.env.DATABASE_URL = "postgres://autopilot:s3cret-db-password@ep-example.neon.tech/shop";
    process.env.OPENAI_API_KEY = "sk-live-should-not-leak";
    process.env.PRINTIFY_WEBHOOK_SECRET = "whsec-should-not-leak";
    process.env.VAPID_PRIVATE_KEY = "vapid-private-should-not-leak";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-should-not-leak";
    process.env.S3_BUCKET = "bucket-name-should-not-leak";
    const checks = connectionHealth({ etsyConnected: false });
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
    const blob = JSON.stringify(checks);

    expect(byId.database.level).toBe("green");
    expect(byId.database.label).toBe("Connected");
    expect(byId.etsy.level).toBe("red");
    expect(byId.etsy.label).toBe("Missing");
    expect(byId.printify.level).toBe("yellow");
    expect(byId.llm.level).toBe("yellow");
    expect(byId.images.level).toBe("yellow");
    expect(byId.publish.level).toBe("yellow");
    expect(byId.publish.label).toBe("Dry-run");
    expect(byId.demo.level).toBe("yellow");
    expect(byId.database.envVars).toContain("DATABASE_URL");
    expect(byId.publish.envVars).toEqual(["PUBLISH_MODE"]);
    expect(byId.demo.envVars).toEqual(["DEMO_MODE"]);
    expect(byId.storage).toBeDefined();
    expect(byId.webpush).toBeDefined();
    expect(blob).not.toContain("s3cret-db-password");
    expect(blob).not.toContain("sk-live-should-not-leak");
    expect(blob).not.toContain("whsec-should-not-leak");
    expect(blob).not.toContain("vapid-private-should-not-leak");
    expect(blob).not.toContain("aws-secret-should-not-leak");
    expect(blob).not.toContain("bucket-name-should-not-leak");
    expect(blob).not.toContain("postgres://");
  });

  it("turns Etsy yellow when keys exist and tokens do not", () => {
    clearModeEnv();
    process.env.ETSY_API_KEY = "keystring";
    process.env.ETSY_SHARED_SECRET = "shared";
    process.env.ETSY_SHOP_ID = "12345";
    const etsy = connectionHealth({ etsyConnected: false }).find((check) => check.id === "etsy");
    expect(etsy?.level).toBe("yellow");
    expect(etsy?.label).toBe("No tokens");
    expect(JSON.stringify(etsy)).not.toContain("shared");
  });

  it("turns Etsy green when tokens are stored and still hides them", () => {
    clearModeEnv();
    process.env.ETSY_API_KEY = "keystring";
    process.env.ETSY_SHARED_SECRET = "shared-secret-value";
    process.env.ETSY_SHOP_ID = "99";
    const etsy = connectionHealth({ etsyConnected: true }).find((check) => check.id === "etsy");
    expect(etsy?.level).toBe("green");
    expect(etsy?.detail).toContain("shop 99");
    expect(etsy?.detail).not.toContain("shared-secret-value");
  });

  it("keeps the health row on dry-run until the dashboard choice is live", () => {
    clearModeEnv();
    process.env.PUBLISH_MODE = "live";
    process.env.DEMO_MODE = "false";
    process.env.ETSY_API_KEY = "keystring";
    process.env.ETSY_SHARED_SECRET = "shared";
    process.env.ETSY_SHOP_ID = "99";
    process.env.LLM_PROVIDER = "openai";
    process.env.IMAGE_PROVIDER = "replicate";
    const locked = connectionHealth({ etsyConnected: false });
    const armed = connectionHealth({ etsyConnected: false, publishMode: "live" });
    const lockedById = Object.fromEntries(locked.map((check) => [check.id, check]));
    const armedById = Object.fromEntries(armed.map((check) => [check.id, check]));
    expect(lockedById.publish.level).toBe("yellow");
    expect(lockedById.publish.label).toBe("Dry-run");
    expect(lockedById.publish.detail).toContain("Host PUBLISH_MODE is live");
    expect(armedById.publish.level).toBe("red");
    expect(armedById.publish.label).toBe("Live");
    expect(lockedById.demo.level).toBe("green");
    expect(lockedById.llm.level).toBe("red");
    expect(lockedById.images.level).toBe("red");
  });

  it("describes a configured OpenAI-compatible provider without the key", () => {
    clearModeEnv();
    process.env.LLM_PROVIDER = "openai";
    process.env.IMAGE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_MODEL = "openai/gpt-4.1-mini";
    process.env.OPENAI_IMAGE_MODEL = "google/gemini-2.5-flash-image";
    const checks = connectionHealth({ etsyConnected: false });
    const llm = checks.find((check) => check.id === "llm");
    const images = checks.find((check) => check.id === "images");
    expect(llm?.level).toBe("green");
    expect(llm?.detail).toBe("OpenAI-compatible · openai/gpt-4.1-mini · https://openrouter.ai/api/v1");
    expect(images?.detail).toBe("OpenAI-compatible · google/gemini-2.5-flash-image · https://openrouter.ai/api/v1");
    expect(JSON.stringify(checks)).not.toContain("sk-test");
  });
});

describe("data provenance", () => {
  it("labels seeded rows as demo even when they look published", () => {
    expect(listingProvenance({ isDemo: true, publishMode: "dry-run", etsyListingId: "dry-abc" })).toBe("demo");
    expect(listingProvenance({ isDemo: true, publishMode: "live", etsyListingId: "998877" })).toBe("demo");
    expect(orderProvenance({ isDemo: true, etsyReceiptId: "demo-r-1" })).toBe("demo");
  });

  it("labels pipeline drafts and simulated receipts as dry-run", () => {
    expect(listingProvenance({ isDemo: false, publishMode: null, etsyListingId: null })).toBe("dry-run");
    expect(listingProvenance({ isDemo: false, publishMode: "dry-run", etsyListingId: "dry-etsy-1" })).toBe("dry-run");
    expect(listingProvenance({ isDemo: false, publishMode: "live", etsyListingId: "dry-etsy-1" })).toBe("dry-run");
    expect(orderProvenance({ isDemo: false, etsyReceiptId: "dry-r-1" })).toBe("dry-run");
  });

  it("labels real Etsy ids as live", () => {
    expect(listingProvenance({ isDemo: false, publishMode: "live", etsyListingId: "445566" })).toBe("live");
    expect(orderProvenance({ isDemo: false, etsyReceiptId: "3899123" })).toBe("live");
  });
});
