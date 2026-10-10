// An A3 poster is 11.7×16.5 inches; 2:3 artwork needs 3510×5265px to cover it at 300 dpi.
export const PRINT_WIDTH = 3510;
export const PRINT_HEIGHT = 5265;
export const MIN_DESIGN_SCORE = 7;

export type VisionAssessment = {
  score: number;
  reasons: string[];
  costChf?: number;
  text: boolean;
  empty: boolean;
  frameOnly: boolean;
  artifacts: boolean;
};

export function assessArtwork(vision: VisionAssessment, width: number | null, height: number | null, print = true) {
  const reasons = [...vision.reasons];
  if (!Number.isInteger(vision.score) || vision.score < MIN_DESIGN_SCORE || vision.score > 10) {
    reasons.push(`Print-worthiness ${vision.score}/10 (minimum ${MIN_DESIGN_SCORE}).`);
  }
  if (vision.text) reasons.push("Visible text, lettering, stamp or signature.");
  if (vision.empty) reasons.push("Large empty or solid area.");
  if (vision.frameOnly) reasons.push("Frame-only composition.");
  if (vision.artifacts) reasons.push("Visible rendering artifacts.");
  if (print && (!width || !height || Math.min(width, height) < PRINT_WIDTH || Math.max(width, height) < PRINT_HEIGHT)) {
    reasons.push(`Print file ${width ?? "?"}×${height ?? "?"}px is below ${PRINT_WIDTH}×${PRINT_HEIGHT}px.`);
  }
  return { pass: reasons.length === 0, reasons };
}
