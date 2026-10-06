import { config as loadEnv } from "dotenv";

loadEnv({ path: [".env.local", ".env"], quiet: true });

import { backfillInlineImages } from "@/lib/image-backfill";
import { storageBackend } from "@/lib/config";
import { materializeImageUrl } from "@/lib/object-storage";
import { getDb } from "./index";

/**
 * Move inline `data:` images already stored in `image_url` (and digital
 * `delivery_url`) into the configured S3 or Blob bucket, then save the URL.
 *
 *   npm run images:backfill
 *   npm run images:backfill -- --dry-run
 *
 * Uses DATABASE_URL plus the existing storage variables. Does not create secrets.
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && storageBackend() === "none") {
    console.error(
      "Object storage is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION, and S3_BUCKET, or BLOB_READ_WRITE_TOKEN. Pass --dry-run to count inline images without uploading.",
    );
    process.exit(1);
  }
  const db = await getDb();
  const report = await backfillInlineImages(
    db,
    async (dataUrl) => {
      const stored = await materializeImageUrl(dataUrl);
      if (!stored || stored.startsWith("data:")) throw new Error("Upload did not return a stored URL");
      return stored;
    },
    { dryRun },
  );
  console.log(JSON.stringify({ ...report, errors: report.errors.slice(0, 20) }, null, 2));
  if (report.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
