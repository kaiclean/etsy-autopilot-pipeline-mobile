import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { resetDeepHealthCache, runDeepHealth } from "@/lib/deep-health";

const SECRET = "sk-test-do-not-leak-123456";
afterEach(() => { vi.unstubAllEnvs(); resetDeepHealthCache(); });

describe("deep health", () => {
  it("reports names only, maps status codes, caches and single-flights", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", SECRET);
    vi.stubEnv("IMAGE_PROVIDER", "cloudflare"); vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc"); vi.stubEnv("CLOUDFLARE_API_TOKEN", SECRET);
    vi.stubEnv("PRINTIFY_API_TOKEN", SECRET); vi.stubEnv("PRINTIFY_SHOP_ID", "1");
    const calls: string[] = [];
    const f = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      const code = String(url).includes("printify") ? 401 : String(url).includes("cloudflare") ? 200 : 200;
      return new Response(`{"echo":"${SECRET}"}`, { status: code });
    }) as unknown as typeof fetch;
    const client = new PGlite("memory://");
    const db = drizzle(client, { schema }) as DB;
    try {
      const [a, b] = await Promise.all([runDeepHealth(db, { fetch: f }), runDeepHealth(db, { fetch: f })]);
      expect(a).toBe(b);
      const n = calls.length;
      const c = await runDeepHealth(db, { fetch: f });
      expect(c.cached).toBe(true);
      expect(calls.length).toBe(n);
      const json = JSON.stringify(a);
      expect(json).not.toContain(SECRET);
      const byId = Object.fromEntries(a.probes.map((p) => [p.id, p]));
      expect(byId.printify.status).toBe("fail");
      expect(byId.llm.status).toBe("ok");
      expect(byId.image.status).toBe("ok");
      expect(byId.llm.env.OPENAI_API_KEY).toBe(true);
      expect(byId.neon.status).toBe("ok");
      expect(a.overall).toBe("fail");
      expect(calls.every((u) => !u.includes("generat") && !u.includes("/ai/run"))).toBe(true);
    } finally { await client.close(); }
  });
});
