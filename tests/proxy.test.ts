import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { proxy } from "@/proxy";

const SECRET = "proxy-test-secret";

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

describe("auth gate (src/proxy.ts)", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("redirects an unauthenticated page request to /login and keeps the target", async () => {
    const res = await proxy(request("/queue"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/queue");
  });

  it("answers an unauthenticated API request with 401 instead of a redirect", async () => {
    for (const path of ["/api/pipeline/research/run", "/api/settings", "/api/listings/1"]) {
      const res = await proxy(request(path));
      expect(res.status, path).toBe(401);
    }
  });

  it("rejects a session token signed with another secret", async () => {
    const forged = await createSessionToken("another-secret");
    const res = await proxy(request("/api/settings", forged));
    expect(res.status).toBe(401);
  });

  it("lets a valid session through", async () => {
    const token = await createSessionToken(SECRET);
    const res = await proxy(request("/api/settings", token));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("only exempts the documented public paths, which authenticate inside the route", async () => {
    const open = [
      "/login", "/offline", "/sw.js", "/manifest.webmanifest", "/icons/a.png",
      "/api/cron/daily", "/api/media/x", "/api/webhooks/printify", "/api/webhooks/etsy",
      "/api/brain/decisions", "/api/brain/status", "/api/brain/ingest", "/api/health/deep",
    ];
    for (const path of open) {
      const res = await proxy(request(path));
      expect(res.status, path).toBe(200);
    }
    // Look-alikes of exempt prefixes must stay behind the gate.
    for (const path of ["/api/cronx", "/api/webhooks/other", "/api/brain/ideas", "/api/health"]) {
      const res = await proxy(request(path));
      expect(res.status, path).toBe(401);
    }
  });
});
