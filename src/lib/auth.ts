export const SESSION_COOKIE = "ea_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const enc = new TextEncoder();

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Token format: `<expiresAtEpochSeconds>.<hex hmac>`. Works in both Node and edge runtimes. */
export async function createSessionToken(secret: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return `${exp}.${await hmac(secret, `session:${exp}`)}`;
}

export async function verifySessionToken(token: string | undefined, secret: string | undefined, now = Date.now()) {
  if (!token || !secret) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp * 1000 < now) return false;
  return safeEqual(sig, await hmac(secret, `session:${exp}`));
}

export async function passwordMatches(input: string, expected: string | undefined, secret: string) {
  if (!expected) return false;
  const [a, b] = await Promise.all([hmac(secret, `pw:${input}`), hmac(secret, `pw:${expected}`)]);
  return safeEqual(a, b);
}
