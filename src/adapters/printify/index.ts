import type { DB } from "@/db";
import { hasPrintifyCredentials } from "@/lib/config";
import { readPublishMode } from "@/lib/read-publish-mode";
import { PrintifyLiveClient } from "./client";
import { PrintifyDryRunAdapter } from "./dryrun";
import type { PrintifyAdapter, PrintifyOrderStatus } from "./types";

export async function getPrintifyAdapter(
  opts: { db?: DB; random?: () => number; known?: Record<string, PrintifyOrderStatus> } = {},
): Promise<PrintifyAdapter> {
  if (opts.db && (await readPublishMode(opts.db)) === "live" && hasPrintifyCredentials()) return new PrintifyLiveClient();
  return new PrintifyDryRunAdapter(opts.random, opts.known);
}

export type { PrintifyAdapter, PrintifyOrderStatus } from "./types";
