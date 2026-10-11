import type { BusinessAdapter } from "../types";
import { runPinterestDrafts, runPinterestPublish } from "./stage";

/** Child of the Etsy business. Drafts pins into the approval queue. Writes stay off until CONFIRM plus Standard access. */
export const pinterestAdapter: BusinessAdapter = {
  kind: "pinterest",
  stages: {
    list: runPinterestDrafts,
    publish: runPinterestPublish,
  },
  connections: ["pinterest", "s3"],
  publishApproval: "api",
  qualityChecks: [
    { id: "pin-title", label: "Title is within 100 characters" },
    { id: "pin-description", label: "Description and alt text are within 500 characters" },
    { id: "pin-image", label: "Image comes from S3" },
    { id: "pin-destination", label: "Destination link is the Etsy listing" },
  ],
};
