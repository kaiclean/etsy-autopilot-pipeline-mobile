import sharp from "sharp";

/**
 * Blank-edge check: counts rows/columns from each edge that are near-uniform (std < 6 per channel)
 * and bright (mean > 235) — e.g. a white band the model left at the top. Returns band sizes and the trimmed box.
 */
const ANALYSIS_MAX = 1024;
type Raw = { data: Buffer; info: { width: number; height: number; channels: number }; full: { width: number; height: number } };

/** One decode, downscaled to ≤1024 px wide for analysis (a 4096×5120 master is ~20× cheaper); bands are scaled back up. */
async function analysisRaw(bytes: Buffer): Promise<Raw> {
  const img = sharp(bytes, { limitInputPixels: 128_000_000 });
  const meta = await img.metadata();
  const full = { width: meta.width ?? 0, height: meta.height ?? 0 };
  const pipeline = full.width > ANALYSIS_MAX ? img.resize({ width: ANALYSIS_MAX, kernel: "nearest" }) : img;
  const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info, full };
}

export async function blankEdgeBands(bytes: Buffer, opts: { maxStd?: number; minMean?: number } = {}, pre?: Raw) {
  const maxStd = opts.maxStd ?? 6;
  const minMean = opts.minMean ?? 235;
  const { data, info, full } = pre ?? await analysisRaw(bytes);
  const { width, height, channels } = info;
  const lineBlank = (get: (i: number) => number, n: number) => {
    for (let c = 0; c < channels; c++) {
      let sum = 0, sq = 0;
      for (let i = 0; i < n; i++) { const v = data[get(i) * channels + c]!; sum += v; sq += v * v; }
      const mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
      if (std > maxStd || mean < minMean) return false;
    }
    return true;
  };
  const row = (y: number) => lineBlank((i) => y * width + i, width);
  const col = (x: number) => lineBlank((i) => i * width + x, height);
  let top = 0; while (top < height && row(top)) top++;
  let bottom = 0; while (bottom < height - top && row(height - 1 - bottom)) bottom++;
  let left = 0; while (left < width && col(left)) left++;
  let right = 0; while (right < width - left && col(width - 1 - right)) right++;
  // Scale back to full size; round bands up so a trim removes the whole band.
  const sx = full.width / width, sy = full.height / height;
  const up = (v: number, k: number) => (v ? Math.min(Math.ceil(v * k), Math.round(k * (k === sx ? width : height))) : 0);
  const T = up(top, sy), B = up(bottom, sy), L = up(left, sx), R = up(right, sx);
  return { width: full.width, height: full.height, top: T, bottom: B, left: L, right: R, blank: T + B + L + R > 0,
    trimmed: { left: L, top: T, width: Math.max(0, full.width - L - R), height: Math.max(0, full.height - T - B) } };
}

/** Trim blank bands, then re-check the size floor. Returns the trimmed PNG, or a rejection reason. */
export async function trimBlankEdges(bytes: Buffer, floor: { width: number; height: number }) {
  const bands = await blankEdgeBands(bytes);
  if (!bands.blank) return { ok: true as const, bytes, bands };
  const t = bands.trimmed;
  if (t.width < floor.width || t.height < floor.height) {
    return { ok: false as const, bands, reason: `blank edge bands (top ${bands.top}, bottom ${bands.bottom}, left ${bands.left}, right ${bands.right}px); trimmed ${t.width}×${t.height} is below ${floor.width}×${floor.height}` };
  }
  return { ok: true as const, bands, bytes: await sharp(bytes).extract(t).png({ palette: false }).toBuffer() };
}

/**
 * Dark or flat (non-bright) uniform bands — e.g. a night sky edge. These are NEVER trimmed (could be art);
 * they only flag the render for Design review.
 */
export async function flatEdgeBands(bytes: Buffer, pre?: Raw) {
  const raw = pre ?? await analysisRaw(bytes);
  const flat = await blankEdgeBands(bytes, { maxStd: 6, minMean: 0 }, raw);
  const bright = await blankEdgeBands(bytes, {}, raw);
  const extra = { top: flat.top - bright.top, bottom: flat.bottom - bright.bottom, left: flat.left - bright.left, right: flat.right - bright.right };
  const review = Object.values(extra).some((v) => v >= 8);
  return { ...extra, review };
}
