import type { Niche, ProductType } from "@/db/schema";
import type { PodPreset } from "@/lib/fees";
import type { VisionAssessment } from "@/lib/design-quality";

export type ListingBrief = {
  keyword: string;
  niche: Niche;
  productType: ProductType;
  podPreset?: PodPreset;
  seed: number;
  artDirection?: string;
};

export type ListingCopy = {
  title: string;
  tags: string[];
  /** Body without disclosures; the pipeline appends required disclosure text. */
  body: string;
  costChf: number;
  provider: string;
};

export interface LLMProvider {
  readonly name: string;
  writeListing(brief: ListingBrief): Promise<ListingCopy>;
  assessImage?(url: string): Promise<VisionAssessment>;
}
