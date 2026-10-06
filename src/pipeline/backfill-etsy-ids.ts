import { config as loadEnv } from "dotenv";

loadEnv({ path: [".env.local", ".env"], quiet: true });

import { PrintifyLiveClient } from "@/adapters/printify/client";
import { getDb } from "@/db";
import { hasPrintifyCredentials } from "@/lib/config";
import { backfillEtsyListingIds } from "./etsy-id-sync";

/**
 * Reclassify POD rows stuck at published with a null Etsy id.
 * `npm run backfill:etsy-ids -- --fetch` also GETs each Printify product's external id.
 * It does not call Printify or Etsy write endpoints.
 */
async function main() {
  const fetchExternalIds = process.argv.includes("--fetch");
  if (fetchExternalIds && !hasPrintifyCredentials()) {
    console.error("PRINTIFY_API_TOKEN and PRINTIFY_SHOP_ID are required for --fetch.");
    console.error("This command only GETs /v1/shops/{shop}/products/{id}.json. It does not publish.");
    process.exit(1);
  }
  const db = await getDb();
  const client = fetchExternalIds ? new PrintifyLiveClient() : null;
  const result = await backfillEtsyListingIds(db, {
    fetchExternalIds,
    lookup: client ? (ids) => client.getExternalEtsyIds(ids) : undefined,
    log: (msg, level) => {
      if (level === "error" || level === "warn") console.warn(msg);
      else console.log(msg);
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if (!fetchExternalIds) {
    console.log("Reclassified stuck rows only. Re-run with --fetch to read Printify external ids (GET only).");
    console.log("The orders cron does that read on its own once this build is running.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
