/** Print masters below this long edge stay off the approval queue. */
export const MIN_PRINT_EDGE = 2000;

/** Luma standard deviation. A solid rectangle sits near 0. */
export const MIN_COLOR_STDDEV = 8;

export function isPlaceholderUrl(url: string | null | undefined) {
  if (!url) return false;
  try {
    return new URL(url, "http://localhost").pathname.includes("/api/placeholder/");
  } catch {
    return /\/api\/placeholder\//i.test(url);
  }
}

export function isSafeArtworkUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv6 literals: loopback, unspecified, unique-local, link-local, and IPv4-mapped addresses are private.
  if (host.includes(":") && (host === "::1" || host === "::" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith("::ffff:"))) return false;
  if (host === "localhost" || host.endsWith(".local") || host === "metadata.google.internal" || host === "metadata.internal") return false;
  if (host === "0.0.0.0" || host === "::1" || host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) {
    return false;
  }
  const match = /^172\.(\d+)\./.exec(host);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return false;
  return true;
}
