import { config } from "@/lib/config";
import { ETSY_LIMITS } from "@/lib/listing-validator";
import { NICHES } from "@/lib/niches";
import { PROMISE_RULES } from "@/lib/delivery";
import { isSafeArtworkUrl } from "@/lib/art-quality";
import type { VisionAssessment } from "@/lib/design-quality";
import type { ListingBrief, ListingCopy, LLMProvider } from "./types";

export type CompatibleChatOptions = {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  missingKey?: string;
};

export class OpenAILLMProvider implements LLMProvider {
  readonly name: string;
  private readonly options?: CompatibleChatOptions;

  constructor(options?: CompatibleChatOptions) {
    this.name = options?.name ?? "openai";
    this.options = options;
  }

  async assessImage(url: string): Promise<VisionAssessment> {
    const key = !this.options ? config.openaiKey : this.options.apiKey;
    const base = (!this.options ? config.openaiBaseUrl : this.options.baseUrl ?? "").replace(/\/$/, "");
    const model = !this.options ? config.openaiModel : this.options.model;
    if (!key || !base || !model) throw new Error("Vision LLM configuration missing");
    if (!isSafeArtworkUrl(url) && !/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) {
      throw new Error("Vision assessment requires an HTTPS artwork URL or image data");
    }
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Inspect the actual artwork, not the prompt. Return strict JSON with score (integer 1-10 for print-worthiness), reasons (short strings), text (true for any letters, fake signature, stamp or watermark), empty (true for large empty/solid areas), frameOnly (true if only a frame/border with no central art), artifacts (true for visible digital defects, cheap bevels or murky contrast). Be strict; do not assume defects are absent." },
          { role: "user", content: [{ type: "text", text: "Assess this image for sale as printed art." }, { type: "image_url", image_url: { url } }] },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Vision LLM ${res.status}`);
    const json = await res.json();
    const parsed = parseListingJson(json?.choices?.[0]?.message?.content) as Record<string, unknown>;
    if (!Number.isInteger(parsed.score) || Number(parsed.score) < 1 || Number(parsed.score) > 10 ||
        !Array.isArray(parsed.reasons) || !parsed.reasons.every((s) => typeof s === "string") ||
        ["text", "empty", "frameOnly", "artifacts"].some((field) => typeof parsed[field] !== "boolean")) {
      throw new Error("Vision LLM returned an invalid assessment");
    }
    return parsed as VisionAssessment;
  }

  async writeListing(brief: ListingBrief): Promise<ListingCopy> {
    const defaults = !this.options;
    const key = defaults ? config.openaiKey : this.options?.apiKey;
    if (!key) throw new Error(this.options?.missingKey ?? "OPENAI_API_KEY missing");
    const niche = NICHES[brief.niche];
    const product = brief.productType === "digital" ? "digital download" : `print-on-demand ${brief.podPreset}`;
    const system = [
      "You write Etsy listings for a Swiss seller. Output strict JSON: {\"title\": string, \"tags\": string[], \"body\": string}.",
      `Title: max ${ETSY_LIMITS.titleMax} characters, Title Case, front-load the main keyword, at most 3 ALL-CAPS words and prefer none, use each of % : & at most once.`,
      `Tags: exactly ${ETSY_LIMITS.tagCount} lowercase tags, each at most ${ETSY_LIMITS.tagMax} characters, letters/numbers/spaces only, no duplicates.`,
      "Body: 2 short paragraphs plus a bullet list of what the buyer gets. Do NOT include AI or production disclosures (they are appended automatically).",
      "The shop delivers one opaque PNG or one physical print-on-demand item. Nothing is editable, a template, a bundle, transparent, animated, or a set.",
      `Do not use these claims unless they are literally true of that one file: ${PROMISE_RULES.map((rule) => rule.label).join(", ")}.`,
      "Do not use empty praise (unique, stunning, premium, perfect, beautiful, gift idea).",
      "Start the title with the keyword exactly as given. Do not put a different phrase first.",
      "Never use trademarked brands or characters.",
    ].join("\n");
    const user = `Keyword: "${brief.keyword}"\nNiche: ${niche.label}\nProduct: ${product}\nArt direction: ${brief.artDirection ?? niche.style}\nUse style tags only if supported by the art direction.\nDeliverable: ${brief.productType === "digital" ? "one opaque PNG, instant download, no physical item" : "one made-to-order physical item, printed and shipped"}`;

    const base = (defaults ? config.openaiBaseUrl : (this.options?.baseUrl ?? "")).replace(/\/$/, "");
    if (!base) throw new Error(this.name === "omniroute" ? "OMNIROUTE_BASE_URL missing" : "LLM base URL missing");
    const model = defaults ? config.openaiModel : this.options?.model;
    if (!model) throw new Error(this.name === "omniroute" ? "OMNIROUTE_MODEL missing" : "OLLAMA_MODEL missing");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
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
    const parsed = parseListingJson(json?.choices?.[0]?.message?.content);
    const usage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
    // Rough gpt-4.1-mini pricing (USD 0.40 / 1.60 per 1M tokens) converted to CHF.
    const costChf = ((usage.prompt_tokens * 0.4 + usage.completion_tokens * 1.6) / 1_000_000) * 0.83;
    return {
      title: String(parsed.title ?? ""),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      body: String(parsed.body ?? ""),
      costChf,
      provider: `${this.name}:${model}`,
    };
  }
}

/** Some OpenAI-compatible models (OpenRouter) wrap JSON in a ``` fence despite response_format. */
export function parseListingJson(content: unknown): { title?: unknown; tags?: unknown; body?: unknown } {
  if (typeof content !== "string" || !content.trim()) throw new Error("LLM response had no message content");
  const text = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  const body = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`LLM response was not JSON: ${text.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("LLM response JSON was not an object");
  return parsed as { title?: unknown; tags?: unknown; body?: unknown };
}
