import { config } from "@/lib/config";
import { MockLLMProvider } from "./mock";
import { OpenAILLMProvider } from "./openai";
import type { LLMProvider } from "./types";

export function getLLMProvider(): LLMProvider {
  return config.llmProvider === "openai" ? new OpenAILLMProvider() : new MockLLMProvider();
}

export type { LLMProvider, ListingBrief, ListingCopy } from "./types";
