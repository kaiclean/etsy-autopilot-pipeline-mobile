import { config } from "@/lib/config";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

/**
 * Higgsfield platform API adapter (submit → poll).
 * Endpoint paths are configurable because Higgsfield's public API surface changes;
 * verify HIGGSFIELD_API_BASE / HIGGSFIELD_TEXT2IMAGE_PATH against your account's docs.
 */
export class HiggsfieldImageProvider implements ImageProvider {
  readonly name = "higgsfield";
  readonly estimatedCostChf = Number(process.env.HIGGSFIELD_COST_PER_IMAGE_CHF ?? 0.05);

  private headers() {
    const { apiKey, apiSecret } = config.higgsfield;
    if (!apiKey) throw new Error("HIGGSFIELD_API_KEY missing");
    return {
      "Content-Type": "application/json",
      "hf-api-key": apiKey,
      ...(apiSecret ? { "hf-secret": apiSecret } : {}),
      Authorization: `Key ${apiKey}${apiSecret ? `:${apiSecret}` : ""}`,
    };
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const base = config.higgsfield.baseUrl.replace(/\/$/, "");
    const path = process.env.HIGGSFIELD_TEXT2IMAGE_PATH ?? "/v1/text2image/soul";
    const submit = await fetch(`${base}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        params: {
          prompt: req.prompt,
          aspect_ratio: req.aspectRatio ?? "2:3",
          seed: req.seed,
          quality: "1080p",
          batch_size: 1,
        },
      }),
    });
    if (!submit.ok) throw new Error(`Higgsfield submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
    const job = await submit.json();
    const jobId: string | undefined = job.id ?? job.job_set_id ?? job.request_id;
    const direct = extractUrl(job);
    if (direct) return { url: direct, costChf: this.estimatedCostChf, provider: this.name };
    if (!jobId) throw new Error("Higgsfield response had no job id");

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await fetch(`${base}/v1/job-sets/${jobId}`, { headers: this.headers() });
      if (!poll.ok) continue;
      const body = await poll.json();
      const url = extractUrl(body);
      if (url) return { url, costChf: this.estimatedCostChf, provider: this.name };
      const status = String(body.status ?? body.jobs?.[0]?.status ?? "");
      if (/fail|error|nsfw/i.test(status)) throw new Error(`Higgsfield job ${status}`);
    }
    throw new Error("Higgsfield job timed out");
  }
}

type HfResult = { url?: string };
type HfBody = {
  images?: HfResult[];
  jobs?: { results?: { raw?: HfResult; min?: HfResult } }[];
  result?: HfResult;
};

function extractUrl(body: unknown): string | undefined {
  const b = body as HfBody | undefined;
  return (
    b?.images?.[0]?.url ??
    b?.jobs?.[0]?.results?.raw?.url ??
    b?.jobs?.[0]?.results?.min?.url ??
    b?.result?.url ??
    undefined
  );
}
