export type StageYield = "success" | "warning" | "failed";

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
