import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import { config, hasPrintifyCredentials, storageBackend } from "./config";
import { resolveActiveShop, readEtsyTokens } from "./shops";
import { localOllamaConfig } from "./free-mode";

export type ProbeStatus = "ok" | "warn" | "fail" | "skipped";
export type Probe = { id: string; name: string; status: ProbeStatus; detail: string; latencyMs: number | null; env: Record<string, boolean> };
export type DeepHealth = { at: string; overall: ProbeStatus; probes: Probe[]; cached: boolean };
type Fetch = typeof fetch;

const has = (...names: string[]) => Object.fromEntries(names.map((n) => [n, !!process.env[n]?.trim()]));
const TIMEOUT = 5000;

/** GET with a timeout. Returns only the status code: response bodies can echo account data and are never surfaced. */
async function probeGet(f: Fetch, url: string, headers: Record<string, string>) {
  const t0 = Date.now();
  try {
    const r = await f(url, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" });
    await r.body?.cancel().catch(() => {});
    return { code: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { code: 0, ms: Date.now() - t0, error: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network error" };
  }
}
const httpProbe = (p: { code: number; error?: string }, okHint = "reachable"): { status: ProbeStatus; detail: string } =>
  p.code >= 200 && p.code < 300 ? { status: "ok", detail: okHint }
    : p.code === 401 || p.code === 403 ? { status: "fail", detail: `HTTP ${p.code}: key rejected or expired` }
    : p.code === 429 ? { status: "warn", detail: "HTTP 429: rate limited" }
    : p.code === 0 ? { status: "fail", detail: p.error ?? "unreachable" }
    : { status: "warn", detail: `HTTP ${p.code}` };

async function neonProbe(db: DB): Promise<Probe> {
  const env = has("DATABASE_URL");
  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    const one = Date.now() - t0;
    const t1 = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => db.execute(sql`select 1`)));
    const burst = Date.now() - t1;
    const local = !config.databaseUrl;
    return { id: "neon", name: local ? "Database (PGlite)" : "Neon Postgres", status: burst > 4000 ? "warn" : "ok",
      detail: `select 1 in ${one} ms; 8 concurrent in ${burst} ms${local ? " (embedded, no DATABASE_URL)" : ""}`, latencyMs: one, env };
  } catch {
    return { id: "neon", name: "Neon Postgres", status: "fail", detail: "query failed", latencyMs: Date.now() - t0, env };
  }
}

async function etsyProbe(db: DB, f: Fetch): Promise<Probe> {
  const env = has("ETSY_API_KEY", "ETSY_SHARED_SECRET", "ETSY_SHOP_ID", "ETSY_REDIRECT_URI");
  const base = { id: "etsy", name: "Etsy", env };
  if (!config.etsy.apiKey || !config.etsy.sharedSecret) return { ...base, status: "skipped", detail: "ETSY_API_KEY / ETSY_SHARED_SECRET not set", latencyMs: null };
  const p = await probeGet(f, "https://openapi.etsy.com/v3/application/openapi-ping", { "x-api-key": `${config.etsy.apiKey}:${config.etsy.sharedSecret}` });
  const r = httpProbe(p, "API key accepted (openapi-ping)");
  let oauth = "no OAuth tokens stored: connect the shop";
  let worst: ProbeStatus = "warn";
  try {
    const shop = await resolveActiveShop(db);
    const t = await readEtsyTokens(db, shop.id);
    if (t) {
      worst = t.refreshError ? "fail" : "ok";
      // Access tokens last 1 h and refresh on use; the refresh token is what matters.
      oauth = t.refreshError ? "last token refresh failed: reconnect Etsy" : `OAuth connected (access token ${t.expiresAt > Date.now() ? "valid" : "expired, refreshes on next call"})`;
    }
  } catch { oauth = "could not read OAuth state"; }
  const order: ProbeStatus[] = ["ok", "skipped", "warn", "fail"];
  const status = order[Math.max(order.indexOf(r.status), order.indexOf(worst))];
  return { ...base, status, detail: `${r.detail}; ${oauth}`, latencyMs: p.ms };
}

