import { describe, expect, it } from "vitest";
import { repeatedTagWords } from "@/lib/review-queue";

describe("review queue", () => {
  it("reports words repeated across tags", () => {
    expect(repeatedTagWords(["christmas cabin", "cabin print", "snow"])).toEqual({ cabin: 2 });
    expect(repeatedTagWords(["a b", "c d"])).toEqual({});
  });
});
