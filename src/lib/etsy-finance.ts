import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { etsyFinancialEvidence, type FinancialComponent, type FinancialEvidenceStatus } from "@/db/etsy-finance";
import { listings, orders, shops } from "@/db/schema";
export { FINANCE_IMPORT_MAX_BYTES } from "./finance-import-limits";

export class FinanceImportError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

const components = ["revenue", "fee", "refund", "tax", "supplier_spend", "adjustment", "unknown"] as const;
const statuses = ["actual", "estimated", "unavailable"] as const;
const identifier = /^[A-Za-z0-9:_-]{1,100}$/;
const etsyId = /^[1-9][0-9]{0,29}$/;
const receiptLineId = /^[1-9][0-9]{0,29}(?:-[1-9][0-9]{0,29})?$/;
const MAX_ROWS = 500;

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FinanceImportError("Expected a JSON object.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new FinanceImportError("Unknown field. Remove names, addresses, descriptions and other personal data before import.");
  }
  return row;
}

function token(value: unknown, field: string, pattern = identifier): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new FinanceImportError(`Invalid ${field}; use an opaque source identifier, not personal data.`);
  return value;
}

export function parseFinanceImport(input: unknown) {
  const body = object(input, ["etsyShopId", "authorizedSellerData", "sourceKind", "sourceRef", "observations"]);
  if (body.authorizedSellerData !== true) throw new FinanceImportError("Confirm that you are authorized to import this seller's financial data.");
  const etsyShopId = token(body.etsyShopId, "etsyShopId", etsyId);
  const sourceRef = token(body.sourceRef, "sourceRef");
  if (body.sourceKind !== "seller_export" && body.sourceKind !== "normalized_ledger") {
    throw new FinanceImportError("Only seller_export or normalized_ledger is supported. Automatic payment and ledger imports are not enabled.");
  }
  const sourceKind: "seller_export" | "normalized_ledger" = body.sourceKind;
  if (!Array.isArray(body.observations) || body.observations.length < 1 || body.observations.length > MAX_ROWS) {
    throw new FinanceImportError(`Import between 1 and ${MAX_ROWS} observations.`);
  }
  const observations = body.observations.map((input) => {
    const row = object(input, ["observationRef", "etsyListingId", "receiptId", "ledgerType", "component", "status", "amount", "divisor", "currency", "occurredAt"]);
    const observationRef = token(row.observationRef, "observationRef");
    // Preserve unfamiliar ledger codes without retaining raw exports, titles or buyer details.
    if (typeof row.ledgerType !== "string" || !row.ledgerType.trim() || row.ledgerType.length > 256
      || [...row.ledgerType].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(row.ledgerType)) {
      throw new FinanceImportError("ledgerType must be a category label without personal data or control characters.");
    }
    const ledgerType = row.ledgerType;
    if (!components.includes(row.component as FinancialComponent)) throw new FinanceImportError("Invalid component; use unknown for an unrecognized ledger type.");
    if (!statuses.includes(row.status as FinancialEvidenceStatus)) throw new FinanceImportError("Invalid evidence status.");
    if (!Number.isInteger(row.divisor) || Number(row.divisor) <= 0 || Number(row.divisor) > 2_147_483_647) {
      throw new FinanceImportError("divisor must be a positive 32-bit integer.");
    }
    if (typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)) throw new FinanceImportError("currency must be an uppercase three-letter currency code.");
    if (row.status === "unavailable" ? row.amount !== null : typeof row.amount !== "string" || !/^-?(0|[1-9][0-9]{0,29})$/.test(row.amount)) {
      throw new FinanceImportError("amount must be an original signed integer string, or null only when unavailable.");
    }
    if (typeof row.occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.occurredAt) || !Number.isFinite(Date.parse(row.occurredAt))) {
      throw new FinanceImportError("occurredAt must be an ISO timestamp with a timezone.");
    }
    return {
      observationRef, ledgerType,
      etsyListingId: row.etsyListingId == null ? null : token(row.etsyListingId, "etsyListingId", etsyId),
      receiptId: row.receiptId == null ? null : token(row.receiptId, "receiptId", receiptLineId),
      component: row.component as FinancialComponent, status: row.status as FinancialEvidenceStatus,
      amount: row.amount as string | null, divisor: row.divisor as number, currency: row.currency,
      occurredAt: new Date(row.occurredAt),
    };
  });
  return { etsyShopId, sourceKind, sourceRef, observations };
}

