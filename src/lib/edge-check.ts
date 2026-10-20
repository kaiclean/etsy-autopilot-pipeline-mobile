import sharp from "sharp";

/**
 * Blank-edge check: counts rows/columns from each edge that are near-uniform (std < 6 per channel)
 * and bright (mean > 235) — e.g. a white band the model left at the top. Returns band sizes and the trimmed box.
 */
export async function blankEdgeBands(bytes: Buffer, opts: { maxStd?: number; minMean?: number } = {}) {
  const maxStd = opts.maxStd ?? 6;
  const minMean = opts.minMean ?? 235;
  const { data, info } = await sharp(bytes, { limitInputPixels: 128_000_000 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
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
  return { width, height, top, bottom, left, right, blank: top + bottom + left + right > 0,
    trimmed: { left, top, width: width - left - right, height: height - top - bottom } };
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
