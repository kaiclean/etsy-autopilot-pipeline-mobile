export const TZ = "Europe/Zurich";

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD in Swiss local time. */
export function dayKey(d: Date) {
  return dayFmt.format(d);
}

/** Swiss grouping (1’234.50) without Intl, whose output differs between Node and browser ICU builds. */
function group(abs: number, digits: number) {
  const [int, frac] = abs.toFixed(digits).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, "’");
  return frac ? `${grouped}.${frac}` : grouped;
}

export function chf(n: number, opts: { compact?: boolean; sign?: boolean } = {}) {
  const abs = Math.abs(n);
  const digits = opts.compact && abs >= 1000 ? 0 : 2;
  const sign = n < 0 ? "−" : opts.sign && n > 0 ? "+" : "";
  return `${sign}CHF ${group(abs, digits)}`;
}

export function num(n: number) {
  return `${n < 0 ? "−" : ""}${group(Math.abs(Math.round(n)), 0)}`;
}

export function pct(n: number, digits = 1) {
  return `${n.toFixed(digits)}%`;
}

export function relTime(d: Date | string, now = Date.now()) {
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString("de-CH", { day: "numeric", month: "short", timeZone: TZ });
}

export function shortDate(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const FLAGS: Record<string, string> = {
  US: "United States", DE: "Germany", GB: "United Kingdom", CH: "Switzerland", CA: "Canada",
  AU: "Australia", FR: "France", NL: "Netherlands", AT: "Austria", SE: "Sweden",
};

export function countryName(code: string) {
  return FLAGS[code] ?? code;
}

export function flag(code: string) {
  if (!/^[A-Z]{2}$/.test(code)) return "🌐";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
