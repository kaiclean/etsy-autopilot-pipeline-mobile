import { describe, expect, it } from "vitest";
import { createSessionToken, passwordMatches, verifySessionToken } from "@/lib/auth";

describe("session tokens", () => {
  it("round-trips with the right secret", async () => {
    const t = await createSessionToken("s3cret");
    expect(await verifySessionToken(t, "s3cret")).toBe(true);
  });
  it("rejects wrong secret, tampering and expiry", async () => {
    const t = await createSessionToken("s3cret");
    expect(await verifySessionToken(t, "other")).toBe(false);
    expect(await verifySessionToken(t.replace(/.$/, (c) => (c === "a" ? "b" : "a")), "s3cret")).toBe(false);
    const old = await createSessionToken("s3cret", Date.now() - 400 * 864e5);
    expect(await verifySessionToken(old, "s3cret")).toBe(false);
    expect(await verifySessionToken(undefined, "s3cret")).toBe(false);
  });
  it("compares passwords", async () => {
    expect(await passwordMatches("abc", "abc", "k")).toBe(true);
    expect(await passwordMatches("abd", "abc", "k")).toBe(false);
    expect(await passwordMatches("abc", undefined, "k")).toBe(false);
  });
});
