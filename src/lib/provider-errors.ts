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
