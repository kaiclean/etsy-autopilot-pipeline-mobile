import { config } from "@/lib/config";
import type { EtsyTokens } from "@/lib/settings";

export const ETSY_SCOPES = ["listings_r", "listings_w", "transactions_r", "shops_r"];
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

function b64url(bytes: ArrayBuffer | Uint8Array) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(arr).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createPkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { verifier, challenge, state };
}

export function buildAuthorizeUrl(opts: { challenge: string; state: string; redirectUri: string }) {
  const { apiKey } = config.etsy;
  if (!apiKey) throw new Error("ETSY_API_KEY missing");
  const u = new URL("https://www.etsy.com/oauth/connect");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", apiKey);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", ETSY_SCOPES.join(" "));
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<EtsyTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Etsy token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    // Etsy access tokens are prefixed with the numeric user id: "12345678.xxxx"
    userId: String(json.access_token).split(".")[0],
  };
}

export function exchangeCode(opts: { code: string; verifier: string; redirectUri: string }) {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: config.etsy.apiKey!,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    code_verifier: opts.verifier,
  });
}

export function refreshTokens(refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", client_id: config.etsy.apiKey!, refresh_token: refreshToken });
}
