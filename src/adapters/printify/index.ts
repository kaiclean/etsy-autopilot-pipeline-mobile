import { config, hasPrintifyCredentials } from "@/lib/config";
import { PrintifyLiveClient } from "./client";
import { PrintifyDryRunAdapter } from "./dryrun";
import type { PrintifyAdapter, PrintifyOrderStatus } from "./types";

export function getPrintifyAdapter(opts: { random?: () => number; known?: Record<string, PrintifyOrderStatus> } = {}): PrintifyAdapter {
  if (config.publishMode === "live" && hasPrintifyCredentials()) return new PrintifyLiveClient();
  return new PrintifyDryRunAdapter(opts.random, opts.known);
}

export type { PrintifyAdapter, PrintifyOrderStatus } from "./types";
