import { describe, expect, it } from "vitest";
import { bearerMatches } from "@/lib/bearer";
import { clearLoginFailures, loginLocked, MAX_FAILURES, recordLoginFailure, safeNext } from "@/lib/login-limit";

describe("bearer", () => {
  it("requires the Bearer scheme and an exact token", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("bearer abc", "abc")).toBe(true);
    expect(bearerMatches("abc", "abc")).toBe(false);
    expect(bearerMatches("Bearer ", "abc")).toBe(false);
    expect(bearerMatches("Bearer ab", "abc")).toBe(false);
    expect(bearerMatches("Bearer abc extra", "abc")).toBe(false);
    expect(bearerMatches("Bearer abc", undefined)).toBe(false);
    expect(bearerMatches(null, "abc")).toBe(false);
  });
});
describe("login throttle", () => {
  it("locks after repeated failures and clears on success", () => {
    const k = "1.2.3.4";
    for (let i = 0; i < MAX_FAILURES; i++) { expect(loginLocked(k, 1000)).toBe(false); recordLoginFailure(k, 1000); }
    expect(loginLocked(k, 1000)).toBe(true);
    expect(loginLocked(k, 1000 + 16 * 60_000)).toBe(false);
    recordLoginFailure(k); clearLoginFailures(k); expect(loginLocked(k)).toBe(false);
  });
  it("only allows same-origin next paths", () => {
    expect(safeNext("/queue?x=1")).toBe("/queue?x=1");
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "/a\\b", "/x\r\nSet-Cookie: a", ""]) expect(safeNext(bad)).toBe("/");
  });
});

import { buildProductTitle, padTitle } from "@/lib/product-title";
describe("title padding", () => {
  it("never leaves a dangling single pad word and drops file-format words from POD titles", () => {
    expect(padTitle("Swiss Alps Mug")).toBe("Swiss Alps Mug | Illustrated Art Design");
    expect(padTitle("Swiss Alps Mug | Calm Lake")).toBe("Swiss Alps Mug | Calm Lake Illustrated Design");
    const t = buildProductTitle("halloween floral png autumn", "", "sweatshirt");
    expect(t.toLowerCase()).not.toContain("png");
    expect(t).not.toMatch(/\| Original$/);
  });
});
