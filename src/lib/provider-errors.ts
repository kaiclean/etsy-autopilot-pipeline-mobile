export type StageYield = "success" | "warning" | "failed";

export class ImageProviderConfigurationError extends Error {}

export function imageEndpointConfigurationError(baseUrl: string): string | null {
  let hostname: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "Image provider base URL must use HTTP or HTTPS.";
    hostname = url.hostname;
  } catch {
    return "Image provider base URL is invalid. Set IMAGE_BASE_URL to the provider's API base URL.";
  }
  if (hostname !== "ollama.com" && !hostname.endsWith(".ollama.com")) return null;
  return "Ollama Cloud has no image API. Set IMAGE_BASE_URL to an image-capable provider, IMAGE_API_KEY to that provider's key, and IMAGE_MODEL to its image model. Keep OPENAI_BASE_URL for text only.";
}

/** OpenRouter/OpenAI 402, the provider body, and the dashboard wording. */
export function isProviderCreditsError(message: string) {
  return /\b402\b|insufficient credits|out of credits/i.test(message);
}

/**
 * A stage that attempted provider work and produced nothing has failed.
 * A mix of successes and failures is a warning. No failures stays success,
 * including an intentional stop such as the daily AI cap.
 */
export function yieldStatus(produced: number, failures: number): StageYield {
  if (failures > 0 && produced <= 0) return "failed";
  if (failures > 0) return "warning";
  return "success";
}

export type ProviderCreditSignal = "ok" | "warning" | "failed";

/** Latest design run: failed credits are red, any other credit error is amber. */
export function providerCreditSignal(
  run: { status: string; summary: string | null; logs: { msg: string }[] } | null | undefined,
): ProviderCreditSignal {
  if (!run) return "ok";
  const text = `${run.summary ?? ""}\n${(run.logs ?? []).map((line) => line.msg).join("\n")}`;
  if (!isProviderCreditsError(text)) return "ok";
  return run.status === "failed" ? "failed" : "warning";
}

const IMAGE_ERROR = /\b(?:401|402|404)\b|model[_\s-]?not[_\s-]?found|no such model|unknown model|invalid model|images failed|insufficient credits|out of credits/i;

export type ImageRunFact = {
  status: string;
  summary: string | null;
  logs?: { msg: string }[];
};

function redactProviderText(value: string) {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

/** Latest design-run line that names a real provider failure. Success runs stay quiet. */
export function lastImageProviderError(run: ImageRunFact | null | undefined): string | null {
  if (!run || (run.status !== "failed" && run.status !== "warning")) return null;
  const lines = [...(run.logs ?? []).map((line) => line.msg), run.summary ?? ""].filter((line) => line.trim() !== "");
  const hit = lines.find((line) => IMAGE_ERROR.test(line));
  return hit ? redactProviderText(hit) : null;
}

/** Short chip label for the last image-provider failure. */
export function imageProviderStatusLabel(error: string) {
  if (/\b402\b|insufficient credits|out of credits/i.test(error)) return "Out of credits";
  if (/\b401\b/i.test(error)) return "401";
  if (/\b404\b/i.test(error)) return "404";
  if (/model[_\s-]?not[_\s-]?found|no such model|unknown model|invalid model/i.test(error)) return "Model not found";
  return "Error";
}
