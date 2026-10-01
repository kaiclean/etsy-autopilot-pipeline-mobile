import type { DB } from "@/db";
import { hasPrintifyCredentials } from "@/lib/config";
import { liveWritesEnabled } from "@/lib/read-publish-mode";
import { PrintifyLiveClient } from "./client";
import { PrintifyDryRunAdapter } from "./dryrun";
import type { PrintifyAdapter, PrintifyOrderStatus } from "./types";

export async function getPrintifyAdapter(
  opts: { db?: DB; random?: () => number; known?: Record<string, PrintifyOrderStatus>; intent?: "read" | "write" } = {},
): Promise<PrintifyAdapter> {
  const intent = opts.intent ?? "write";
  const allowed = opts.db && (intent === "read" || (await liveWritesEnabled(opts.db)));
  if (allowed && hasPrintifyCredentials()) return new PrintifyLiveClient();
  return new PrintifyDryRunAdapter(opts.random, opts.known);
}

export type { PrintifyAdapter, PrintifyOrderStatus } from "./types";
