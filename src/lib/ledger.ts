import { round2, usdToChf } from "@/lib/fees";

export type NormalizedLedgerEntry = {
  entryId: string;
  /** Signed major units in CHF. Fees are negative. */
  amountChf: number;
  ledgerType: string;
  referenceId: string | null;
  referenceType: string | null;
  assumedChf: boolean;
};

export type LedgerReceiptSummary = {
  referenceId: string;
  paymentChf: number;
  feeChf: number;
  offsiteAdsChf: number;
  refundChf: number;
  listingFeeChf: number;
  /** Signed ledger total for this receipt, before POD cost. */
  netBeforePodChf: number;
  entryCount: number;
  assumedChf: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null ? (value as Record<string, unknown>) : null;
}

/** Etsy money object, or an integer in minor units (rappen / cents). */
export function etsyMajorAmount(value: unknown): { major: number; currency: string | null } | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return { major: value / 100, currency: null };
    return { major: value, currency: null };
  }
  const rec = asRecord(value);
  if (!rec || typeof rec.amount !== "number" || !Number.isFinite(rec.amount)) return null;
  const divisor = typeof rec.divisor === "number" && rec.divisor > 0 ? rec.divisor : 100;
  const currency = typeof rec.currency_code === "string" ? rec.currency_code : typeof rec.currency === "string" ? rec.currency : null;
  return { major: rec.amount / divisor, currency };
}

function toChf(major: number, currency: string | null, fxRate: number) {
  const code = currency?.toUpperCase() ?? null;
  if (code === "USD") return { amountChf: usdToChf(major, fxRate), assumedChf: false };
  if (code != null && code !== "CHF") return null;
  return { amountChf: major, assumedChf: code == null };
}

export function normalizeLedgerEntry(raw: unknown, fxRate: number): NormalizedLedgerEntry | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const parsed = etsyMajorAmount(rec.amount);
  if (!parsed) return null;
  const currency = parsed.currency ?? (typeof rec.currency === "string" ? rec.currency : null);
  const converted = toChf(parsed.major, currency, fxRate);
  if (!converted) return null;
  const ledgerType = typeof rec.ledger_type === "string" ? rec.ledger_type : "";
  if (!ledgerType) return null;
  const referenceId = rec.reference_id == null ? null : String(rec.reference_id);
  const referenceType = typeof rec.reference_type === "string" ? rec.reference_type : null;
  const entryId = rec.entry_id == null ? `${ledgerType}:${referenceId ?? "shop"}:${converted.amountChf}` : String(rec.entry_id);
  return { entryId, amountChf: converted.amountChf, ledgerType, referenceId, referenceType, assumedChf: converted.assumedChf };
}

function isDisbursement(type: string) {
  return /disburse/i.test(type);
}

function isOffsite(type: string) {
  return /offsite_ads/i.test(type);
}

function isRefund(type: string) {
  return /refund/i.test(type);
}

function isListingFee(type: string) {
  return /^(listing|renew_|auto_renew)/i.test(type);
}

function isPayment(type: string) {
  return type === "PAYMENT" || /^payment$/i.test(type);
}

function onReceipt(entry: NormalizedLedgerEntry) {
  if (!entry.referenceId) return false;
  const ref = entry.referenceType ?? "";
  if (!ref) return true;
  return /receipt|transaction|payment/i.test(ref);
}

export function summarizeLedger(entries: NormalizedLedgerEntry[]) {
  const byReceipt = new Map<string, LedgerReceiptSummary>();
  const shopRenewals: { entryId: string; amountChf: number; ledgerType: string; assumedChf: boolean }[] = [];

  for (const entry of entries) {
    if (isDisbursement(entry.ledgerType)) continue;
    if (isListingFee(entry.ledgerType) && !onReceipt(entry)) {
      shopRenewals.push({
        entryId: entry.entryId,
        amountChf: round2(Math.abs(entry.amountChf)),
        ledgerType: entry.ledgerType,
        assumedChf: entry.assumedChf,
      });
      continue;
    }
    if (!entry.referenceId) continue;
    const row = byReceipt.get(entry.referenceId) ?? {
      referenceId: entry.referenceId,
      paymentChf: 0,
      feeChf: 0,
      offsiteAdsChf: 0,
      refundChf: 0,
      listingFeeChf: 0,
      netBeforePodChf: 0,
      entryCount: 0,
      assumedChf: false,
    };
    row.entryCount += 1;
    row.assumedChf = row.assumedChf || entry.assumedChf;
    row.netBeforePodChf += entry.amountChf;
    if (isPayment(entry.ledgerType) && entry.amountChf > 0) row.paymentChf += entry.amountChf;
    if (isOffsite(entry.ledgerType)) row.offsiteAdsChf += Math.abs(entry.amountChf);
    if (isRefund(entry.ledgerType)) row.refundChf += Math.abs(entry.amountChf);
    if (isListingFee(entry.ledgerType)) row.listingFeeChf += Math.abs(entry.amountChf);
    if (entry.amountChf < 0) row.feeChf += Math.abs(entry.amountChf);
    byReceipt.set(entry.referenceId, row);
  }

  for (const row of byReceipt.values()) {
    row.paymentChf = round2(row.paymentChf);
    row.feeChf = round2(row.feeChf);
    row.offsiteAdsChf = round2(row.offsiteAdsChf);
    row.refundChf = round2(row.refundChf);
    row.listingFeeChf = round2(row.listingFeeChf);
    row.netBeforePodChf = round2(row.netBeforePodChf);
  }
  return { byReceipt, shopRenewals };
}
