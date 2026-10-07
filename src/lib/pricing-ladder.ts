import type { Niche, ProductType } from "@/db/schema";
import { calculateFees, podCostChf, POD_PRESETS, suggestPrice, type PodPreset } from "@/lib/fees";
import { NICHES } from "@/lib/niches";

/** POD rungs are priced at this net margin with the 15% offsite-ads fee included. */
export const LADDER_MARGIN_PCT = 30;

export type LadderRungId = "digital-entry" | "digital-mid" | "poster" | "mug" | "tee" | "sweatshirt";

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

function podPrice(niche: Niche, preset: PodPreset) {
  const band = NICHES[niche].priceBand.pod;
  return suggestPrice({
    targetMarginPct: LADDER_MARGIN_PCT,
    podCostChf: podCostChf(preset),
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
export function quoteLadder(niche: Niche): LadderRung[] {
  const entry = quote(digitalEntryPrice(niche), 0);
  const mid = quote(digitalMidPrice(niche), 0);
  const poster = quote(podPrice(niche, "posterA3"), podCostChf("posterA3"));
  const mug = quote(podPrice(niche, "mug"), podCostChf("mug"));
  const tee = quote(podPrice(niche, "tshirt"), podCostChf("tshirt"));
  const sweat = quote(podPrice(niche, "sweatshirt"), podCostChf("sweatshirt"));
  return [
    { id: "digital-entry", label: "Digital download", deliverable: "One PNG, instant download", product: { type: "digital" }, ...entry },
    { id: "digital-mid", label: "Large digital print", deliverable: "One larger PNG, instant download", product: { type: "digital" }, ...mid },
    { id: "poster", label: "A3 poster", deliverable: "One made-to-order poster", product: { type: "pod", pod: "posterA3" }, ...poster },
    { id: "mug", label: "Mug", deliverable: "One made-to-order mug", product: { type: "pod", pod: "mug" }, ...mug },
    { id: "tee", label: "Tee", deliverable: "One made-to-order tee", product: { type: "pod", pod: "tshirt" }, ...tee },
    { id: "sweatshirt", label: "Sweatshirt", deliverable: "One made-to-order sweatshirt", product: { type: "pod", pod: "sweatshirt" }, ...sweat },
  ];
}
