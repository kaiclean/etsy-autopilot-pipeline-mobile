import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.fn(async () => ({ url: "/api/media/x.png", key: "x.png" }));
const apply = vi.fn(async () => []);
vi.mock("@/db", () => ({ getDb: async () => ({ select: () => ({ from: () => ({ where: async () => [] }) }), update: () => ({ set: () => ({ where: async () => [] }) }) }) }));
vi.mock("@/lib/object-storage", () => ({ MAX_ARTWORK_BYTES: 80e6, uploadImageBytes: upload }));
vi.mock("@/db/upscale-designs", () => ({ upscaleDesigns: apply }));
vi.mock("@/lib/upscale-jobs", () => ({
  authorizedUpscaleJob: () => true,
  requiredUpscaleTarget: async () => ({ minW: 3508, minH: 4961, targetW: 3508, targetH: 4961 }),
  attachA3Crop: async () => null,
  clearRedesignFlag: async () => false,
}));

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#888" } }).png().toBuffer();
const post = async (body: Buffer) => {
  const { POST } = await import("@/app/api/cron/upscale-jobs/complete/route");
  return POST(new Request("http://x/api/cron/upscale-jobs/complete?designId=130&method=realesrgan&srcW=1024&srcH=1024", { method: "POST", body: new Uint8Array(body) }));
};

describe("upscale complete size check", () => {
  beforeEach(() => { upload.mockClear(); apply.mockClear(); });
  it("rejects an A3 result below 3508×4961 with 422 and stores nothing", async () => {
    const res = await post(await png(3510, 4950));
    expect(res.status).toBe(422);
    expect(upload).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  it("accepts an exact A3 result", async () => {
    const res = await post(await png(3508, 4961));
    expect(res.status).toBe(200);
    expect(apply).toHaveBeenCalledOnce();
  });
});
