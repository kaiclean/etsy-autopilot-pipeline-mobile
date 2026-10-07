import type { DB } from "@/db";
import { saleAlerts } from "@/db/schema";

/** Real Etsy receipts only. Seed and dry-run ids never page the phone. */
export function isRealSaleReceipt(receiptId: string, isDemo: boolean) {
  if (isDemo) return false;
  return !receiptId.startsWith("demo-") && !receiptId.startsWith("dry-");
}

/**
 * Inserts the receipt id once.
 * A second call for the same receipt returns false so the push is not sent again.
 */
export async function claimSaleAlert(db: DB, receiptId: string, shopId?: string | null) {
  const rows = await db
    .insert(saleAlerts)
    .values({ etsyReceiptId: receiptId, shopId: shopId ?? null })
    .onConflictDoNothing({ target: saleAlerts.etsyReceiptId })
    .returning({ etsyReceiptId: saleAlerts.etsyReceiptId });
  return rows.length > 0;
}
