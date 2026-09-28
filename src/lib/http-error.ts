/** Turn undici's bare "fetch failed" into the underlying cause. */
export function describeFetchError(error: unknown, what: string): Error {
  if (!(error instanceof Error)) return new Error(`${what}: ${String(error)}`);
  if (error.message !== "fetch failed") return error;
  const cause = "cause" in error ? error.cause : undefined;
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : "network request failed";
  return new Error(`${what}: ${detail}`);
}
