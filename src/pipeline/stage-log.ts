import type { LogLine } from "@/db/schema";

const SECRET_ENV = /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|WEBHOOK)/i;

/** Replace credential values and bearer tokens before a line is stored or printed. */
export function maskSecrets(msg: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = msg;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8 || value.length > 4096) continue;
    if (!SECRET_ENV.test(key)) continue;
    out = out.split(value).join("[redacted]");
  }
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(/\b(access_token|refresh_token|api_key|client_secret|id_token)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return out;
}

export function formatStageLog(stage: string, level: LogLine["level"], msg: string) {
  return `[stage:${stage}] ${level} ${maskSecrets(msg)}`;
}

/** Info goes to stdout. Warnings and errors go to stderr. The returned text is safe to store. */
export function writeStageLog(stage: string, level: LogLine["level"], msg: string) {
  const safe = maskSecrets(msg);
  const line = `[stage:${stage}] ${level} ${safe}`;
  if (level === "info") console.log(line);
  else console.error(line);
  return safe;
}
