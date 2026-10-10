import { config } from "@/lib/config";
import { MockLLMProvider } from "./mock";
import { OpenAILLMProvider } from "./openai";
import type { LLMProvider } from "./types";

export function getLLMProvider(): LLMProvider {
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
  return new MockLLMProvider();
}

export type { LLMProvider, ListingBrief, ListingCopy } from "./types";
