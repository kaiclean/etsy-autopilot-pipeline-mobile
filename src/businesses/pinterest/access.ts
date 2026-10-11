export type PinterestAccess = "trial" | "standard";

/** Trial is the default. Standard is explicit so a missing env cannot publish publicly. */
export function pinterestAccessTier(env: NodeJS.ProcessEnv = process.env): PinterestAccess {
  return env.PINTEREST_ACCESS?.trim().toLowerCase() === "standard" ? "standard" : "trial";
}

export function pinterestAccessToken(env: NodeJS.ProcessEnv = process.env) {
  const value = env.PINTEREST_ACCESS_TOKEN?.trim();
  return value ? value : null;
}

/**
 * API writes need a token, this business confirmed live, and Standard access.
 * Trial pins stay private, so Trial never calls the API.
 */
export function pinterestWriteAllowed(input: {
  accessToken: string | null;
  publishMode: string;
  access: PinterestAccess;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.accessToken) return { ok: false, reason: "PINTEREST_ACCESS_TOKEN is unset" };
  if (input.publishMode !== "live") return { ok: false, reason: "business is not confirmed live" };
  if (input.access !== "standard") return { ok: false, reason: "Trial access keeps pins private until Standard access" };
  return { ok: true };
}
