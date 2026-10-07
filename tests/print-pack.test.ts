import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Deliverable } from "@/db/schema";
import {
  checkDelivery,
  ETSY_FILE_LIMITS,
  inchesAt,
  needsPrintPack,
  packIsComplete,
  PRINT_DPI,
  PRINT_SPECS,
  printPackBlurb,
  validateForPublish,
  withPrintPackCopy,
} from "@/lib/deliverables";
import { DIGITAL_FILE_BLURB } from "@/lib/delivery";
import { AI_DISCLOSURE, DIGITAL_DELIVERY_NOTE } from "@/lib/disclosures";
import { renderPrintPack } from "@/lib/print-pack";

function fullPack(over: Partial<Deliverable> = {}): Deliverable[] {
  return PRINT_SPECS.map((s) => ({
    name: `print-${s.ratio}.jpg`,
    ratio: s.ratio,
    width: s.width,
    height: s.height,
    bytes: 6 * 1024 * 1024,
    url: `https://cdn.example/${s.ratio}.jpg`,
    stored: true,
    method: "resample" as const,
    upscale: 3.9,
    ...over,
  }));
}

const body = (blurb: string) => ["Minimal alpine print.", blurb, DIGITAL_DELIVERY_NOTE, AI_DISCLOSURE].join("\n\n");

describe("print specs", () => {
  it("covers the five ratios the shop sells, each at 300 DPI", () => {
    expect(PRINT_SPECS.map((s) => s.ratio)).toEqual(["2:3", "3:4", "4:5", "11x14", "ISO A"]);
    expect(PRINT_SPECS).toHaveLength(ETSY_FILE_LIMITS.maxFiles);
    const byRatio = Object.fromEntries(PRINT_SPECS.map((s) => [s.ratio, s]));
    expect(inchesAt(byRatio["11x14"].width)).toBeCloseTo(11, 5);
    expect(inchesAt(byRatio["11x14"].height)).toBeCloseTo(14, 5);
    // ISO A3 is 297 × 420 mm.
    expect(byRatio["ISO A"].width).toBe(Math.round((297 / 25.4) * PRINT_DPI));
    expect(byRatio["ISO A"].height).toBe(Math.round((420 / 25.4) * PRINT_DPI));
    expect(byRatio["2:3"].width / byRatio["2:3"].height).toBeCloseTo(2 / 3, 5);
    expect(byRatio["3:4"].width / byRatio["3:4"].height).toBeCloseTo(3 / 4, 5);
    expect(byRatio["4:5"].width / byRatio["4:5"].height).toBeCloseTo(4 / 5, 5);
  });

  it("only wall-art downloads get a print pack", () => {
    expect(needsPrintPack({ productType: "digital", niche: "alpine" })).toBe(true);
    expect(needsPrintPack({ productType: "digital", niche: "gothic" })).toBe(true);
    expect(needsPrintPack({ productType: "pod", niche: "alpine" })).toBe(false);
    expect(needsPrintPack({ productType: "digital", niche: "birthday" })).toBe(false);
    expect(needsPrintPack({ productType: "digital", niche: "stream" })).toBe(false);
  });
});

describe("delivery copy", () => {
  it("swaps the one-PNG blurb for the pack blurb, and only then", () => {
    const pack = fullPack();
    const next = withPrintPackCopy(body(DIGITAL_FILE_BLURB), pack);
    expect(next).not.toBeNull();
    expect(next).not.toContain("One PNG");
    expect(next).toContain(printPackBlurb(pack));
    expect(next).toContain(AI_DISCLOSURE);
    expect(withPrintPackCopy("Hand-edited text without the blurb", pack)).toBeNull();
  });

  it("lists every file with its pixel size", () => {
    const blurb = printPackBlurb(fullPack());
    expect(blurb).toContain("5 high-resolution JPG files (300 DPI)");
    expect(blurb).toContain("4000 × 6000 px");
    expect(blurb).toContain("3508 × 4961 px");
  });
});

