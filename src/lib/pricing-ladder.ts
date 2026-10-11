import type { Niche, ProductType } from "@/db/schema";
import { calculateFees, DEFAULT_POD_PRESETS, podCostChf, POD_PRESETS, suggestPrice, type PodPreset } from "@/lib/fees";
import { NICHES } from "@/lib/niches";

/** POD rungs are priced at this net margin with the 15% offsite-ads fee included. */
export const LADDER_MARGIN_PCT = 30;

export type LadderRungId = "digital-entry" | "digital-mid" | "poster" | "tee" | PodPreset;

export type LadderRung = {
  id: LadderRungId;
  label: string;
  /** What the buyer gets. Mid digital is still one PNG, not a multi-file bundle. */
  deliverable: string;
  product: { type: ProductType; pod?: PodPreset };
  priceChf: number;
  podCostChf: number;
  netChf: number;
  marginPct: number;
  costIsEstimate?: boolean;
};

function snap90(value: number) {
  const whole = Math.floor(value);
  const snapped = whole + 0.9;
  return Math.round(snapped * 100) / 100;
}

/** First-impression digital price, clamped to about CHF 3.90–6.90 and the niche floor. */
export function digitalEntryPrice(niche: Niche) {
  const min = NICHES[niche].priceBand.digital[0];
  const clamped = Math.min(6.9, Math.max(3.9, min));
  const snapped = snap90(clamped);
  if (snapped < 3.9) return 3.9;
  if (snapped > 6.9) return 6.9;
  return snapped;
}

/** Higher single-PNG price. Niche caps below CHF 9.90 (gothic CHF 8.90) win. */
export function digitalMidPrice(niche: Niche) {
  return Math.min(9.9, NICHES[niche].priceBand.digital[1]);
}

function quote(priceChf: number, podCost: number) {
  const fees = calculateFees({ priceChf, podCostChf: podCost, offsiteAds: true });
  return { priceChf, podCostChf: podCost, netChf: fees.netChf, marginPct: fees.marginPct };
}

function podPrice(niche: Niche, preset: PodPreset, cost: number) {
  const band = NICHES[niche].priceBand.pod;
  return suggestPrice({
    targetMarginPct: LADDER_MARGIN_PCT,
    podCostChf: cost,
    offsiteAds: true,
    minChf: band[0] || undefined,
    maxChf: band[1] || undefined,
    competitorChf: POD_PRESETS[preset].marketAnchorChf,
    productType: "pod",
  });
}

/**
 * One design becomes six listings: a cheap digital entry, a higher single-PNG digital,
 * then poster, mug, tee, and sweatshirt. POD prices include Etsy fees, VAT, Printify cost,
 * and 15% offsite ads, and stay at about 30% net.
 */
export function quoteLadder(niche: Niche, enabled: readonly PodPreset[] = DEFAULT_POD_PRESETS, quotedCosts: Partial<Record<PodPreset, number | null>> = {}, estimates: Partial<Record<PodPreset, boolean>> = {}): LadderRung[] {
  const entry = quote(digitalEntryPrice(niche), 0);
  const mid = quote(digitalMidPrice(niche), 0);
  const podRungs: LadderRung[] = [...new Set(enabled)].flatMap((preset) => {
    const cost = Object.hasOwn(quotedCosts, preset) ? quotedCosts[preset] : podCostChf(preset);
    if (cost == null || !Number.isFinite(cost) || cost < 0) return [];
    const label = preset === "posterA3" ? "A3 poster" : preset === "tshirt" ? "Tee" : preset === "sweatshirt" ? "Sweatshirt" : preset === "mug" ? "Mug" : POD_PRESETS[preset].label;
    return [{
      id: preset === "posterA3" ? "poster" : preset === "tshirt" ? "tee" : preset,
      label,
      deliverable: `One made-to-order ${label.toLowerCase()}`,
      product: { type: "pod", pod: preset },
      ...quote(podPrice(niche, preset, cost), cost),
      costIsEstimate: estimates[preset] ?? !Object.hasOwn(quotedCosts, preset),
    }];
  });
  return [
    { id: "digital-entry", label: "Digital download", deliverable: "One PNG, instant download", product: { type: "digital" }, ...entry },
    { id: "digital-mid", label: "Large digital print", deliverable: "One larger PNG, instant download", product: { type: "digital" }, ...mid },
    ...podRungs,
  ];
}
