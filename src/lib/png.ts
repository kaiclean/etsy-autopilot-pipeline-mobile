import { deflateSync, inflateSync } from "node:zlib";

type RGB = [number, number, number];

export type RgbImage = { width: number; height: number; rgb: Uint8Array };

function crc32(buf: Buffer) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}

function encodePng(width: number, height: number, paint: (fill: (x: number, y: number, w: number, h: number, color: RGB) => void, blit: (image: RgbImage, x: number, y: number, w: number, h: number) => void) => void) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const fill = (x: number, y: number, w: number, h: number, color: RGB) => {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(width, x + w);
    const y1 = Math.min(height, y + h);
    for (let yy = y0; yy < y1; yy++) {
      let i = yy * stride + 1 + x0 * 3;
      for (let xx = x0; xx < x1; xx++) {
        raw[i] = color[0];
        raw[i + 1] = color[1];
        raw[i + 2] = color[2];
        i += 3;
      }
    }
  };
  const blit = (image: RgbImage, x: number, y: number, w: number, h: number) => {
    if (w <= 0 || h <= 0 || image.width < 1 || image.height < 1) return;
    const scale = Math.max(w / image.width, h / image.height);
    const sw = w / scale;
    const sh = h / scale;
    const sx0 = (image.width - sw) / 2;
    const sy0 = (image.height - sh) / 2;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(width, x + w);
    const y1 = Math.min(height, y + h);
    for (let yy = y0; yy < y1; yy++) {
      const sy = Math.min(image.height - 1, Math.max(0, Math.floor(sy0 + ((yy - y) / h) * sh)));
      let i = yy * stride + 1 + x0 * 3;
      for (let xx = x0; xx < x1; xx++) {
        const sx = Math.min(image.width - 1, Math.max(0, Math.floor(sx0 + ((xx - x) / w) * sw)));
        const o = (sy * image.width + sx) * 3;
        raw[i] = image.rgb[o] ?? 0;
        raw[i + 1] = image.rgb[o + 1] ?? 0;
        raw[i + 2] = image.rgb[o + 2] ?? 0;
        i += 3;
      }
    }
  };
  paint(fill, blit);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 8-bit RGB PNG. Etsy rejects the SVG placeholder, so publish sends this raster instead. */
export function rgbPng(width: number, height: number, color: RGB) {
  return encodePng(width, height, (fill) => fill(0, 0, width, height, color));
}

const WIDTH = 800;
const HEIGHT = 1000;

function nicheScene(niche: string): (fill: (x: number, y: number, w: number, h: number, color: RGB) => void) => void {
  if (niche === "gothic") {
    return (fill) => {
      fill(0, 0, WIDTH, HEIGHT, [24, 12, 22]);
      fill(48, 48, WIDTH - 96, HEIGHT - 96, [48, 24, 42]);
      fill(180, 220, 440, 28, [120, 72, 64]);
      fill(300, 360, 200, 280, [92, 36, 58]);
    };
  }
  if (niche === "christmas") {
    return (fill) => {
      fill(0, 0, WIDTH, HEIGHT, [140, 48, 48]);
      fill(0, 780, WIDTH, 220, [230, 226, 220]);
      fill(140, 420, 160, 360, [28, 92, 58]);
      fill(340, 300, 200, 480, [22, 78, 48]);
      fill(560, 460, 140, 320, [32, 100, 62]);
    };
  }
  if (niche === "birthday") {
    return (fill) => {
      fill(0, 0, WIDTH, HEIGHT, [245, 220, 170]);
      fill(90, 180, 620, 640, [255, 250, 242]);
      fill(160, 420, 480, 28, [210, 140, 70]);
    };
  }
  if (niche === "stream") {
    return (fill) => {
      fill(0, 0, WIDTH, HEIGHT, [28, 16, 58]);
      fill(70, 120, 440, 320, [64, 32, 120]);
      fill(540, 120, 190, 320, [40, 24, 80]);
      fill(90, 140, 80, 36, [190, 48, 72]);
    };
  }
  return (fill) => {
    fill(0, 0, WIDTH, HEIGHT, [186, 214, 224]);
    fill(0, 520, WIDTH, 480, [90, 130, 150]);
    fill(0, 680, WIDTH, 320, [70, 110, 140]);
    fill(0, 860, WIDTH, 140, [236, 240, 242]);
  };
}

const ACCENT: Record<string, RGB> = {
  alpine: [78, 122, 146],
  gothic: [92, 36, 58],
  christmas: [148, 52, 48],
  birthday: [196, 128, 72],
  stream: [72, 48, 140],
};

/**
 * Lifestyle product PNG. When `artwork` is set, it is cover-cropped into the print
 * window (mug, garment chest, poster opening). Without it, the window stays a flat accent.
 */
