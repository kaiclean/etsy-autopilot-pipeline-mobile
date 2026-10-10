import { imageProviderStatusLabel, lastImageProviderError, type ImageRunFact } from "@/lib/provider-errors";

/** Refuse the queue while images are mock or the latest design run still shows a provider error. */
export function artRegenerationBlocker(provider: string, run: ImageRunFact | null | undefined) {
  if (provider === "mock") {
    return "Image provider is mock. Connect a working provider before regenerating art. Nothing was queued.";
  }
  const error = lastImageProviderError(run);
  if (!error) return null;
  return `Image provider last error: ${imageProviderStatusLabel(error)}. Nothing was queued.`;
}
