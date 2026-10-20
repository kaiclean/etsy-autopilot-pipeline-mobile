/** Design's ratio rule: each POD product gets the file whose aspect is closest to its live Printify print area. */
export type Size = { width: number; height: number };
export type PrintFileChoice =
  | { file: "a3"; reason: string }
  | { file: "master"; reason: string }
  | { file: "padded"; fit: Size; reason: string }
  | { file: "none"; reason: string };

export const ASPECT_TOLERANCE = 0.03;
const APPAREL_MIN = { width: 3000, height: 3600 };
const APPAREL = new Set(["tshirt", "sweatshirt", "hoodie"]);

const aspect = (s: Size) => s.width / s.height;
const off = (a: number, b: number) => Math.abs(a - b) / b;
const covers = (file: Size, area: Size) => file.width >= area.width && file.height >= area.height;

export function assignPrintFile(preset: string, area: Size, master: Size, a3: Size): PrintFileChoice {
  if (preset === "mug") return { file: "none", reason: "mug held: no mug-wrap file" };
  const target = aspect(area);
  const candidates = ([["a3", a3], ["master", master]] as const)
    .map(([file, size]) => ({ file, size, off: off(aspect(size), target) }))
    .sort((x, y) => x.off - y.off);
  const best = candidates[0];
  if (best.off <= ASPECT_TOLERANCE) {
    if (!covers(best.size, area)) return { file: "none", reason: `${best.file} ${best.size.width}×${best.size.height} does not cover print area ${area.width}×${area.height}` };
    return { file: best.file, reason: `${best.file} aspect ${(best.off * 100).toFixed(1)}% off print area ${area.width}×${area.height}` };
  }
  if (APPAREL.has(preset)) {
    const scale = Math.min(area.width / master.width, area.height / master.height, 1);
    const fit = { width: Math.floor(master.width * scale), height: Math.floor(master.height * scale) };
    if (fit.width >= APPAREL_MIN.width && fit.height >= APPAREL_MIN.height) {
      return { file: "padded", fit, reason: `4:5 master fitted ${fit.width}×${fit.height} inside ${area.width}×${area.height} with transparent padding` };
    }
    return { file: "none", reason: `fitted art ${fit.width}×${fit.height} below apparel minimum` };
  }
  return { file: "none", reason: `held: both files >${ASPECT_TOLERANCE * 100}% off print area aspect ${target.toFixed(3)}` };
}