describe("delivery check", () => {
  const digital = (description: string) => ({ productType: "digital" as const, description });

  it("passes the honest one-PNG listing", () => {
    expect(checkDelivery(digital(body(DIGITAL_FILE_BLURB)), [])).toEqual([]);
  });

  it("blocks print-size promises the files do not cover", () => {
    const desc = body(printPackBlurb(fullPack()));
    expect(checkDelivery(digital(desc), []).map((i) => i.code)).toContain("delivery_mismatch");
    const partial = fullPack().slice(0, 3);
    expect(checkDelivery(digital(desc), partial).map((i) => i.code)).toContain("delivery_mismatch");
    const small = fullPack({ width: 1024, height: 1536 });
    expect(checkDelivery(digital(desc), small).map((i) => i.code)).toContain("delivery_mismatch");
    expect(checkDelivery(digital(desc), fullPack()).filter((i) => i.severity === "error")).toEqual([]);
    expect(packIsComplete(fullPack())).toBe(true);
  });

  it("blocks editable-template and bundle promises outright", () => {
    expect(checkDelivery(digital("Fully editable in Corjl."), fullPack()).map((i) => i.code)).toContain("delivery_editable");
    expect(checkDelivery(digital("Delivered as a ZIP file."), fullPack()).map((i) => i.code)).toContain("delivery_bundle");
    expect(checkDelivery(digital("Unzip and print."), []).map((i) => i.code)).not.toContain("delivery_bundle");
  });

  it("enforces Etsy's file count and size limits", () => {
    const six = [...fullPack(), { ...fullPack()[0], name: "extra.jpg" }];
    expect(checkDelivery(digital("x"), six).map((i) => i.code)).toContain("too_many_files");
    const big = fullPack({ bytes: ETSY_FILE_LIMITS.maxBytes + 1 });
    expect(checkDelivery(digital("x"), big).map((i) => i.code)).toContain("file_too_large");
  });

  it("warns on heavy enlargement and on files that are not stored", () => {
    const issues = checkDelivery(digital("x"), fullPack({ upscale: 6.2, stored: false }));
    expect(issues.find((i) => i.code === "upscale_high")?.severity).toBe("warning");
    expect(issues.find((i) => i.code === "files_not_stored")?.severity).toBe("warning");
  });

  it("ignores POD listings", () => {
    expect(checkDelivery({ productType: "pod", description: "300 DPI 2:3" }, [])).toEqual([]);
  });

  it("validateForPublish merges listing and delivery issues", () => {
    const base = {
      title: "Minimal Swiss Alps Wall Art Printable",
      tags: Array.from({ length: 13 }, (_, i) => `alpine tag ${i}`),
      priceChf: 8,
      productType: "digital" as const,
      description: body(printPackBlurb(fullPack())),
      deliverables: [] as Deliverable[],
    };
    const r = validateForPublish(base);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("delivery_mismatch");
    expect(validateForPublish({ ...base, deliverables: fullPack() }).valid).toBe(true);
  });
});

describe("renderPrintPack", () => {
  it("renders five JPGs at the spec sizes with 300 DPI metadata", async () => {
    const src = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: { r: 120, g: 150, b: 170 } } })
      .png()
      .toBuffer();
    const files = await renderPrintPack(src, { scale: 0.1 });
    expect(files).toHaveLength(5);
    for (const f of files) {
      const meta = await sharp(f.bytes).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(Math.round(f.spec.width * 0.1));
      expect(meta.height).toBe(Math.round(f.spec.height * 0.1));
      expect(meta.density).toBe(PRINT_DPI);
      expect(f.name).toMatch(/^print-[a-z0-9-]+-\d+x\d+\.jpg$/);
      expect(f.bytes.length).toBeLessThanOrEqual(ETSY_FILE_LIMITS.maxBytes);
    }
    // Full-size enlargement factor from a 1024 × 1536 source: 4:5 needs 6000 px tall from a 2:3 crop.
    const full = PRINT_SPECS.map((s) => Math.max(s.width / 1024, s.height / 1536));
    expect(Math.max(...full)).toBeGreaterThan(4);
  });

  it("lowers JPEG quality to fit the byte limit, and fails loudly if it cannot", async () => {
    const noisy = Buffer.alloc(300 * 450 * 3);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 2654435761) >>> 24;
    const src = await sharp(noisy, { raw: { width: 300, height: 450, channels: 3 } }).png().toBuffer();
    const loose = await renderPrintPack(src, { scale: 0.05 });
    const tight = await renderPrintPack(src, { scale: 0.05, maxBytes: Math.max(...loose.map((f) => f.bytes.length)) - 1 });
    expect(Math.min(...tight.map((f) => f.quality))).toBeLessThan(Math.min(...loose.map((f) => f.quality)));
    await expect(renderPrintPack(src, { scale: 0.05, maxBytes: 200 })).rejects.toThrow(/byte limit/);
  });
});
