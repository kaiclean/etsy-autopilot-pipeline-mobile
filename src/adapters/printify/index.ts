import { assertOperationAllowed } from "@/lib/operation-policy";
import { providerAttempt } from "@/lib/provider-attempt";
import { resolveActiveShop, OMNISHOP_SLUG } from "@/lib/shops";
import type { DB } from "@/db";
import { hasPrintifyCredentials } from "@/lib/config";
import { liveWritesEnabled } from "@/lib/read-publish-mode";
import { PrintifyLiveClient } from "./client";
import { PrintifyDryRunAdapter } from "./dryrun";
import type { PrintifyAdapter, PrintifyOrderStatus } from "./types";

export async function getPrintifyAdapter(
  opts: { db?: DB; random?: () => number; known?: Record<string, PrintifyOrderStatus>; intent?: "read" | "write"; shopId?: string } = {},
): Promise<PrintifyAdapter> {
  const intent = opts.intent ?? "write";
  if(opts.db && intent === "write") { const shop=await resolveActiveShop(opts.db,opts.shopId); await assertOperationAllowed(opts.db,shop.id); }
  const allowed = opts.db && (intent === "read" || (await liveWritesEnabled(opts.db,opts.shopId)));
  if (allowed && hasPrintifyCredentials()) {
    const db = opts.db!;
    const shop = await resolveActiveShop(db,opts.shopId);
    // Global Printify credentials belong to OmniShop, never to a newly added Etsy shop.
    if (shop.slug !== OMNISHOP_SLUG) throw new Error("Printify credentials are not configured for this shop");
    const client = new PrintifyLiveClient(() => assertOperationAllowed(db, shop.id, true));
    const create = client.createAndPublish.bind(client);
    client.createAndPublish = (input) => input.existingProductId && !input.publishToEtsy ? create(input) : providerAttempt(db, `printify:${shop.id}`, input, () => create(input));
    return client;
  }
  return new PrintifyDryRunAdapter(opts.random, opts.known);
}

export type { PrintifyAdapter, PrintifyOrderStatus } from "./types";