export function podMockupPng(preset: "posterA3" | "mug" | "tshirt" | "sweatshirt", niche: string, artwork?: RgbImage | null) {
  const accent = ACCENT[niche] ?? ACCENT.alpine!;
  const wall: RGB = niche === "gothic" ? [32, 24, 36] : niche === "christmas" ? [245, 236, 228] : [236, 230, 222];
  const print = (blit: (image: RgbImage, x: number, y: number, w: number, h: number) => void, fill: (x: number, y: number, w: number, h: number, color: RGB) => void, x: number, y: number, w: number, h: number) => {
    if (artwork) blit(artwork, x, y, w, h);
    else fill(x, y, w, h, accent);
  };
  return encodePng(480, 640, (fill, blit) => {
    fill(0, 0, 480, 640, wall);
    if (preset === "mug") {
      fill(0, 430, 480, 210, [186, 154, 124]);
      fill(168, 250, 150, 200, [250, 250, 248]);
      fill(168, 250, 150, 22, [232, 232, 230]);
      fill(300, 300, 36, 90, [250, 250, 248]);
      fill(318, 318, 28, 54, wall);
      print(blit, fill, 188, 300, 110, 100);
      fill(150, 440, 186, 16, [160, 130, 104]);
      return;
    }
    if (preset === "tshirt" || preset === "sweatshirt") {
      const bulky = preset === "sweatshirt";
      fill(0, 520, 480, 120, [214, 208, 200]);
      fill(90, bulky ? 150 : 170, 300, bulky ? 360 : 320, [248, 246, 242]);
      fill(40, 190, 70, 110, [248, 246, 242]);
      fill(370, 190, 70, 110, [248, 246, 242]);
      print(blit, fill, 150, bulky ? 230 : 250, 180, bulky ? 140 : 120);
      if (bulky) fill(90, 480, 300, 30, [230, 226, 220]);
      return;
    }
    fill(0, 560, 480, 80, [214, 206, 196]);
    fill(78, 70, 324, 430, [42, 36, 32]);
    fill(102, 94, 276, 382, [248, 244, 236]);
    const sky: RGB = [Math.min(255, accent[0] + 30), accent[1], accent[2]];
    print(blit, fill, 124, 120, 232, 320);
    if (!artwork) fill(124, 120, 232, 70, sky);
  });
}

/**
 * Small gallery preview. It is not the delivery PNG: different pixel size, and a stripe
 * watermark so the bytes cannot be the file the buyer downloads.
 */
export function digitalPreviewPng(niche: string, src = "") {
  let shift = 0;
  for (const c of src) shift = (shift + c.charCodeAt(0)) % 80;
  const accent = ACCENT[niche] ?? ACCENT.alpine;
  const wash: RGB = [Math.min(255, accent[0] + 40), Math.min(255, accent[1] + 20), Math.min(255, accent[2] + 10)];
  return encodePng(480, 640, (fill) => {
    fill(0, 0, 480, 640, wash);
    fill(36, 36, 408, 500, accent);
    fill(36 + shift, 80, 140, 220, [248, 244, 236]);
    for (let i = 0; i < 7; i++) fill(i * 80 - 20, 0, 14, 640, [160, 36, 36]);
    fill(0, 560, 480, 80, [28, 28, 28]);
  });
}

function canEmbedPreviewSrc(url: string) {
  if (!url || url.length > 2048) return false;
  if (url.startsWith("data:") || url.includes("data:") || /data%3a/i.test(url)) return false;
  return true;
}

/** Gallery path. Inline artwork is omitted so `src` cannot carry a base64 payload. */
export function digitalPreviewUrl(artworkUrl: string, niche: string) {
  const params = new URLSearchParams({ niche });
  if (canEmbedPreviewSrc(artworkUrl)) params.set("src", artworkUrl);
  return `/api/preview?${params.toString()}`;
}

/** Raster for our own `/api/placeholder`, `/api/preview` and `/api/mockup` URLs, so publish does not HTTP-fetch this server. */
export function localAssetPng(url: string): Buffer | null {
  const placeholder = placeholderPng(url);
  if (placeholder) return placeholder;
  const preview = previewPng(url);
  if (preview) return preview;
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  const preset = parsed.pathname.match(/\/api\/mockup\/(posterA3|mug|tshirt|sweatshirt)/)?.[1];
  if (!preset) return null;
  const src = parsed.searchParams.get("src");
  const nested = src && !src.includes("/api/mockup/") ? (placeholderPng(src) ?? previewPng(src)) : null;
  const artwork = nested ? decodePng(nested) : null;
  return podMockupPng(preset as "posterA3" | "mug" | "tshirt" | "sweatshirt", parsed.searchParams.get("niche") ?? "alpine", artwork);
}

export function previewPng(url: string): Buffer | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  if (!parsed.pathname.includes("/api/preview")) return null;
  return digitalPreviewPng(parsed.searchParams.get("niche") ?? "alpine", parsed.searchParams.get("src") ?? "");
}

