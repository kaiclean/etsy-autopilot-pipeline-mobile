import { describe, expect, it } from "vitest";
import { focusAfter, queueAction, step } from "@/lib/queue-keys";

describe("queue keyboard", () => {
  it("maps keys to actions and ignores modifier shortcuts", () => {
    expect(queueAction({ key: "ArrowRight" })).toEqual({ type: "approve" });
    expect(queueAction({ key: "a" })).toEqual({ type: "approve" });
    expect(queueAction({ key: "A", shiftKey: true })).toEqual({ type: "bulkApprove" });
    expect(queueAction({ key: "R", shiftKey: true })).toEqual({ type: "bulkReject" });
    expect(queueAction({ key: "S", shiftKey: true })).toEqual({ type: "selectReady" });
    expect(queueAction({ key: "j" })).toEqual({ type: "next" });
    expect(queueAction({ key: "ArrowUp" })).toEqual({ type: "prev" });
    expect(queueAction({ key: " " })).toEqual({ type: "toggle" });
    expect(queueAction({ key: "Escape" })).toEqual({ type: "clear" });
    expect(queueAction({ key: "a", metaKey: true })).toBeNull();
    expect(queueAction({ key: "r", ctrlKey: true })).toBeNull();
    expect(queueAction({ key: "q" })).toBeNull();
  });
  it("keeps focus stable and advances after a decision", () => {
    expect(focusAfter([1, 2, 3], 2, 1)).toBe(2);
    expect(focusAfter([1, 3], 2, 1)).toBe(3); // 2 was decided: next slot
    expect(focusAfter([1], 3, 2)).toBe(1);
    expect(focusAfter([], 1, 0)).toBeNull();
    expect(step([1, 2, 3], 1, 1)).toBe(2);
    expect(step([1, 2, 3], 3, 1)).toBe(3);
    expect(step([1, 2, 3], 1, -1)).toBe(1);
    expect(step([1, 2, 3], null, 1)).toBe(1);
  });
});

import { currentIssues } from "@/lib/queue-keys";
import type { Listing } from "@/db/schema";
describe("currentIssues", () => {
  it("adds errors from rules introduced after the listing was drafted, without duplicates", () => {
    const l = { title: "Swiss Alps Mug", tags: Array.from({ length: 13 }, (_, i) => `alpine tag${i}`), description: "A mug.", priceChf: 20,
      validation: [{ code: "supplier_mockups_pending", field: "image", severity: "error", message: "Waiting" }] } as unknown as Listing;
    const codes = currentIssues(l).map((i) => i.code);
    expect(codes).toContain("title_word_count");
    expect(codes).toContain("supplier_mockups_pending");
    expect(new Set(codes).size).toBe(codes.length);
  });
});
