import { config } from "@/lib/config";
import { MockLLMProvider } from "./mock";
import { OpenAILLMProvider } from "./openai";
import type { LLMProvider } from "./types";

let providerOverride: LLMProvider | null = null;

/** Test hook. Production callers leave this unset. */
export function setLLMProviderForTests(provider: LLMProvider | null) {
  providerOverride = provider;
}

/**
 * The template writer is only for demo shops. A live shop without a configured LLM
 * (openai, ollama, or omniroute with its key) throws instead of drafting templated copy.
 */
export function getLLMProvider(opts?: { demo?: boolean }): LLMProvider {
  if (providerOverride) return providerOverride;
  if (config.llmProvider === "openai") return new OpenAILLMProvider();
  if (config.llmProvider === "ollama") {
    const ollama = config.ollama;
    return new OpenAILLMProvider({
      name: "ollama",
      apiKey: ollama.apiKey,
      baseUrl: ollama.baseUrl,
      model: ollama.model,
      missingKey: "OLLAMA_API_KEY missing",
    });
  }
  if (config.llmProvider === "omniroute") {
    const route = config.omniroute;
    return new OpenAILLMProvider({
      name: "omniroute",
      apiKey: route.apiKey,
      baseUrl: route.baseUrl,
      model: route.model,
      missingKey: "OMNIROUTE_API_KEY missing",
    });
  }
  if (opts?.demo) return new MockLLMProvider();
  throw new Error(
    "LLM_PROVIDER=openai and OPENAI_API_KEY (or ollama with OLLAMA_API_KEY, or omniroute with OMNIROUTE_API_KEY) are required. Template listing copy is only used in demo mode.",
  );
}

export type { LLMProvider, ListingBrief, ListingCopy } from "./types";
