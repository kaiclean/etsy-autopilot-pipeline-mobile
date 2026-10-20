import { describe, expect, it } from "vitest";
import { PRINT_TARGETS, atLeast, getPrintTarget } from "@/lib/print-targets";

describe("A3 print target", () => {
  it("is exactly 3508×4961 with a matching minimum", () => {
    expect(PRINT_TARGETS.posterA3).toEqual({ minW: 3508, minH: 4961, targetW: 3508, targetH: 4961 });
  });
  it("getPrintTarget(posterA3) is exactly A3", async () => {
    expect(await getPrintTarget("posterA3")).toEqual({ minW: 3508, minH: 4961, targetW: 3508, targetH: 4961 });
  });
  it("a smaller Printify placeholder cannot lower the A3 floor", () => {
    expect(atLeast({ minW: 2316, minH: 3267, targetW: 3510, targetH: 4950 }, PRINT_TARGETS.posterA3))
      .toEqual({ minW: 3508, minH: 4961, targetW: 3510, targetH: 4961 });
  });
});
