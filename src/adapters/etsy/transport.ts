import { createHash } from "node:crypto";

export const ETSY_API_ORIGIN = "https://openapi.etsy.com";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RESEARCH_RESERVE = 20;

type Quota = { blockedUntil: number; dailyRemaining?: number; dailyReset: number };
const quotas = new Map<string, Quota>();

export class EtsyRequestError extends Error {
  constructor(readonly status: number, readonly retryable: boolean) {
    super(`Etsy API HTTP ${status}`);
  }
}

/** Never forward authentication to arbitrary URLs, redirects, or webhook-provided hosts. */
export function officialEtsyUrl(path: string | URL): URL {
  const url = new URL(path, ETSY_API_ORIGIN);
  if (url.origin !== ETSY_API_ORIGIN || url.username || url.password || url.hash ||
      !url.pathname.startsWith("/v3/application/") || url.pathname.includes("%")) {
    throw new Error("Etsy requests require the official Open API application origin");
  }
  return url;
}

function seconds(value: string | null) {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function retryDelay(headers: Headers, now: number) {
  const raw = headers.get("retry-after");
  const numeric = seconds(raw);
  if (numeric != null) return numeric * 1000;
  const date = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : 1000;
}

export type EtsyRequestOptions = {
  apiKey: string;
  headers?: () => Promise<HeadersInit>;
  priority?: "operations" | "research";
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onResponse?: (fact: { method: string; status: number; durationMs: number; attempt: number }) => void;
};

/** Shared transport. Only reads retry; a timed-out write must be reconciled by the operator. */
export async function etsyRequest<T>(path: string | URL, init: RequestInit, opts: EtsyRequestOptions): Promise<T> {
  const url = officialEtsyUrl(path);
  if (!opts.apiKey) throw new Error("Etsy API credentials missing");
  const key = createHash("sha256").update(opts.apiKey.split(":")[0]).digest("hex");
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const quota = quotas.get(key) ?? { blockedUntil: 0, dailyReset: 0 };
  quotas.set(key, quota);
  const method = (init.method ?? "GET").toUpperCase();
  const canRetry = method === "GET" || method === "HEAD";
  const attempts = canRetry ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const time = now();
    if (time >= quota.dailyReset) quota.dailyRemaining = undefined;
    if (opts.priority === "research" && quota.dailyRemaining != null && quota.dailyRemaining <= RESEARCH_RESERVE) {
      throw new Error("Etsy research deferred to reserve API quota for shop operations");
    }
    const wait = quota.blockedUntil - time;
    if (wait > 5000) throw new Error("Etsy quota cooldown active; retry on a later run");
    if (wait > 0) await sleep(wait);
    const headers = new Headers(await opts.headers?.());
    headers.set("x-api-key", opts.apiKey);
    new Headers(init.headers).forEach((value, name) => {
      if (["authorization", "x-api-key"].includes(name.toLowerCase())) {
        throw new Error("Etsy authentication headers cannot be overridden");
      }
      headers.set(name, value);
    });
    const started = now();
    let response: Response;
    try {
      response = await (opts.fetchImpl ?? fetch)(url, {
        ...init, headers, redirect: "error", cache: "no-store",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // A transport failure on a write may mean Etsy accepted it. Never repeat it here.
      throw new Error(`Etsy ${method} request failed; ${canRetry ? "retry on a later run" : "reconcile the provider result before retrying"}`);
    }
    opts.onResponse?.({ method, status: response.status, durationMs: now() - started, attempt: attempt + 1 });
    const daily = seconds(response.headers.get("x-remaining-today"));
    if (daily != null) {
      quota.dailyRemaining = daily;
      quota.dailyReset = time + 24 * 60 * 60 * 1000;
    }
    if (seconds(response.headers.get("x-remaining-this-second")) === 0) quota.blockedUntil = now() + 1000;
    const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) quota.blockedUntil = now() + retryDelay(response.headers, now());
      if (retryable && canRetry && attempt + 1 < attempts) {
        if (response.status !== 429) await sleep(250 * 2 ** attempt);
        continue;
      }
      throw new EtsyRequestError(response.status, retryable);
    }
    if (response.status === 204 || method === "HEAD") return undefined as T;
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("Etsy response exceeds the size limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Etsy response body missing");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("Etsy response exceeds the size limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new Error("Etsy returned invalid JSON");
    }
  }
  throw new Error("Etsy request retry limit exceeded");
}
