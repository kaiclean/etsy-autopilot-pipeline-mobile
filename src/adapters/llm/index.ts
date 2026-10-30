import { config } from "@/lib/config";
import { assertPaidInferenceAllowed, freeOnlyMode, localOllamaConfig } from "@/lib/free-mode";
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
  const requested = process.env.LLM_PROVIDER?.trim();
  if (freeOnlyMode() && requested && requested !== "ollama-local" && requested !== "mock") {
    assertPaidInferenceAllowed(requested);
  }
  if (providerOverride) return providerOverride;
  if (requested === "ollama-local") {
    const local = localOllamaConfig();
    return new OpenAILLMProvider({
      name: "ollama-local", apiKey: "ollama-local", baseUrl: local.baseUrl,
      model: local.model, visionModel: local.visionModel,
    });
  }
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
    "Configure LLM_PROVIDER=ollama-local and OLLAMA_LOCAL_MODEL, or LLM_PROVIDER=openai with OPENAI_API_KEY, LLM_PROVIDER=ollama with OLLAMA_API_KEY, or LLM_PROVIDER=omniroute with OMNIROUTE_API_KEY. Template listing copy is only used in demo mode.",
  );
}

export type { LLMProvider, ListingBrief, ListingCopy } from "./types";
