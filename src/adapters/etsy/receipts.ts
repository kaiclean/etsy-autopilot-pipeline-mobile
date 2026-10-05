import { etsyMajorAmount } from "@/lib/ledger";
import type { EtsyReceipt } from "./types";

type RawMoney = { amount?: number; divisor?: number; currency_code?: string };
type RawTransaction = {
  transaction_id?: number;
  listing_id?: number;
  quantity?: number;
  price?: RawMoney;
  shipping_cost?: RawMoney;
};
type RawReceipt = {
  receipt_id?: number;
  status?: string;
  country_iso?: string;
  created_timestamp?: number;
  transactions?: RawTransaction[];
  refunds?: { amount?: RawMoney | number }[];
  total_shipping_cost?: RawMoney;
  discount_amt?: RawMoney;
  total_tax_cost?: RawMoney;
  grandtotal?: RawMoney;
};

function major(value: unknown) {
  return etsyMajorAmount(value)?.major ?? 0;
}

export function mapReceipt(value: unknown): EtsyReceipt[] {
  if (typeof value !== "object" || value == null) return [];
  const raw = value as RawReceipt;
  const receiptId = raw.receipt_id;
  if (receiptId == null) return [];
  const transactions = raw.transactions ?? [];
  const refundChf = (raw.refunds ?? []).reduce((sum, refund) => sum + major(refund.amount), 0);
  const shippingTotal = major(raw.total_shipping_cost);
  const discount = major(raw.discount_amt);
  const tax = major(raw.total_tax_cost);
  const lineCount = Math.max(transactions.length, 1);
  const cancelled = typeof raw.status === "string" && /cancel/i.test(raw.status);
  const createdAt = new Date((raw.created_timestamp ?? 0) * 1000);

  if (transactions.length === 0) {
    return [
      {
        receiptId: String(receiptId),
        etsyReceiptId: String(receiptId),
        etsyListingId: "",
        buyerCountry: raw.country_iso ?? "??",
        quantity: 1,
        totalChf: major(raw.grandtotal),
        shippingChf: shippingTotal,
        discountChf: discount,
        taxChf: tax,
        refundChf,
        cancelled,
        createdAt,
      },
    ];
  }

  return transactions.map((transaction) => {
    const quantity = transaction.quantity ?? 1;
    const unit = major(transaction.price);
    const lineShipping = transaction.shipping_cost ? major(transaction.shipping_cost) : shippingTotal / lineCount;
    return {
      receiptId: `${receiptId}-${transaction.transaction_id ?? "line"}`,
      etsyReceiptId: String(receiptId),
      etsyListingId: String(transaction.listing_id ?? ""),
      buyerCountry: raw.country_iso ?? "??",
      quantity,
      totalChf: unit * quantity,
      shippingChf: lineShipping,
      discountChf: discount / lineCount,
      taxChf: tax / lineCount,
      refundChf: refundChf / lineCount,
      cancelled,
      createdAt,
    };
  });
}
