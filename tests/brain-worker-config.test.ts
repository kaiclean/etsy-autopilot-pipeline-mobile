import { afterEach, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { GET } from "@/app/api/brain/worker-config/route";
import { createSessionToken } from "@/lib/auth";
import { config } from "@/lib/config";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const request = new Request("https://dashboard.example/api/brain/worker-config");
const cookie = (value?: string) => vi.mocked(cookies).mockResolvedValue({
  get: () => value === undefined ? undefined : { value },
} as Awaited<ReturnType<typeof cookies>>);

afterEach(() => vi.unstubAllEnvs());

it("requires a dashboard session before downloading worker credentials", async () => {
  vi.stubEnv("BRAIN_SYNC_TOKEN", "worker-fixture");
  cookie();
  const res = await GET(request);
  expect(res.status).toBe(401);
  expect(await res.text()).not.toContain("worker-fixture");
});

it("downloads a private Linux-ready env file using APP_URL and the two scheduled checks", async () => {
  cookie(await createSessionToken(config.authSecret!));
  vi.stubEnv("APP_URL", "https://production.example");
  vi.stubEnv("BRAIN_SYNC_TOKEN", "worker-fixture");
  const res = await GET(request);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("content-disposition")).toContain('filename=".env.brain"');
  const text = await res.text();
  expect(text).toContain("APP_URL=https://production.example\n");
  expect(text).toContain("BRAIN_SYNC_TOKEN=worker-fixture\n");
  expect(text).toContain("BRAIN_RUN_TIMES=07:20,19:20\n");
  expect(text).toContain("INSTAGRAM_COOKIES_FROM=\n");
  expect(text).not.toMatch(/BRAIN_BASE_URL|BRAIN_DAILY_HOUR|BRAIN_DAILY_MINUTE/);
});
