import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "./auth";
import { config } from "./config";

/** Defense in depth for server actions and route handlers (proxy already gates requests). */
export async function requireAuth() {
  const jar = await cookies();
  const ok = await verifySessionToken(jar.get(SESSION_COOKIE)?.value, config.authSecret);
  if (!ok) throw new Error("Unauthorized");
}
