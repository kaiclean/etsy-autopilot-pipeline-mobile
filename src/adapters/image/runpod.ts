import { config } from "@/lib/config";
import { withStoredUrl } from "@/lib/object-storage";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

type RunPodResponse = {
  id?: string;
  status?: string;
  error?: unknown;
  output?: {
    images?: Array<{ type?: string; data?: string; url?: string; image?: string; b64_json?: string }>;
    message?: unknown;
  };
};

const POLL_MS = 2_000;
const DEADLINE_MS = 120_000;
const BASE_URL = "https://api.runpod.ai/v2";

function workflowForRequest(raw: string, req: ImageRequest) {
  let workflow: unknown;
  try {
    workflow = JSON.parse(raw);
  } catch {
    throw new Error("RUNPOD_COMFY_WORKFLOW must be valid ComfyUI API-format JSON");
  }
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error("RUNPOD_COMFY_WORKFLOW must be a ComfyUI API-format object");
  }

  const ratio = req.aspectRatio ?? "2:3";
  const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
  const width = ratio === "1:1" ? 1024 : ratio === "16:9" ? 1536 : 1024;
  const height = Math.round((width * ratioHeight) / ratioWidth);
  let promptFound = false;

  const replace = (value: unknown): unknown => {
    if (value === "{{PROMPT}}") {
      promptFound = true;
      return req.prompt;
    }
    if (value === "{{SEED}}") return req.seed;
    if (value === "{{WIDTH}}") return width;
    if (value === "{{HEIGHT}}") return height;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    }
    return value;
  };

  const result = replace(workflow);
  if (!promptFound) throw new Error("RUNPOD_COMFY_WORKFLOW needs a {{PROMPT}} value in its positive prompt node");
  return result;
}

function outputImage(response: RunPodResponse): string | undefined {
  const image = response.output?.images?.[0];
  if (image) {
    const value = image.url ?? image.data ?? image.image ?? image.b64_json;
    if (typeof value !== "string" || !value) return undefined;
    if (/^(https?:|data:)/i.test(value)) return value;
    if (image.type === "s3_url") return value;
    return `data:image/png;base64,${value}`;
  }
  if (typeof response.output?.message === "string") {
    const value = response.output.message;
    if (/^(https?:|data:)/i.test(value)) return value;
    if (value) return `data:image/png;base64,${value}`;
  }
  return undefined;
}

export class RunPodImageProvider implements ImageProvider {
  readonly name = "runpod";
  readonly estimatedCostChf = config.runpod.costPerImageChf;

  constructor(private readonly opts: { pollMs?: number; deadlineMs?: number } = {}) {}

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const { apiKey, endpointId, workflow } = config.runpod;
    if (!apiKey) throw new Error("RUNPOD_API_KEY missing");
    if (!endpointId) throw new Error("RUNPOD_ENDPOINT_ID missing");
    if (!workflow) throw new Error("RUNPOD_COMFY_WORKFLOW missing");

    const base = `${BASE_URL}/${encodeURIComponent(endpointId)}`;
    const headers = { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" };
    const submitted = await fetch(`${base}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { workflow: workflowForRequest(workflow, req) } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!submitted.ok) throw new Error(`RunPod submit ${submitted.status}`);
    let job = (await submitted.json()) as RunPodResponse;
    if (job.status === "COMPLETED") return this.saveImage(job);
    if (!job.id) throw new Error("RunPod response did not include a job id");
    const jobId = job.id;

    const deadline = Date.now() + (this.opts.deadlineMs ?? DEADLINE_MS);
    while (Date.now() < deadline) {
      if (job.status === "FAILED" || job.status === "CANCELLED" || job.status === "TIMED_OUT") {
        throw new Error(`RunPod job ${job.status.toLowerCase()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.opts.pollMs ?? POLL_MS));
      const polled = await fetch(`${base}/status/${encodeURIComponent(jobId)}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!polled.ok) throw new Error(`RunPod status ${polled.status}`);
      job = (await polled.json()) as RunPodResponse;
      if (job.status === "COMPLETED") return this.saveImage(job);
    }
    throw new Error("RunPod image job timed out");
  }

  private async saveImage(job: RunPodResponse): Promise<GeneratedImage> {
    const url = outputImage(job);
    if (!url) throw new Error("RunPod completed without an output image");
    return withStoredUrl({ url, costChf: this.estimatedCostChf, provider: this.name });
  }
}
