import { config } from "@/lib/config";
import type { Enlarged, Upscaler } from "./types";

/**
 * Real-ESRGAN-style upscaling on Replicate. Set REPLICATE_UPSCALE_VERSION to the model version id
 * from the model's Replicate page; the version is not hard-coded because it changes.
 */
export class ReplicateUpscaler implements Upscaler {
  readonly name = "replicate-upscale";
  readonly estimatedCostChf = Number(process.env.REPLICATE_UPSCALE_COST_CHF ?? "0.02");

  async enlarge(src: Buffer, factor: number): Promise<Enlarged> {
    const token = config.replicateToken;
    const version = process.env.REPLICATE_UPSCALE_VERSION;
    if (!token) throw new Error("REPLICATE_API_TOKEN missing");
    if (!version) throw new Error("REPLICATE_UPSCALE_VERSION missing: copy the version id from the upscale model's Replicate page");
    const scale = Math.min(4, Math.max(2, Math.ceil(factor)));
    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait=60" },
      body: JSON.stringify({ version, input: { image: `data:image/png;base64,${src.toString("base64")}`, scale } }),
    });
    if (!res.ok) throw new Error(`Replicate upscale ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const out = Array.isArray(json.output) ? json.output[0] : json.output;
    if (!out) throw new Error(`Replicate upscale not finished (status ${json.status})`);
    const file = await fetch(String(out));
    if (!file.ok) throw new Error(`Could not download upscaled image: ${file.status}`);
    return { bytes: Buffer.from(await file.arrayBuffer()), costChf: this.estimatedCostChf, method: "upscale" };
  }
}
