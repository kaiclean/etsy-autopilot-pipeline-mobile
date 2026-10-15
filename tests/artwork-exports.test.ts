import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeArtwork, inspectArtwork, MAX_ARTWORK_EDGE } from "@/lib/artwork-codec";
import { generateArtworkPack, storeArtworkPack } from "@/lib/artwork-pack";
import { modelReferences, workflowSha256 } from "@/lib/artwork-provenance";
import { loadArtworkBytes, loadArtworkImage, readCappedArtworkBody, renderArtworkPreviewBytes } from "@/lib/artwork-source";
import { buildFileManifest, inspectArtworkFile, inspectPng, manifestIsComplete } from "@/lib/file-manifest";
import { decodePng, podMockupPng, rgbPng } from "@/lib/png";
import { preparePrintFile } from "@/pipeline/artwork";
import { listingImageForProduct } from "@/pipeline/mockup";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("bounded artwork decoding", () => {
  it.each(["png", "jpeg", "webp"] as const)("decodes %s masters, measures actual pixels and makes smaller RGB previews", async (format) => {
    const original = await sharp(rgbPng(200, 300, [80, 120, 180])).toFormat(format).toBuffer();
    const saved = Buffer.from(original);
    const image = await loadArtworkImage(`data:image/${format};base64,${original.toString("base64")}`);
    expect(image).toMatchObject({ width: 200, height: 300 });
    expect(image?.rgb.length).toBe(200 * 300 * 3);
    const preview = await renderArtworkPreviewBytes(original);
    expect(decodePng(preview!)?.height).toBe(180);
    expect(original.equals(saved)).toBe(true);
    expect(await preparePrintFile(`data:image/${format};base64,${original.toString("base64")}`))
      .toMatchObject({ width: 200, height: 300 });
  });

  it("applies EXIF orientation, converts CMYK to RGB and flattens transparency onto white", async () => {
    const jpeg = await sharp(rgbPng(20, 30, [80, 120, 180])).toColourspace("cmyk")
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(await decodeArtwork(jpeg)).toMatchObject({ width: 30, height: 20 });
    expect((await decodeArtwork(jpeg))?.rgb.length).toBe(30 * 20 * 3);
    const transparent = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect([...(await decodeArtwork(transparent))!.rgb]).toEqual(new Array(12).fill(255));
  });

  it("rejects malformed, truncated, animated/unsupported and oversized dimensions without throwing", async () => {
    for (const bytes of [Buffer.from("not an image"), rgbPng(2, 2, [1, 2, 3]).subarray(0, 40),
      Buffer.from('<svg width="1" height="1"></svg>')]) {
      expect(await decodeArtwork(bytes)).toBeNull();
    }
    const oversized = rgbPng(MAX_ARTWORK_EDGE + 1, 1, [1, 2, 3]);
    expect(await inspectArtwork(oversized)).toBeNull();
    expect(await decodeArtwork(oversized)).toBeNull();
    expect(await decodeArtwork(rgbPng(2, 2, [1, 2, 3]), -1)).toBeNull();
    expect(await loadArtworkBytes("data:image/png,%ZZ")).toBeNull();
  });

  it("does not upscale a small preview and bounds large previews without shrinking the original", async () => {
    const source = rgbPng(1600, 2400, [20, 80, 120]);
    expect(await decodeArtwork(source, 4000)).toMatchObject({ width: 1600, height: 2400 });
    expect(decodePng((await renderArtworkPreviewBytes(source))!)?.height).toBe(1200);
    expect(await inspectArtwork(source)).toMatchObject({ width: 1600, height: 2400 });
  });

  it("rejects private URLs and cancels capped streams/oversized declarations before consuming them", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await loadArtworkBytes("https://169.254.169.254/private", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(8)); },
      cancel() { cancelled = true; },
    });
    expect(await readCappedArtworkBody(new Response(body), 20)).toBeNull();
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThan(6);
    const arrayBuffer = vi.fn();
    const declared = { headers: new Headers({ "content-length": "21" }), arrayBuffer } as unknown as Response;
    expect(await readCappedArtworkBody(declared, 20)).toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("fits mockup art without cropping edge content", () => {
    const width = 100;
    const height = 300;
    const rgb = new Uint8Array(width * height * 3).fill(20);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < width; x++) {
        rgb[(y * width + x) * 3] = 255;
        rgb[((height - 1 - y) * width + x) * 3 + 1] = 255;
      }
    }
    const image = decodePng(podMockupPng("mug", "alpine", { width, height, rgb }))!;
    expect([...image.rgb].some((value) => value === 255)).toBe(true);
    // Top and bottom of the art survive inside the 110x100 mug print window.
    const top = (300 * image.width + 226) * 3;
    const bottom = (399 * image.width + 226) * 3;
    expect(image.rgb[top]).toBe(255);
    expect(image.rgb[bottom + 1]).toBe(255);
  });
});

