import { describe, expect, it } from "vitest";
import { repairTrivialCopy, validateListing } from "@/lib/listing-validator";
import { requiredDisclosures } from "@/lib/disclosures";

describe("repairTrivialCopy disclosures", () => {
  it("adds AI and production-partner disclosures to an old POD draft", () => {
    const { draft } = repairTrivialCopy({ title: "Christmas Cabin Vintage Poster Cozy Winter Cabin Illustration", tags: [], description: "A cozy cabin.", priceChf: 30, productType: "pod" } as Parameters<typeof repairTrivialCopy>[0]);
    for (const disclosure of requiredDisclosures("pod")) expect(draft.description).toContain(disclosure);
    const codes = validateListing(draft).issues.map((issue) => issue.code);
    expect(codes).not.toContain("missing_ai_disclosure");
    expect(codes).not.toContain("missing_partner_disclosure");
  });
});
