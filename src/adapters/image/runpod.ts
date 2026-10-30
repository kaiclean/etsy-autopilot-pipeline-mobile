import { assertPaidInferenceAllowed } from "@/lib/free-mode";
import { config } from "@/lib/config";
import { modelReferences, workflowSha256, type ArtworkProvenance } from "@/lib/artwork-provenance";
import { materializeImageUrl, type MaterializeDeps } from "@/lib/object-storage";
import { ImageProviderHttpError, imageErrorDetail } from "./errors";
import type { GeneratedImage, ImageProvider, ImageRequest } from "./types";

type RunPodResponse = {
  id?: string;
  status?: string;
  error?: unknown;
  output?: {
    images?: Array<{ type?: string; data?: string; url?: string; image?: string; b64_json?: string }>;
    message?: unknown;
    errors?: unknown;
  };
};

function diagnostic(job: RunPodResponse) {
  const errors = JSON.stringify(job.output?.errors ?? job.error ?? [], (key, value) =>
    /data|image|url|base64|b64|signature|secret|token|key/i.test(key) ? "[redacted]" : value);
  return `job ${imageErrorDetail(job.id ?? "unknown").slice(0, 100)}; output keys: ${Object.keys(job.output ?? {}).map((key) => /^[a-zA-Z_]{1,40}$/.test(key) ? key : "[redacted]").join(", ")}; errors: ${imageErrorDetail(errors).slice(0, 500)}`;
}

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
  // A dedicated model upscales print art; digital artwork keeps the native diffusion resolution.
  const nodes = result as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  const save = req.print ? Object.values(nodes).filter((node) => node.class_type === "SaveImage" && Array.isArray(node.inputs?.images)) : [];
  for (const node of save) {
    const id = Math.max(0, ...Object.keys(nodes).map(Number).filter(Number.isFinite)) + 1;
    nodes[String(id)] = { class_type: "UpscaleModelLoader", inputs: { model_name: config.runpod.upscaleModel } };
    nodes[String(id + 1)] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: [String(id), 0], image: node.inputs!.images } };
    node.inputs!.images = [String(id + 1), 0];
  }
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
    if (value && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return `data:image/png;base64,${value}`;
  }
  return undefined;
}

export class RunPodImageProvider implements ImageProvider {
  readonly name = "runpod";
  readonly estimatedCostChf = config.runpod.costPerImageChf;

  constructor(private readonly opts: { pollMs?: number; deadlineMs?: number; upload?: MaterializeDeps["upload"] } = {}) {}

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    assertPaidInferenceAllowed("runpod");
    try {
      return await this.generateImage(req);
    } catch (error) {
      console.error(imageErrorDetail(error instanceof Error ? error.message : String(error)));
      throw error;
    }
  }

  private async request(url: string, init: RequestInit, phase: string, deadline: number): Promise<RunPodResponse> {
    const timeout = Math.min(20_000, deadline - Date.now());
    if (timeout <= 0) throw new Error(`RunPod ${phase} timed out: image generation deadline exceeded`);
    const signal = AbortSignal.timeout(timeout);
    try {
      const response = await fetch(url, { ...init, signal });
      if (!response.ok) throw new ImageProviderHttpError(`RunPod ${phase}`, response.status, await response.text());
      return await response.json() as RunPodResponse;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name))) {
        throw new Error(`RunPod ${phase} timed out after ${timeout / 1000} seconds; check endpoint workers, queue, and RunPod logs`);
      }
      throw error;
    }
  }

  private async generateImage(req: ImageRequest): Promise<GeneratedImage> {
    const { apiKey, endpointId, workflow } = config.runpod;
    if (!apiKey) throw new Error("RUNPOD_API_KEY missing");
    if (!endpointId) throw new Error("RUNPOD_ENDPOINT_ID missing");
    if (!workflow) throw new Error("RUNPOD_COMFY_WORKFLOW missing");

    const base = `${BASE_URL}/${encodeURIComponent(endpointId)}`;
    const headers = { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" };
    const submittedWorkflow = workflowForRequest(workflow, req);
    const provenance: ArtworkProvenance = {
      version: 1,
      provider: "runpod",
      templateSha256: workflowSha256(JSON.parse(workflow)),
      workflowSha256: workflowSha256(submittedWorkflow),
      requestedSeed: req.seed,
      requestedAspectRatio: req.aspectRatio ?? "2:3",
      printRequested: Boolean(req.print),
      modelReferences: modelReferences(submittedWorkflow),
    };
    const deadline = Date.now() + (this.opts.deadlineMs ?? DEADLINE_MS);
    let job = await this.request(`${base}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { workflow: submittedWorkflow } }),
    }, "submit", deadline);
    if (job.status === "COMPLETED") return this.saveImage(job, provenance);
    if (job.status === "FAILED" || job.status === "CANCELLED" || job.status === "TIMED_OUT") {
      throw new Error(`RunPod ${job.status.toLowerCase()}: ${diagnostic(job)}`);
    }
    if (!job.id) throw new Error("RunPod response did not include a job id");
    const jobId = job.id;

    while (Date.now() < deadline) {
      if (job.status === "FAILED" || job.status === "CANCELLED" || job.status === "TIMED_OUT") {
        throw new Error(`RunPod ${job.status.toLowerCase()}: ${diagnostic({ ...job, id: jobId })}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.opts.pollMs ?? POLL_MS, Math.max(0, deadline - Date.now()))));
      if (Date.now() >= deadline) break;
      job = await this.request(`${base}/status/${encodeURIComponent(jobId)}`, {
        headers,
      }, `status (job ${imageErrorDetail(jobId)})`, deadline);
      if (job.status === "COMPLETED") return this.saveImage({ ...job, id: jobId }, provenance);
    }
    throw new Error(`RunPod image job timed out after ${(this.opts.deadlineMs ?? DEADLINE_MS) / 1000} seconds: ${diagnostic({ ...job, id: jobId })}. Check endpoint workers, queue, and RunPod logs.`);
  }

  private async saveImage(job: RunPodResponse, provenance: ArtworkProvenance): Promise<GeneratedImage> {
    const url = outputImage(job);
    if (!url) throw new Error(`RunPod completed without an output image: ${diagnostic(job)}. Configure worker S3 upload for large print outputs.`);
    const temporary = job.output?.images?.[0]?.type === "s3_url" || /^https?:/i.test(url);
    let stored: string;
    try {
      stored = await materializeImageUrl(url, { upload: this.opts.upload, requireStored: temporary });
    } catch {
      throw new Error(`RunPod image could not be stored: ${diagnostic(job)}. Check app object storage and worker S3 configuration.`);
    }
    const jobId = job.id && /^[a-zA-Z0-9_-]{1,100}$/.test(job.id) ? job.id : undefined;
    return { url: stored, costChf: this.estimatedCostChf, provider: this.name, provenance: { ...provenance, ...(jobId ? { jobId } : {}) } };
  }
}