/** No provider writes and no changes to legacy estimated order fields. */
export async function importFinancialEvidence(db: DB, shopId: string, input: unknown) {
  const parsed = parseFinanceImport(input);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.etsyShopId !== parsed.etsyShopId) throw new FinanceImportError("The export does not belong to the selected shop.", 403);
  const listingIds = [...new Set(parsed.observations.flatMap((row) => row.etsyListingId ? [row.etsyListingId] : []))];
  const receiptIds = [...new Set(parsed.observations.flatMap((row) => row.receiptId ? [row.receiptId] : []))];
  const ownedListings = listingIds.length
    ? await db.select().from(listings).where(and(eq(listings.shopId, shopId), eq(listings.isDemo, false), inArray(listings.etsyListingId, listingIds)))
    : [];
  const ownedOrders = receiptIds.length
    ? await db.select().from(orders).where(and(eq(orders.shopId, shopId), eq(orders.isDemo, false), inArray(orders.etsyReceiptId, receiptIds)))
    : [];
  const listingMap = new Map(ownedListings.map((row) => [row.etsyListingId, row]));
  const receiptMap = new Map(ownedOrders.map((row) => [row.etsyReceiptId, row]));
  const uniqueRows = new Map<string, typeof etsyFinancialEvidence.$inferInsert>();
  for (const row of parsed.observations) {
    const listing = row.etsyListingId ? listingMap.get(row.etsyListingId) : undefined;
    const receipt = row.receiptId ? receiptMap.get(row.receiptId) : undefined;
    if (row.etsyListingId && (!listing || listing.publishMode === "dry-run")) throw new FinanceImportError("An exact, non-demo listing owned by the selected shop is required.", 403);
    if (row.etsyListingId && ownedListings.filter((entry) => entry.etsyListingId === row.etsyListingId).length !== 1) {
      throw new FinanceImportError("Listing ownership is ambiguous; reconcile duplicate listing IDs first.", 409);
    }
    if (row.receiptId && !receipt) throw new FinanceImportError("An exact receipt-line or legacy receipt key owned by the selected shop is required. Sync orders first.", 403);
    if (listing && receipt && (receipt.listingId !== null ? receipt.listingId !== listing.id : receipt.unmatchedEtsyListingId !== row.etsyListingId)) {
      throw new FinanceImportError("Receipt and listing do not match.", 403);
    }
    const value = {
      shopId, etsyShopId: parsed.etsyShopId, sourceKind: parsed.sourceKind, sourceRef: parsed.sourceRef,
      ...row, listingId: listing?.id ?? null,
    };
    const contentHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const previous = uniqueRows.get(row.observationRef);
    if (previous && previous.contentHash !== contentHash) throw new FinanceImportError("Conflicting duplicate observationRef in import.", 409);
    uniqueRows.set(row.observationRef, { ...value, contentHash });
  }
  try {
    // An unequal retry violates NOT NULL and aborts the whole statement, including concurrent imports.
    await db.insert(etsyFinancialEvidence).values([...uniqueRows.values()]).onConflictDoUpdate({
      target: [etsyFinancialEvidence.shopId, etsyFinancialEvidence.sourceKind, etsyFinancialEvidence.sourceRef, etsyFinancialEvidence.observationRef],
      set: { contentHash: sql`CASE WHEN ${etsyFinancialEvidence.contentHash} = excluded.content_hash THEN ${etsyFinancialEvidence.contentHash} ELSE NULL END` },
    });
  } catch (error) {
    const cause = error as { code?: string; cause?: { code?: string } };
    if (cause.code === "23502" || cause.cause?.code === "23502") {
      throw new FinanceImportError("Source reference already exists with different evidence. Use a new source reference for corrections; existing evidence is immutable.", 409);
    }
    throw error;
  }
  return { accepted: uniqueRows.size, profitStatus: "unavailable" as const };
}

export async function getFinancialEvidence(db: DB, shopId: string) {
  const rows = await db.select().from(etsyFinancialEvidence)
    .where(eq(etsyFinancialEvidence.shopId, shopId))
    .orderBy(desc(etsyFinancialEvidence.occurredAt), desc(etsyFinancialEvidence.id)).limit(100);
  return {
    rows,
    profitStatus: "unavailable" as const,
    incompleteComponents: ["complete revenue", "all fees", "refunds and chargebacks", "tax treatment", "supplier production and shipping", "currency reconciliation"],
  };
}
