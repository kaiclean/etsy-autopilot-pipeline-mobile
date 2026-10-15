import { createHash } from "node:crypto";

export type ArtworkProvenance = {
  version: 1;
  provider: "runpod";
  templateSha256: string;
  workflowSha256: string;
  requestedSeed: number;
  requestedAspectRatio: string;
  printRequested: boolean;
  modelReferences: string[];
  jobId?: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function workflowSha256(workflow: unknown): string {
  return createHash("sha256").update(canonical(workflow)).digest("hex");
}

/** Record fingerprints and explicit model filenames, never prompts, credentials or whole workflows. */
export function modelReferences(workflow: unknown): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(ckpt_name|model_name|unet_name|vae_name|clip_name|lora_name)$/.test(key) &&
          typeof child === "string" && child.length <= 200 && !/[:?@\\\r\n]/.test(child)) refs.add(child);
      else if (typeof child === "object") visit(child);
    }
  };
  visit(workflow);
  return [...refs].sort();
}
