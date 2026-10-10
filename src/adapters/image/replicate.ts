import { config } from "@/lib/config";
import { withStoredUrl } from "@/lib/object-storage";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

type Prediction = {
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
};

const POLL_MS = 2000;
const DEADLINE_MS = 120_000;

function firstOutput(p: Prediction): string | undefined {
  const out = Array.isArray(p.output) ? p.output[0] : p.output;
  return typeof out === "string" && out ? out : undefined;
}

export class ReplicateImageProvider implements ImageProvider {
  readonly name = "replicate";
  readonly estimatedCostChf = 0.03;

  constructor(private readonly opts: { pollMs?: number; deadlineMs?: number } = {}) {}

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const token = config.replicateToken;
    if (!token) throw new Error("REPLICATE_API_TOKEN missing");
    const model = process.env.REPLICATE_MODEL ?? "black-forest-labs/flux-schnell";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: "POST",
      headers: { ...headers, Prefer: "wait=60" },
      // PNG so the print-file check can decode and measure it (flux defaults to webp).
      body: JSON.stringify({ input: { prompt: req.prompt, aspect_ratio: req.aspectRatio ?? "2:3", seed: req.seed, output_format: "png" } }),
    });
    if (!res.ok) throw new Error(`Replicate ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let prediction = (await res.json()) as Prediction;
    const deadline = Date.now() + (this.opts.deadlineMs ?? DEADLINE_MS);
    // Prefer: wait can return before the prediction finishes. Poll its `get` URL instead of failing.
    while (!firstOutput(prediction) && (prediction.status === "starting" || prediction.status === "processing")) {
      const next = prediction.urls?.get;
      if (!next || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? POLL_MS));
      const poll = await fetch(next, { headers });
      if (!poll.ok) throw new Error(`Replicate poll ${poll.status}: ${(await poll.text()).slice(0, 300)}`);
      prediction = (await poll.json()) as Prediction;
    }
    const out = firstOutput(prediction);
    if (!out) {
      const reason = prediction.error ? `: ${String(prediction.error).slice(0, 200)}` : "";
      throw new Error(`Replicate prediction not finished (status ${prediction.status ?? "unknown"})${reason}`);
    }
    return withStoredUrl({ url: out, costChf: this.estimatedCostChf, provider: this.name });
  }
}