async function printifyProbe(f: Fetch): Promise<Probe> {
  const env = has("PRINTIFY_API_TOKEN", "PRINTIFY_SHOP_ID", "PRINTIFY_WEBHOOK_SECRET");
  if (!hasPrintifyCredentials()) return { id: "printify", name: "Printify", env, status: "skipped", detail: "PRINTIFY_API_TOKEN / PRINTIFY_SHOP_ID not set", latencyMs: null };
  const p = await probeGet(f, "https://api.printify.com/v1/shops.json", { Authorization: `Bearer ${config.printify.token}`, "User-Agent": "etsy-autopilot-health" });
  return { id: "printify", name: "Printify", env, ...httpProbe(p, "token accepted (shops.json)"), latencyMs: p.ms };
}

async function storageProbe(): Promise<Probe> {
  const env = has("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "S3_BUCKET", "AWS_S3_BUCKET_NAME", "BLOB_READ_WRITE_TOKEN");
  const backend = storageBackend();
  if (backend !== "s3") return { id: "s3", name: "Object storage", env, status: backend === "blob" ? "ok" : "warn", detail: backend === "blob" ? "Vercel Blob fallback (not probed)" : "no storage configured", latencyMs: null };
  const t0 = Date.now();
  try {
    const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");
    const s = config.storage;
    const c = new S3Client({ region: s.region, endpoint: s.endpoint, forcePathStyle: s.forcePathStyle, credentials: { accessKeyId: s.accessKeyId ?? "", secretAccessKey: s.secretAccessKey ?? "" } });
    await c.send(new HeadBucketCommand({ Bucket: s.bucket! }), { abortSignal: AbortSignal.timeout(TIMEOUT) });
    return { id: "s3", name: "Object storage (S3)", env, status: "ok", detail: "bucket reachable (HeadBucket)", latencyMs: Date.now() - t0 };
  } catch (e) {
    const code = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return { id: "s3", name: "Object storage (S3)", env, status: "fail", detail: code ? `HeadBucket HTTP ${code}` : "HeadBucket failed", latencyMs: Date.now() - t0 };
  }
}

async function llmProbe(f: Fetch): Promise<Probe> {
  const p = config.llmProvider;
  if (p === "ollama-local") {
    const env = has("LLM_PROVIDER", "OLLAMA_LOCAL_MODEL", "OLLAMA_LOCAL_BASE_URL", "OLLAMA_LOCAL_VISION_MODEL");
    try {
      localOllamaConfig();
      return { id: "llm", name: "LLM (local Ollama)", env, status: "skipped", detail: "Local model must be tested from the box; the cloud dashboard does not probe its own loopback address", latencyMs: null };
    } catch {
      return { id: "llm", name: "LLM (local Ollama)", env, status: "fail", detail: "Local Ollama configuration incomplete or invalid", latencyMs: null };
    }
  }
  if (p === "openai") {
    const env = has("LLM_PROVIDER", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL");
    const r = await probeGet(f, `${config.openaiBaseUrl}/models`, { Authorization: `Bearer ${config.openaiKey}` });
    return { id: "llm", name: "LLM (openai)", env, ...httpProbe(r, "key accepted (GET /models, free)"), latencyMs: r.ms };
  }
  if (p === "omniroute" && config.omniroute.baseUrl) {
    const env = has("LLM_PROVIDER", "OMNIROUTE_API_KEY", "OMNIROUTE_BASE_URL", "OMNIROUTE_MODEL");
    const r = await probeGet(f, `${config.omniroute.baseUrl}/models`, { Authorization: `Bearer ${config.omniroute.apiKey}` });
    return { id: "llm", name: "LLM (omniroute)", env, ...httpProbe(r, "key accepted (GET /models)"), latencyMs: r.ms };
  }
  const env = has("LLM_PROVIDER", "OPENAI_API_KEY", "OLLAMA_API_KEY", "OMNIROUTE_API_KEY");
  return { id: "llm", name: `LLM (${p})`, env, status: p === "mock" ? "warn" : "skipped", detail: p === "mock" ? "mock copywriter: set LLM_PROVIDER and its key" : "no free probe for this provider", latencyMs: null };
}

async function imageProbe(f: Fetch, which: string | undefined, label: string): Promise<Probe> {
  const id = label === "primary" ? "image" : "image-fallback";
  if (which === "cloudflare") {
    const env = has("IMAGE_PROVIDER", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_IMAGE_MODEL");
    const { accountId, apiToken } = config.cloudflare;
    if (!accountId || !apiToken) return { id, name: `Images (cloudflare, ${label})`, env, status: "fail", detail: "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN missing", latencyMs: null };
    // Free token check; generating an image would spend neurons.
    let r = await probeGet(f, "https://api.cloudflare.com/client/v4/user/tokens/verify", { Authorization: `Bearer ${apiToken}` });
    if (r.code === 401 || r.code === 403 || r.code === 400) r = await probeGet(f, `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/tokens/verify`, { Authorization: `Bearer ${apiToken}` });
    return { id, name: `Images (cloudflare, ${label})`, env, ...httpProbe(r, "token valid (tokens/verify, free)"), latencyMs: r.ms };
  }
  if (which === "openai") {
    const env = has("IMAGE_PROVIDER", "IMAGE_API_KEY", "OPENAI_API_KEY", "IMAGE_BASE_URL");
    const r = await probeGet(f, `${config.imageBaseUrl}/models`, { Authorization: `Bearer ${config.imageApiKey}` });
    return { id, name: `Images (openai, ${label})`, env, ...httpProbe(r, "key accepted (GET /models, free)"), latencyMs: r.ms };
  }
  if (which === "replicate") {
    const env = has("IMAGE_PROVIDER", "REPLICATE_API_TOKEN");
    const r = await probeGet(f, "https://api.replicate.com/v1/account", { Authorization: `Bearer ${config.replicateToken}` });
    return { id, name: `Images (replicate, ${label})`, env, ...httpProbe(r, "token accepted (GET /account)"), latencyMs: r.ms };
  }
  const env = has("IMAGE_PROVIDER", "IMAGE_FALLBACK_PROVIDER");
  if (!which || which === "mock") return { id, name: `Images (${label})`, env, status: label === "primary" ? "warn" : "skipped", detail: label === "primary" ? "mock artwork: set IMAGE_PROVIDER" : "no fallback configured", latencyMs: null };
  return { id, name: `Images (${which}, ${label})`, env, status: "skipped", detail: "no free probe for this provider", latencyMs: null };
}

function cronProbe(): Probe {
  const env = has("CRON_SECRET", "AUTH_SECRET", "DASHBOARD_PASSWORD", "OMNIGRAM_API_TOKEN");
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  return { id: "secrets", name: "App secrets", env, status: missing.length ? "fail" : "ok", detail: missing.length ? `missing: ${missing.join(", ")}` : "all set", latencyMs: null };
}

let cache: { at: number; value: DeepHealth } | null = null;
let inflight: Promise<DeepHealth> | null = null;
export const DEEP_HEALTH_TTL_MS = 60_000;
export function resetDeepHealthCache() { cache = null; inflight = null; }

/** Every integration with a free read call. Cached for 60 s and single-flighted so load tests never multiply external calls. */
export async function runDeepHealth(db: DB, opts: { fetch?: Fetch; fresh?: boolean; now?: number } = {}): Promise<DeepHealth> {
  const now = opts.now ?? Date.now();
  const ttl = opts.fresh ? 10_000 : DEEP_HEALTH_TTL_MS; // "fresh" still coalesces within 10 s
  if (cache && now - cache.at < ttl) return { ...cache.value, cached: true };
  if (inflight) return inflight;
  const f = opts.fetch ?? fetch;
  inflight = (async () => {
    const probes = await Promise.all([
      neonProbe(db), etsyProbe(db, f), printifyProbe(f), storageProbe(), llmProbe(f),
      imageProbe(f, config.imageProvider, "primary"), imageProbe(f, config.imageFallbackProvider, "fallback"),
    ]);
    probes.push(cronProbe());
    const overall: ProbeStatus = probes.some((p) => p.status === "fail") ? "fail" : probes.some((p) => p.status === "warn") ? "warn" : "ok";
    const value = { at: new Date(now).toISOString(), overall, probes, cached: false };
    cache = { at: now, value };
    return value;
  })().finally(() => { inflight = null; });
  return inflight;
}
