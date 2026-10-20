/** Per-client login throttle (in memory, per instance): 8 failures in 15 min locks that client out for 15 min. */
const WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES = 8;
const fails = new Map<string, number[]>();

export function loginLocked(key: string, now = Date.now()) {
  const recent = (fails.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  fails.set(key, recent);
  return recent.length >= MAX_FAILURES;
}
export function recordLoginFailure(key: string, now = Date.now()) {
  const recent = (fails.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  fails.set(key, recent);
  if (fails.size > 5000) for (const [k, v] of fails) if (!v.some((t) => now - t < WINDOW_MS)) fails.delete(k);
}
export function clearLoginFailures(key: string) { fails.delete(key); }
/** Only same-origin paths; rejects protocol-relative and backslash tricks ("//x", "/\\x"). */
export function safeNext(next: string) {
  return /^\/(?![/\\])[^\\]*$/.test(next) && !/[\r\n]/.test(next) ? next : "/";
}
