import { MIN_COLOR_STDDEV } from "@/lib/art-quality";
import { PRINT_TARGETS, hasMinimumPixels, pixelSize, type PrintTarget } from "@/lib/print-targets";

export const PRINT_WIDTH = PRINT_TARGETS.posterA3.targetW;
export const PRINT_HEIGHT = PRINT_TARGETS.posterA3.targetH;
export const MIN_DESIGN_SCORE = 7;

export type VisionAssessment = {
  score: number;
  defects?: string[];
  notes?: string[];
  /** Legacy model commentary is informational, never a gate input. */
  reasons?: string[];
  costChf?: number;
  text: boolean;
  empty: boolean;
  frameOnly: boolean;
  artifacts: boolean;
};

export function assessArtwork(
  vision: VisionAssessment,
  width: number | null,
  height: number | null,
  print = true,
  variance: number | null = null,
  target: PrintTarget = PRINT_TARGETS.posterA3,
) {
  const reasons: string[] = [];
  if (!Number.isInteger(vision.score) || vision.score < MIN_DESIGN_SCORE || vision.score > 10) {
    reasons.push(`Print-worthiness ${vision.score}/10 (minimum ${MIN_DESIGN_SCORE}).`);
  }
  if (["text", "empty", "frameOnly", "artifacts"].some((field) => typeof vision[field as keyof VisionAssessment] !== "boolean")) {
    reasons.push("Invalid image quality flags.");
  }
  if (vision.text === true) reasons.push("Visible text, lettering, stamp or signature.");
  if (vision.empty === true) reasons.push("Large empty or solid area.");
  if (vision.frameOnly === true) reasons.push("Frame-only composition.");
  if (vision.artifacts === true) reasons.push("Visible rendering artifacts.");
  if (print && !hasMinimumPixels(width, height, target)) {
    reasons.push(`Print file ${pixelSize(width && height ? { width, height } : null)} is below ${target.minW}×${target.minH}px.`);
  }
  if (variance != null && variance < MIN_COLOR_STDDEV) reasons.push("Flat artwork.");
  const pass = reasons.length === 0;
  if (!pass) reasons.push(...(vision.defects ?? []));
  return { pass, reasons };
}