describe("verified format-aware manifests", () => {
  it.each(["png", "jpeg", "webp"] as const)("hashes original %s delivery bytes and distinguishes a real preview", async (format) => {
    const original = await sharp(rgbPng(40, 60, [80, 120, 180])).toFormat(format).toBuffer();
    const delivery = `data:image/${format};base64,${original.toString("base64")}`;
    const preview = (await renderArtworkPreviewBytes(original))!;
    const manifest = await buildFileManifest(delivery, `data:image/png;base64,${preview.toString("base64")}`);
    expect(manifest?.delivery).toMatchObject({
      width: 40, height: 60, bytes: original.length,
      sha256: createHash("sha256").update(original).digest("hex"), format,
    });
    expect(manifestIsComplete(manifest)).toBe(true);
    expect(manifest?.preview?.sha256).not.toBe(manifest?.delivery.sha256);
    expect(await buildFileManifest(delivery, delivery)).toBeNull();
  });

  it("rejects a PNG header without pixels and honors limits on inline data", async () => {
    const png = rgbPng(2, 2, [1, 2, 3]);
    expect(inspectPng(png.subarray(0, 24), "fake.png")).toBeNull();
    expect(inspectPng(png.subarray(0, -12), "missing-end.png")).toBeNull();
    const corrupt = Buffer.from(png);
    corrupt[corrupt.length - 1] ^= 1;
    expect(inspectPng(corrupt, "invalid-crc.png")).toBeNull();
    expect(await inspectArtworkFile(png.subarray(0, 40), "fake.png")).toBeNull();
    expect(await buildFileManifest(`data:image/png;base64,${png.toString("base64")}`, "", { maxBytes: 10 })).toBeNull();
    expect(manifestIsComplete({ delivery: { filename: "x", width: 1.5, height: 1, bytes: 1, sha256: "a".repeat(64) } })).toBe(false);
  });

  it("records the actual preview rendered from stored artwork instead of a synthetic fallback", async () => {
    const source = rgbPng(40, 60, [80, 120, 180]);
    const url = "/api/media/designs/2026-10-10/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
    const manifest = await buildFileManifest(url, `/api/preview?src=${encodeURIComponent(url)}`, {
      readObject: async () => ({ bytes: source }),
    });
    const preview = (await renderArtworkPreviewBytes(source))!;
    expect(manifest?.preview?.sha256).toBe(createHash("sha256").update(preview).digest("hex"));
    expect(manifest?.preview).toMatchObject({ width: 24, height: 36 });
  });
});

describe("explicit digital exports", () => {
  const source = rgbPng(40, 60, [20, 80, 120]);
  const specs = [{ filename: "art-20x30.png", width: 20, height: 30, format: "png" as const }];

  it("produces requested RGB files without upscaling or cropping and verifies stored bytes", async () => {
    const exports = await generateArtworkPack(source, specs);
    expect(await decodeArtwork(exports[0].bytes)).toMatchObject({ width: 20, height: 30 });
    let stored: Buffer | null = null;
    const manifest = await storeArtworkPack(source, specs, {
      upload: async (bytes) => { stored = bytes; return { url: "https://storage.example/art.png" }; },
      read: async () => stored,
    });
    expect(manifest.files[0]).toMatchObject({ width: 20, height: 30, url: "https://storage.example/art.png" });
    expect(manifest.files[0].sha256).toBe(exports[0].file.sha256);
  });

  it("refuses oversized, distorted, duplicate, traversal and empty export plans", async () => {
    await expect(generateArtworkPack(source, [{ ...specs[0], width: 80, height: 120 }])).rejects.toThrow(/upscale/);
    await expect(generateArtworkPack(source, [{ ...specs[0], width: 20, height: 20 }])).rejects.toThrow(/crop/);
    await expect(generateArtworkPack(source, [specs[0], specs[0]])).rejects.toThrow(/duplicate/);
    await expect(generateArtworkPack(source, [{ ...specs[0], filename: "../art.png" }])).rejects.toThrow(/filename/);
    await expect(generateArtworkPack(source, [])).rejects.toThrow(/1 to 4/);
  });

  it("never returns a deliverable manifest for a failed upload, signed URL or mismatched read-back", async () => {
    await expect(storeArtworkPack(source, specs, { upload: async () => null, read: async () => source })).rejects.toThrow(/upload/);
    await expect(storeArtworkPack(source, specs, {
      upload: async () => ({ url: "https://storage.example/art.png?X-Amz-Signature=abc" }), read: async () => source,
    })).rejects.toThrow(/permanent/);
    await expect(storeArtworkPack(source, specs, {
      upload: async () => ({ url: "https://storage.example/art.png" }), read: async () => source,
    })).rejects.toThrow(/hash mismatch/);
  });
});

describe("versioned workflow fingerprints", () => {
  it("is deterministic across object-key ordering and changes for actual workflow inputs", () => {
    expect(workflowSha256({ a: 1, b: { d: 2, c: 3 } })).toBe(workflowSha256({ b: { c: 3, d: 2 }, a: 1 }));
    expect(workflowSha256({ seed: 1 })).not.toBe(workflowSha256({ seed: 2 }));
    expect(modelReferences({ inputs: { ckpt_name: "model.safetensors", prompt: "private", model_name: "https://private/key" } }))
      .toEqual(["model.safetensors"]);
  });

  describe("truthful gallery views", () => {
    it("returns actual preview/mockup URLs and measured source dimensions, never imaginary pack files", async () => {
      const result = await listingImageForProduct({
        productType: "pod", preset: "mug", niche: "alpine", artworkUrl: "https://cdn.example/art.jpg",
        sourceDimensions: { width: 2000, height: 3000 },
      });
      expect(result.gallery?.map((view) => view.role)).toEqual(["product-mockup", "artwork-preview"]);
      expect(result.gallery?.[0].label).toContain("not a supplier");
      expect(result.gallery?.every((view) => view.sourceDimensions?.height === 3000)).toBe(true);
      expect(result.gallery?.[1].url).toContain("/api/preview?");
      expect(JSON.stringify(result.gallery)).not.toMatch(/bundle|pack|download files/);
    });

    it("does not invent artwork views for placeholders or dimensions for unmeasured sources", async () => {
      const result = await listingImageForProduct({
        productType: "pod", preset: "mug", niche: "alpine", artworkUrl: "/api/placeholder/1",
      });
      expect(result.gallery).toHaveLength(1);
      expect(result.gallery?.[0].sourceDimensions).toBeUndefined();
    });
  });
});
