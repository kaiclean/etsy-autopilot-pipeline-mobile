import type { DB } from "@/db";
import { liveWritesEnabled } from "@/lib/read-publish-mode";
import { getSetting, setSetting } from "@/lib/settings";
import { PinterestLiveClient } from "./client";
import { PinterestDryRunAdapter } from "./dryrun";
import type { PinterestAdapter } from "./types";

export function pinterestEnv() {
  const e = process.env;
  return {
    appId: e.PINTEREST_APP_ID,
    appSecret: e.PINTEREST_APP_SECRET,
    boardId: e.PINTEREST_BOARD_ID,
    accessToken: e.PINTEREST_ACCESS_TOKEN,
    refreshToken: e.PINTEREST_REFRESH_TOKEN,
  };
}

export function hasPinterestCredentials() {
  const p = pinterestEnv();
  return Boolean(p.appId && p.appSecret && p.boardId && (p.refreshToken || p.accessToken));
}

/** Live pins need the same go-live arm as Etsy writes, plus Pinterest keys. Everything else is dry-run. */
export async function getPinterestAdapter(db: DB): Promise<PinterestAdapter> {
  if (!hasPinterestCredentials() || !(await liveWritesEnabled(db))) return new PinterestDryRunAdapter();
  const p = pinterestEnv();
  const stored = await getSetting(db, "pinterestTokens");
  // Seed from env once; afterwards refreshed tokens live in settings. expiresAt 0 forces a refresh.
  const tokens = stored ?? { accessToken: p.accessToken ?? "", refreshToken: p.refreshToken ?? "", expiresAt: 0 };
  return new PinterestLiveClient(tokens, { id: p.appId!, secret: p.appSecret! }, (t) => setSetting(db, "pinterestTokens", t));
}

export type { PinInput, PinterestAdapter } from "./types";
