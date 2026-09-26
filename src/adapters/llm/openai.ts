import { config } from "@/lib/config";
import { ETSY_LIMITS } from "@/lib/listing-validator";
import { NICHES } from "@/lib/niches";
import type { ListingBrief, ListingCopy, LLMProvider } from "./types";

export class OpenAILLMProvider implements LLMProvider {
  readonly name = "openai";

  async writeListing(brief: ListingBrief): Promise<ListingCopy> {
    const key = config.openaiKey;
    if (!key) throw new Error("OPENAI_API_KEY missing");
    const niche = NICHES[brief.niche];
    const product = brief.productType === "digital" ? "digital download" : `print-on-demand ${brief.podPreset}`;
    const system = [
      "You write Etsy listings for a Swiss seller. Output strict JSON: {\"title\": string, \"tags\": string[], \"body\": string}.",
      `Title: max ${ETSY_LIMITS.titleMax} characters, front-load the main keyword, no more than 3 ALL-CAPS words, use each of % : & at most once.`,
      `Tags: exactly ${ETSY_LIMITS.tagCount} lowercase tags, each at most ${ETSY_LIMITS.tagMax} characters, letters/numbers/spaces only, no duplicates.`,
      "Body: 2 short paragraphs plus a bullet list of what the buyer gets. Do NOT include AI or production disclosures (they are appended automatically).",
      "Never use trademarked brands or characters.",
    ].join("\n");
    const user = `Keyword: "${brief.keyword}"\nNiche: ${niche.label}\nProduct: ${product}\nStyle: ${niche.style}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.openaiModel,
        response_format: { type: "json_object" },
        temperature: 0.7,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const parsed = JSON.parse(json.choices[0].message.content);
    const usage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
    // Rough gpt-4.1-mini pricing (USD 0.40 / 1.60 per 1M tokens) converted to CHF.
    const costChf = ((usage.prompt_tokens * 0.4 + usage.completion_tokens * 1.6) / 1_000_000) * 0.83;
    return {
      title: String(parsed.title ?? ""),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      body: String(parsed.body ?? ""),
      costChf,
      provider: `openai:${config.openaiModel}`,
    };
  }
}
