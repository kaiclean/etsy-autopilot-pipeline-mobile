import { deflateSync } from "node:zlib";

type RGB = [number, number, number];

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

function encodePng(width: number, height: number, paint: (fill: (x: number, y: number, w: number, h: number, color: RGB) => void) => void) {
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
  paint(fill);
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
 * Lifestyle product PNG for POD listings. Flat shapes only (no raw full-bleed artwork),
 * so the queue shows a mug / framed print / garment instead of the print file.
 */
export function podMockupPng(preset: "posterA3" | "mug" | "tshirt" | "sweatshirt", niche: string) {
  const accent = ACCENT[niche] ?? ACCENT.alpine;
  const wall: RGB = niche === "gothic" ? [32, 24, 36] : niche === "christmas" ? [245, 236, 228] : [236, 230, 222];
  return encodePng(480, 640, (fill) => {
    fill(0, 0, 480, 640, wall);
    if (preset === "mug") {
      fill(0, 430, 480, 210, [186, 154, 124]);
      fill(168, 250, 150, 200, [250, 250, 248]);
      fill(168, 250, 150, 22, [232, 232, 230]);
      fill(300, 300, 36, 90, [250, 250, 248]);
      fill(318, 318, 28, 54, wall);
      fill(188, 300, 110, 100, accent);
      fill(150, 440, 186, 16, [160, 130, 104]);
      return;
    }
    if (preset === "tshirt" || preset === "sweatshirt") {
      const bulky = preset === "sweatshirt";
      fill(0, 520, 480, 120, [214, 208, 200]);
      fill(90, bulky ? 150 : 170, 300, bulky ? 360 : 320, [248, 246, 242]);
      fill(40, 190, 70, 110, [248, 246, 242]);
      fill(370, 190, 70, 110, [248, 246, 242]);
      fill(150, bulky ? 230 : 250, 180, bulky ? 140 : 120, accent);
      if (bulky) fill(90, 480, 300, 30, [230, 226, 220]);
      return;
    }
    fill(0, 560, 480, 80, [214, 206, 196]);
    fill(78, 70, 324, 430, [42, 36, 32]);
    fill(102, 94, 276, 382, [248, 244, 236]);
    const sky: RGB = [Math.min(255, accent[0] + 30), accent[1], accent[2]];
    fill(124, 120, 232, 320, accent);
    fill(124, 120, 232, 70, sky);
  });
}

/** Raster for our own `/api/placeholder` and `/api/mockup` URLs, so publish does not HTTP-fetch this server. */
export function localAssetPng(url: string): Buffer | null {
  const placeholder = placeholderPng(url);
  if (placeholder) return placeholder;
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return null;
  }
  const preset = parsed.pathname.match(/\/api\/mockup\/(posterA3|mug|tshirt|sweatshirt)/)?.[1];
  if (!preset) return null;
  return podMockupPng(preset as "posterA3" | "mug" | "tshirt" | "sweatshirt", parsed.searchParams.get("niche") ?? "alpine");
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
