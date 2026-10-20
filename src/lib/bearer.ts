import { timingSafeEqual } from "node:crypto";

/** Constant-time check of `Authorization: Bearer <token>` against an env secret. The "Bearer" scheme is required. */
export function bearerMatches(header: string | null | undefined, want: string | undefined) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!want || !m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
