/** A Cloudflare-buffered SSE stream opens and dies in the same breath. That must count as a failure. */
export const SSE_HEALTHY_MS = 4_000;
export const SSE_FAILURES_BEFORE_POLL = 2;

export function sseFailuresAfterError(openedAtMs: number, nowMs: number, failures: number) {
  const lived = openedAtMs > 0 ? nowMs - openedAtMs : 0;
  if (openedAtMs > 0 && lived >= SSE_HEALTHY_MS) return 0;
  return failures + 1;
}
