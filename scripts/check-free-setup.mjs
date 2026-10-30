#!/usr/bin/env node
// Presence and configuration checks only. Never print secret values or URLs.
import { statSync } from "node:fs";

if (process.argv.includes("--help")) {
  console.log("Usage: node --env-file=.env.box scripts/check-free-setup.mjs --role=box|web");
  console.log("Checks configuration locally; makes no network requests and prints no credential values.");
  process.exit(0);
}
const roleArg = process.argv.find(arg => arg.startsWith("--role="));
const role = roleArg?.slice(7) ?? "box";
if (!["box", "web"].includes(role)) {
  console.error("FAIL --role must be box or web");
  process.exit(1);
}
const env = key => process.env[key]?.trim() ?? "";
let failures = 0;
function check(ok, label) {
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) failures++;
}
function warn(label) { console.log(`WARN ${label}`); }
const present = key => Boolean(env(key)) && !/YOUR-|REPLACE|CHANGEME/i.test(env(key));
const requireKeys = keys => { for (const key of keys) check(present(key), `${key} configured`); };

const [major, minor] = process.versions.node.split(".").map(Number);
check(major > 22 || (major === 22 && minor >= 12), "Node.js 22.12+ installed");
check(env("AUTOPILOT_EXECUTION") === "box", "AUTOPILOT_EXECUTION=box");
check(env("FREE_ONLY_MODE") === "true", "FREE_ONLY_MODE=true");
check(["dry-run", "live"].includes(env("PUBLISH_MODE") || "dry-run"), "PUBLISH_MODE is valid");
if (env("PUBLISH_MODE") === "live") warn("Live host publishing is configured; app approval gates still apply and Etsy fees can occur.");
requireKeys(["DATABASE_URL", "APP_URL", "DASHBOARD_PASSWORD", "AUTH_SECRET", "CRON_SECRET"]);
let appUrl;
try { appUrl = new URL(env("APP_URL")); } catch { /* checked below */ }
check(Boolean(appUrl && appUrl.protocol === "https:" && appUrl.pathname === "/" && !appUrl.username && !appUrl.password && !appUrl.search && !appUrl.hash), "APP_URL is a stable HTTPS application origin without credentials");
let dbUrl;
try { dbUrl = new URL(env("DATABASE_URL")); } catch { /* checked below */ }
check(Boolean(dbUrl && ["postgres:", "postgresql:"].includes(dbUrl.protocol)), "DATABASE_URL uses Postgres");
check(env("AUTH_SECRET").length >= 32, "AUTH_SECRET has at least 32 characters");
check(env("CRON_SECRET").length >= 32, "CRON_SECRET has at least 32 characters");
requireKeys(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION", "S3_BUCKET"]);
check(env("SUPABASE_STORAGE_PLAN") === "free", "Supabase Storage Free plan explicitly declared");
let storageUrl;
try { storageUrl = new URL(env("AWS_ENDPOINT_URL_S3")); } catch { /* checked below */ }
check(Boolean(storageUrl && storageUrl.protocol === "https:" && /^[a-z0-9-]+(?:\.storage)?\.supabase\.co$/.test(storageUrl.hostname) && storageUrl.pathname.replace(/\/$/, "") === "/storage/v1/s3" && !storageUrl.username && !storageUrl.password && !storageUrl.search && !storageUrl.hash), "S3 endpoint is Supabase HTTPS storage without URL credentials");
check(env("S3_URL_MODE") !== "signed", "Permanent stored URLs selected (not expiring stored signed URLs)");
if (!env("S3_PUBLIC_BASE_URL")) warn("Private media passes through the dashboard; count that traffic against hosting bandwidth.");
if (env("S3_PUBLIC_BASE_URL")) warn("Public storage URLs expose every object under that base; buyer originals should remain private.");
check(env("UPSCALER_PULL") === "on", "UPSCALER_PULL=on");
check(env("UPSCALER_SECRET").length >= 16, "UPSCALER_SECRET has at least 16 characters");
check(env("ETSY_EVENTS_ENABLED") !== "true", "Continuous Etsy queue polling disabled for initial Free setup");
check(env("ETSY_WEBHOOK_ENABLED") !== "true", "Unverified public Etsy webhook disabled");
if (env("DEMO_MODE") !== "true") {
  requireKeys(["ETSY_SHOP_ID", "ETSY_API_KEY", "ETSY_SHARED_SECRET"]);
  warn("Verify the stored shop OAuth connection and callback after deployment; this checker does not read production data.");
}
if (role === "box") {
  check(Number(env("BOX_IDLE_POLL_MS") || 900000) >= 900000, "Idle polling interval is at least 15 minutes");
  check(env("IMAGE_PROVIDER") === "cloudflare", "Image provider is Cloudflare Free-compatible");
  check(!env("IMAGE_FALLBACK_PROVIDER") || env("IMAGE_FALLBACK_PROVIDER") === "cloudflare", "No paid image fallback configured");
  check(env("CLOUDFLARE_WORKERS_PLAN") === "free", "Workers Free plan explicitly declared");
  requireKeys(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  check(env("LLM_PROVIDER") === "ollama-local", "Text and vision use local Ollama");
  requireKeys(["OLLAMA_LOCAL_MODEL"]);
  check(!/cloud|\s|:\/\//i.test(env("OLLAMA_LOCAL_MODEL")), "Local model name does not forward to a cloud model");
  check(!/cloud|\s|:\/\//i.test(env("OLLAMA_LOCAL_VISION_MODEL")), "Local vision model does not forward to a cloud model");
  let ollamaUrl;
  try { ollamaUrl = new URL(env("OLLAMA_LOCAL_BASE_URL") || "http://127.0.0.1:11434/v1"); } catch { /* checked below */ }
  check(Boolean(ollamaUrl && ["localhost", "127.0.0.1", "[::1]"].includes(ollamaUrl.hostname) && !ollamaUrl.username && !ollamaUrl.password), "Ollama endpoint is local loopback without URL credentials");
  if (!env("OLLAMA_LOCAL_VISION_MODEL")) warn("OLLAMA_LOCAL_VISION_MODEL is unset; the selected local model must support image assessment.");
  try { check(statSync("node_modules/tsx").isDirectory(), "Worker TypeScript runtime installed"); }
  catch { check(false, "Worker TypeScript runtime installed (run npm ci on the box)"); }
}
warn("Free quotas and account plans require verification in each provider dashboard; configuration cannot prove billing eligibility.");
console.log(failures ? `Configuration incomplete: ${failures} check(s) failed.` : `Local ${role} configuration checks passed. No live requests were made.`);
process.exitCode = failures ? 1 : 0;
