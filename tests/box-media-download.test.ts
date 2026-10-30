import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/media/[...key]/route";
import { MEDIA_DOWNLOAD_TTL_SECONDS, storedUrlForKey } from "@/lib/object-storage";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => { throw new Error("Object body must not be read by the web function"); }),
  sign: vi.fn(async () => "https://project.storage.supabase.co/artwork/large.png?X-Amz-Signature=temporary"),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mocks.send; },
  GetObjectCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.sign }));

const objectKey = "designs/2026-10-30/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
const params = (key = objectKey) => ({ params: Promise.resolve({ key: key.split("/") }) });

function setup() {
  vi.stubEnv("AUTOPILOT_EXECUTION", "box");
  vi.stubEnv("AUTOPILOT_BOX_WORKER", "0");
  vi.stubEnv("FREE_ONLY_MODE", "true");
  vi.stubEnv("SUPABASE_STORAGE_PLAN", "free");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("AWS_ENDPOINT_URL_S3", "https://project.storage.supabase.co/storage/v1/s3");
  vi.stubEnv("S3_BUCKET", "artwork");
  vi.stubEnv("S3_PUBLIC_BASE_URL", "");
  vi.stubEnv("S3_URL_MODE", "stable");
  vi.stubEnv("APP_URL", "https://autopilot.netlify.app");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("private large artwork downloads on the box dashboard", () => {
  it("redirects straight to a short-lived private S3 download without fetching or buffering bytes", async () => {
    setup();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const result = await GET(new Request(`https://autopilot.netlify.app/api/media/${objectKey}`), params());
    expect(result.status).toBe(307);
    expect(result.headers.get("location")).toContain("X-Amz-Signature=temporary");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await result.arrayBuffer()).byteLength).toBe(0);
    expect(mocks.sign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ input: { Bucket: "artwork", Key: objectKey } }), { expiresIn: MEDIA_DOWNLOAD_TTL_SECONDS });
    expect(MEDIA_DOWNLOAD_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // The canonical URL saved by image storage stays stable; signed URLs are response-only.
    expect(await storedUrlForKey(objectKey)).toBe(`https://autopilot.netlify.app/api/media/${objectKey}`);
  });

  it.each(["../../private.txt", "designs/2026-10-30/not-an-object-id.png", "designs/2026-10-30/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png/extra"])("does not sign an invalid object key %s", async (key) => {
    setup();
    const result = await GET(new Request("https://autopilot.netlify.app/api/media/invalid"), params(key));
    expect(result.status).toBe(404);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("checks the free storage allowlist before signing and returns a generic failure", async () => {
    setup();
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "https://s3.amazonaws.com");
    const result = await GET(new Request("https://autopilot.netlify.app/api/media/file"), params());
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: "storage unavailable" });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
