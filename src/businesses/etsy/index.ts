import { runAnalytics } from "@/pipeline/analytics";
import { runDesign } from "@/pipeline/design";
import { runListing } from "@/pipeline/listing";
import { runOrders } from "@/pipeline/orders";
import { runPublish } from "@/pipeline/publish";
import { runResearch } from "@/pipeline/research";
import type { BusinessAdapter } from "../types";

/**
 * Business #1. The existing Etsy functions are wrapped unchanged:
 * produce is the design stage, list is the listing stage.
 */
export const etsyAdapter: BusinessAdapter = {
  kind: "etsy",
  stages: {
    research: runResearch,
    produce: runDesign,
    list: runListing,
    publish: runPublish,
    orders: runOrders,
    analytics: runAnalytics,
  },
  connections: ["etsy", "printify", "s3", "openrouter"],
  publishApproval: "api",
  qualityChecks: [
    { id: "listing-copy", label: "Title, tags, description, and price pass the listing rules" },
    { id: "artwork", label: "Artwork is a real print file, not a placeholder" },
    { id: "disclosure", label: "AI disclosure is present before approval" },
  ],
};
