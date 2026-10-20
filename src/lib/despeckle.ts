import sharp from "sharp";

/**
 * Light despeckle for upscale output: a 3px median applied ONLY to low-variance (sky-like) blocks,
 * so isolated dark/light specks in flat areas go away while textured detail (branches, logs) is untouched.
 * A block is "flat" when the grey std of its pixels, ignoring the most extreme 2%, is below `maxStd`.
 */
export async function despeckleFlatRegions(bytes: Buffer, opts: { block?: number; maxStd?: number } = {}) {
  const block = opts.block ?? 32;
  const maxStd = opts.maxStd ?? 6;
  const img = sharp(bytes, { limitInputPixels: 128_000_000 });
  const { data: grey, info } = await img.clone().greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const bw = Math.ceil(width / block), bh = Math.ceil(height / block);
  const mask = Buffer.alloc(bw * bh);
  let flatBlocks = 0;
  const values: number[] = [];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    values.length = 0;
    for (let y = by * block; y < Math.min(height, (by + 1) * block); y++) {
      for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x++) values.push(grey[y * width + x]!);
    }
    values.sort((a, b) => a - b);
    const cut = Math.floor(values.length * 0.02);
    const core = values.slice(cut, values.length - cut);
    const mean = core.reduce((a, b) => a + b, 0) / core.length;
    const std = Math.sqrt(core.reduce((a, b) => a + (b - mean) ** 2, 0) / core.length);
    if (std < maxStd) { mask[by * bw + bx] = 255; flatBlocks++; }
  }
  if (!flatBlocks) return { bytes, flatBlocks, totalBlocks: bw * bh };
  const medianRgb = await img.clone().removeAlpha().median(3).raw().toBuffer();
  const { data: orig, info: oi } = await img.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(orig);
  for (let p = 0; p < width * height; p++) {
    const x = p % width, y = (p - x) / width;
    if (mask[Math.floor(y / block) * bw + Math.floor(x / block)]) { const i = p * oi.channels; for (let c = 0; c < oi.channels; c++) out[i + c] = medianRgb[i + c]!; }
  }
  const png = await sharp(out, { raw: { width, height, channels: oi.channels as 3 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
  return { bytes: png, flatBlocks, totalBlocks: bw * bh };
}
