import { describe, expect, it } from "vitest";
import { assignPrintFile } from "@/lib/print-file-assign";

const master = { width: 4096, height: 5120 };
const a3 = { width: 3620, height: 5120 };

describe("assignPrintFile (ratio rule)", () => {
  it("poster A3 (bp 443 / 3510×4950) gets the A3 crop", () => {
    expect(assignPrintFile("posterA3", { width: 3510, height: 4950 }, master, a3).file).toBe("a3");
  });
  it("canvas 4:5 area gets the 4:5 master", () => {
    expect(assignPrintFile("canvas", { width: 3600, height: 4500 }, master, a3).file).toBe("master");
  });
  it("canvas holds when the closest file does not cover the area", () => {
    expect(assignPrintFile("canvas", { width: 6000, height: 7500 }, master, a3).file).toBe("none");
  });
  it("tee (bp 6 / 4016×5057, 0.7% off 4:5) gets the master", () => {
    expect(assignPrintFile("tshirt", { width: 4016, height: 5057 }, master, a3).file).toBe("master");
  });
  it("sweatshirt (bp 49 / 3909×4431, ~10% off 4:5) gets the master padded to fit", () => {
    const choice = assignPrintFile("sweatshirt", { width: 3909, height: 4431 }, master, a3);
    expect(choice).toMatchObject({ file: "padded", fit: { width: 3544, height: 4431 } });
  });
  it("apparel holds when the fitted art is below the minimum", () => {
    expect(assignPrintFile("sweatshirt", { width: 2800, height: 3000 }, master, a3).file).toBe("none");
  });
  it("non-apparel more than 3% off both holds", () => {
    expect(assignPrintFile("canvas", { width: 4000, height: 4000 }, master, a3).file).toBe("none");
  });
  it("mug is held regardless of area", () => {
    expect(assignPrintFile("mug", { width: 2700, height: 1120 }, master, a3).file).toBe("none");
  });
});

describe("fitted apparel art", () => {
  it("meets the print area's minimum pixels and stays inside it", () => {
    const area = { width: 3909, height: 4431 };
    const choice = assignPrintFile("sweatshirt", area, master, a3);
    if (choice.file !== "padded") throw new Error("expected padded");
    expect(choice.fit.width).toBeLessThanOrEqual(area.width);
    expect(choice.fit.height).toBe(area.height);
    expect(choice.fit.width).toBeGreaterThanOrEqual(3000);
    expect(choice.fit.height).toBeGreaterThanOrEqual(3600);
  });
});

describe("fit wording", () => {
  it("flags 'full front' copy on fitted apparel", async () => {
    const { validateListing } = await import("@/lib/listing-validator");
    const base = { title: "Alpine Sweatshirt", tags: [], description: "Full front edge-to-edge print.", priceChf: 40, productType: "pod", podProvider: "printify:sweatshirt" } as never;
    const fitted = validateListing({ ...(base as object), printFit: "fitted" } as never).issues.map((i) => i.code);
    const filled = validateListing({ ...(base as object), printFit: "fill" } as never).issues.map((i) => i.code);
    expect(fitted).toContain("fit_wording");
    expect(filled).not.toContain("fit_wording");
  });
});
