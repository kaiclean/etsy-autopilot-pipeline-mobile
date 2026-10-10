import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAILLMProvider } from "@/adapters/llm/openai";
import { assessArtwork, PRINT_WIDTH, PRINT_HEIGHT } from "@/lib/design-quality";

const clean = { score: 9, defects: [], notes: ["Clean illustration", "Strong composition"], text: false, empty: false, frameOnly: false, artifacts: false };
afterEach(() => vi.unstubAllGlobals());

function providerResponse(assessment: unknown) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
    choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(assessment)}\n\`\`\`` } }],
  })));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, provider: new OpenAILLMProvider({ apiKey: "test", baseUrl: "https://llm.example/v1", model: "gemma-test" }) };
}

describe("vision assessments", () => {
  it("does not gate on praise, including legacy reasons", () => {
    expect(assessArtwork({ ...clean, reasons: ["High contrast"] }, PRINT_WIDTH, PRINT_HEIGHT)).toEqual({ pass: true, reasons: [] });
  });

  it.each([
    [{ score: 6 }, /minimum/],
    [{ empty: true }, /empty/],
    [{ score: 8.5 }, /minimum/],
  ])("rejects actual gate failures %j", (change, reason) => {
    const result = assessArtwork({ ...clean, ...change }, PRINT_WIDTH, PRINT_HEIGHT);
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toMatch(reason);
  });

  it("rejects flat artwork without re-deriving pass from model commentary", () => {
    expect(assessArtwork(clean, PRINT_WIDTH, PRINT_HEIGHT, true, 0).reasons).toEqual(["Flat artwork."]);
  });

  it("parses gemma numeric and boolean strings and preserves notes separately", async () => {
    const { provider, fetchMock } = providerResponse({ ...clean, score: "8", text: "false", empty: "false", frameOnly: "false", artifacts: "false" });
    const vision = await provider.assessImage("https://bucket.example/art.png");
    expect(vision).toMatchObject({ ...clean, score: 8 });
    expect(assessArtwork(vision, PRINT_WIDTH, PRINT_HEIGHT)).toEqual({ pass: true, reasons: [] });
    const prompt = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).messages[0].content;
    expect(prompt).toMatch(/intentional negative space/i);
    expect(prompt).toMatch(/empty array when none/i);
  });

  it("stores only concrete defects alongside computed failure reasons", async () => {
    const { provider } = providerResponse({ ...clean, artifacts: "true", defects: ["Broken edges"] });
    const vision = await provider.assessImage("https://bucket.example/art.png");
    const result = assessArtwork(vision, PRINT_WIDTH, PRINT_HEIGHT);
    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual(["Visible rendering artifacts.", "Broken edges"]);
    expect(result.reasons).not.toContain("Strong composition");
  });

  it.each(["yes", "False", 0, null])("rejects invalid flags %j", async (text) => {
    const { provider } = providerResponse({ ...clean, text });
    await expect(provider.assessImage("https://bucket.example/art.png")).rejects.toThrow("invalid assessment");
  });
});
