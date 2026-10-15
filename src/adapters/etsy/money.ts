export type EtsyMoney = { amount: number; divisor: number; currency_code: string };

export function validateEtsyMoney(value: unknown): EtsyMoney {
  if (!value || typeof value !== "object") throw new Error("Etsy transaction money is missing");
  const money = value as Partial<EtsyMoney>;
  if (!Number.isSafeInteger(money.amount) || money.amount! < 0 ||
      !Number.isSafeInteger(money.divisor) || money.divisor! <= 0 ||
      typeof money.currency_code !== "string" || !/^[A-Z]{3}$/.test(money.currency_code)) {
    throw new Error("Etsy transaction money is invalid");
  }
  return money as EtsyMoney;
}

/** Foreign-currency sales remain unavailable until a fresh, explicit rate exists. */
export function etsyMoneyInChf(money: EtsyMoney, now = new Date()): { amountChf: number; rate: number; asOf: string | null } {
  if (money.currency_code === "CHF") return { amountChf: money.amount / money.divisor, rate: 1, asOf: null };
  let rates: Record<string, { chfPerUnit?: number; asOf?: string }>;
  try {
    rates = JSON.parse(process.env.ETSY_FX_RATES_JSON ?? "{}");
  } catch {
    throw new Error("ETSY_FX_RATES_JSON is invalid");
  }
  const entry = rates?.[money.currency_code];
  const date = entry?.asOf ? Date.parse(entry.asOf) : NaN;
  if (!entry || typeof entry.chfPerUnit !== "number" || !Number.isFinite(entry.chfPerUnit) ||
      entry.chfPerUnit <= 0 || !Number.isFinite(date) || date > now.getTime() ||
      now.getTime() - date > 24 * 60 * 60 * 1000) {
    throw new Error(`Etsy ${money.currency_code} conversion unavailable: configure a rate dated within 24 hours`);
  }
  const amountChf = (money.amount / money.divisor) * entry.chfPerUnit;
  if (!Number.isFinite(amountChf)) throw new Error("Etsy converted amount exceeds the supported range");
  return { amountChf, rate: entry.chfPerUnit, asOf: entry.asOf! };
}
