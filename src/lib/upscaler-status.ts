/** Process-local Real-ESRGAN state, written by `src/pipeline/upscale.ts` and read by the dashboard status. */
export type UpscalerSource = "path" | "s3" | "url";
export type UpscalerState =
  | { state: "idle" }
  | { state: "ready"; source: UpscalerSource; loadMs: number; io: string }
  | { state: "fallback"; reason: string };

let current: UpscalerState = { state: "idle" };

export function setUpscalerState(next: UpscalerState) {
  current = next;
}

export function upscalerState(): UpscalerState {
  return current;
}
