/** Keep provider diagnostics useful without persisting credentials or image payloads. */
export function imageErrorDetail(value: string): string {
  let text = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret?.trim() && /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/i.test(key)) {
      text = text.split(secret.trim()).join("[redacted]");
    }
  }
  try {
    text = JSON.stringify(JSON.parse(text), (key, child) =>
      /^(data|image|images|url|base64|b64_json)$|signature|secret|token|api.?key|authorization/i.test(key) ? "[redacted]" : child);
  } catch {
    // Providers can return plain text or HTML instead of JSON.
  }
  return text
    .replace(/Bearer\s+\S+/gi, "******")
    .replace(/data:[^\s"\\]+/gi, "[image data redacted]")
    .replace(/https?:\/\/[^\s"\\]+/gi, "[URL redacted]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[encoded data redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 1000);
}

export class ImageProviderHttpError extends Error {
  constructor(provider: string, readonly status: number, body: string) {
    super(`${provider} HTTP ${status}: ${imageErrorDetail(body) || "empty response body"}`);
  }
}
