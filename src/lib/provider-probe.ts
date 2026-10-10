import { config } from "@/lib/config";
import { RunPodImageProvider } from "@/adapters/image/runpod";

export type ProbeStatus = "ok" | "401" | "402" | "404" | "model not found" | "skipped" | "error";

export type ProbeResult = {
  target: "text" | "image";
  status: ProbeStatus;
  httpStatus?: number;
  detail: string;
};

const MODEL_MISSING = /model[_\s-]?not[_\s-]?found|no such model|unknown model|invalid model|model.*does not exist|does not exist.*model/i;

/** Map a provider HTTP response to a status the Connections page can show. */
export function classifyProviderStatus(httpStatus: number, body: string): ProbeStatus {
  if (MODEL_MISSING.test(body)) return "model not found";
  if (httpStatus === 401) return "401";
  if (httpStatus === 402) return "402";
  if (httpStatus === 404) return "404";
  if (httpStatus >= 200 && httpStatus < 300) return "ok";
  return "error";
}

function redact(value: string) {
  return value.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\s+/g, " ").trim();
}

function detailFor(status: ProbeStatus, httpStatus: number | undefined, body: string) {
  if (status === "ok" || status === "401" || status === "402" || status === "404" || status === "model not found") return status;
  const clipped = redact(body).slice(0, 160);
  if (httpStatus) return clipped ? `HTTP ${httpStatus}: ${clipped}` : `HTTP ${httpStatus}`;
  return clipped || "request failed";
}

function result(target: ProbeResult["target"], status: ProbeStatus, httpStatus?: number, body = ""): ProbeResult {
  return { target, status, httpStatus, detail: status === "skipped" ? body : detailFor(status, httpStatus, body) };
}

async function postJson(url: string, key: string, body: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 500) };
}

function textTarget(): { key: string; base: string; model: string } | { skip: ProbeResult } {
  if (config.llmProvider === "ollama") {
    const ollama = config.ollama;
    if (!ollama.apiKey) return { skip: result("text", "error", undefined, "OLLAMA_API_KEY missing") };
    return { key: ollama.apiKey, base: ollama.baseUrl, model: ollama.model };
  }
  if (config.llmProvider === "omniroute") {
    const route = config.omniroute;
    if (!route.apiKey) return { skip: result("text", "error", undefined, "OMNIROUTE_API_KEY missing") };
    if (!route.baseUrl) return { skip: result("text", "error", undefined, "OMNIROUTE_BASE_URL missing") };
    if (!route.model) return { skip: result("text", "error", undefined, "OMNIROUTE_MODEL missing") };
    return { key: route.apiKey, base: route.baseUrl, model: route.model };
  }
  if (config.llmProvider === "openai") {
    if (!config.openaiKey) return { skip: result("text", "error", undefined, "OPENAI_API_KEY missing") };
    return { key: config.openaiKey, base: config.openaiBaseUrl, model: config.openaiModel };
  }
  const requested = process.env.LLM_PROVIDER?.trim();
  if (requested === "openai" || requested === "ollama" || requested === "omniroute") {
    return { skip: result("text", "error", undefined, "key missing") };
  }
  return { skip: result("text", "skipped", undefined, "LLM provider is mock.") };
}

function imageTarget(): { key: string; base: string; model: string; openRouter: boolean } | { skip: ProbeResult } {
  if (config.imageProvider === "mock") {
    return { skip: result("image", "skipped", undefined, "Image provider is mock.") };
  }
  if (config.imageProvider === "higgsfield" || config.imageProvider === "replicate") {
    return { skip: result("image", "skipped", undefined, "Image probe runs for openai and omniroute.") };
  }
  if (config.imageProvider === "omniroute") {
    const route = config.omniroute;
    if (!route.apiKey) return { skip: result("image", "error", undefined, "OMNIROUTE_API_KEY missing") };
    if (!route.baseUrl) return { skip: result("image", "error", undefined, "OMNIROUTE_BASE_URL missing") };
    if (!route.imageModel) return { skip: result("image", "error", undefined, "OMNIROUTE_IMAGE_MODEL missing") };
    return { key: route.apiKey, base: route.baseUrl, model: route.imageModel, openRouter: false };
  }
  if (!config.imageApiKey) return { skip: result("image", "error", undefined, "IMAGE_API_KEY or OPENAI_API_KEY missing") };
  return {
    key: config.imageApiKey,
    base: config.imageBaseUrl,
    model: config.imageModel,
    openRouter: /openrouter\.ai/i.test(config.imageBaseUrl),
  };
}

async function probeText(): Promise<ProbeResult> {
  const target = textTarget();
  if ("skip" in target) return target.skip;
  try {
    const response = await postJson(`${target.base}/chat/completions`, target.key, {
      model: target.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0,
    });
    const status = classifyProviderStatus(response.status, response.body);
    return result("text", status, response.status, response.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return result("text", "error", undefined, message);
  }
}

async function probeImage(): Promise<ProbeResult> {
  if (config.imageProvider === "runpod") {
    try {
      await new RunPodImageProvider().generate({
        prompt: "a small red square",
        niche: "alpine",
        seed: 1,
        aspectRatio: "1:1",
      });
      return result("image", "ok", 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "RunPod image request failed";
      return result("image", "error", undefined, message);
    }
  }
  const target = imageTarget();
  if ("skip" in target) return target.skip;
  const paths = target.openRouter ? ["/images", "/images/generations"] : ["/images/generations"];
  let last: { status: number; body: string } = { status: 0, body: "" };
  try {
    for (const path of paths) {
      last = await postJson(`${target.base}${path}`, target.key, {
        model: target.model,
        prompt: "a small red square",
        n: 1,
        size: "1024x1024",
      });
      const status = classifyProviderStatus(last.status, last.body);
      if (status === "ok" || status === "401" || status === "402" || status === "model not found") {
        return result("image", status, last.status, last.body);
      }
      if (status !== "404") return result("image", status, last.status, last.body);
    }
    const status = classifyProviderStatus(last.status, last.body);
    return result("image", status, last.status, last.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return result("image", "error", undefined, message);
  }
}

/** One tiny chat completion and, when configured, one cheap image generation. */
export async function probeConnections(): Promise<{ text: ProbeResult; image: ProbeResult }> {
  const text = await probeText();
  const image = await probeImage();
  return { text, image };
}