/** Raster for `/api/placeholder/...` so publish does not HTTP-fetch this server through its own tunnel. */
export function placeholderPng(url: string): Buffer | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  if (!parsed.pathname.includes("/api/placeholder/")) return null;
  const niche = parsed.searchParams.get("niche") ?? "alpine";
  return encodePng(WIDTH, HEIGHT, nicheScene(niche));
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 8-bit RGB or RGBA PNG, non-interlaced. Returns null for other encodings. */
export function decodePng(buf: Buffer): RgbImage | null {
  if (buf.length < 8 || buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    if (offset + 12 + len > buf.length) return null;
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
  }
  if (!width || !height || width > 8000 || height > 8000 || width * height > 25_000_000 || bitDepth !== 8 || interlace !== 0) return null;
  if (colorType !== 2 && colorType !== 6) return null;
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  } catch {
    return null;
  }
  if (inflated.length < (stride + 1) * height) return null;
  const rgb = new Uint8Array(width * height * 3);
  const prior = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)] ?? 0;
    const row = inflated.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const x = row[i] ?? 0;
      const a = i >= channels ? current[i - channels]! : 0;
      const b = prior[i] ?? 0;
      const c = i >= channels ? prior[i - channels]! : 0;
      let v = x;
      if (filter === 1) v = (x + a) & 255;
      else if (filter === 2) v = (x + b) & 255;
      else if (filter === 3) v = (x + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (x + paeth(a, b, c)) & 255;
      else if (filter !== 0) return null;
      current[i] = v;
    }
    prior.set(current);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 3;
      const alpha = channels === 4 ? (current[s + 3] ?? 255) / 255 : 1;
      rgb[d] = Math.round((current[s] ?? 0) * alpha + 255 * (1 - alpha));
      rgb[d + 1] = Math.round((current[s + 1] ?? 0) * alpha + 255 * (1 - alpha));
      rgb[d + 2] = Math.round((current[s + 2] ?? 0) * alpha + 255 * (1 - alpha));
    }
  }
  return { width, height, rgb };
}

/** Population standard deviation of luma. A flat color is ~0. */
export function colorVariance(image: RgbImage) {
  const n = image.width * image.height;
  if (!n) return 0;
  const step = Math.max(1, Math.floor(n / 8000));
  let count = 0;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * 3;
    const y = 0.2126 * (image.rgb[o] ?? 0) + 0.7152 * (image.rgb[o + 1] ?? 0) + 0.0722 * (image.rgb[o + 2] ?? 0);
    sum += y;
    sum2 += y * y;
    count++;
  }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, sum2 / count - mean * mean));
}

/** Bilinear scale so the long edge is `edge` pixels. Already-large images are unchanged. */
export function scaleToLongEdge(image: RgbImage, edge: number): RgbImage {
  const long = Math.max(image.width, image.height);
  if (long >= edge || long < 1) return image;
  const width = Math.max(1, Math.round((image.width * edge) / long));
  const height = Math.max(1, Math.round((image.height * edge) / long));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(image.height - 1, (y + 0.5) * image.height / height - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(image.width - 1, (x + 0.5) * image.width / width - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const d = (y * width + x) * 3;
      const a = fx - x0;
      const b = fy - y0;
      for (let c = 0; c < 3; c++) {
        rgb[d + c] = Math.round(
          (image.rgb[(y0 * image.width + x0) * 3 + c] ?? 0) * (1 - a) * (1 - b) +
          (image.rgb[(y0 * image.width + x1) * 3 + c] ?? 0) * a * (1 - b) +
          (image.rgb[(y1 * image.width + x0) * 3 + c] ?? 0) * (1 - a) * b +
          (image.rgb[(y1 * image.width + x1) * 3 + c] ?? 0) * a * b
        );
      }
    }
  }
  return { width, height, rgb };
}

/** Box-filter downscale so the long edge is at most `edge` pixels. Smaller images are unchanged. */
export function shrinkToLongEdge(image: RgbImage, edge: number): RgbImage {
  const long = Math.max(image.width, image.height);
  if (long <= edge || edge < 1) return image;
  const width = Math.max(1, Math.round((image.width * edge) / long));
  const height = Math.max(1, Math.round((image.height * edge) / long));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * image.width + sx) * 3;
          r += image.rgb[s] ?? 0;
          g += image.rgb[s + 1] ?? 0;
          b += image.rgb[s + 2] ?? 0;
          n++;
        }
      }
      const d = (y * width + x) * 3;
      rgb[d] = Math.round(r / n);
      rgb[d + 1] = Math.round(g / n);
      rgb[d + 2] = Math.round(b / n);
    }
  }
  return { width, height, rgb };
}

export function encodeRgbPng(image: RgbImage) {
  const { width, height, rgb } = image;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
