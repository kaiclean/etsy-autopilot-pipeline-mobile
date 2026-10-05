import type { Niche } from "@/db/schema";
import { NICHE_LIST } from "@/lib/niches";

export type KeywordCandidate = {
  phrase: string;
  niche: Niche;
  source: string;
  demand: number;
  competition: number;
  /** Raw Etsy search volume when this candidate was measured rather than seeded. */
  searchVolume?: number;
};

/**
 * A pluggable keyword source. Seed lists, long-tail expansion, env seeds, and Etsy
 * Marketplace Insights exports (see etsy-demand.ts) all implement this.
 */
export interface KeywordSource {
  readonly name: string;
  collect(): Promise<KeywordCandidate[]>;
}

export const seedListSource: KeywordSource = {
  name: "seed-list",
  async collect() {
    return NICHE_LIST.flatMap((n) =>
      n.seeds.map((s) => ({ phrase: s.phrase, niche: n.id, source: "seed-list", demand: s.demand, competition: s.competition })),
    );
  },
};

/** Parses KEYWORD_SEEDS="niche:phrase|demand|competition;..." so Kai can add keywords without a deploy. */
export const envSeedSource: KeywordSource = {
  name: "env-seeds",
  async collect() {
    const raw = process.env.KEYWORD_SEEDS ?? "";
    return raw
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const [nichePart, rest] = entry.split(":");
        const [phrase, d, c] = (rest ?? "").split("|");
        const niche = nichePart as Niche;
        if (!phrase || !NICHE_LIST.some((n) => n.id === niche)) return [];
        return [{ phrase: phrase.trim().toLowerCase(), niche, source: "env-seeds", demand: Number(d ?? 0.5), competition: Number(c ?? 0.5) }];
      });
  },
};

const LONG_TAIL: Record<Niche, string[]> = {
  alpine: ["set of 3", "for living room", "vintage style", "boho neutral", "gift for hiker"],
  gothic: ["vintage", "for her", "oversized", "cottagecore", "fall 2026"],
  christmas: ["for grandma", "hygge", "vintage", "minimalist", "gift for mom"],
  birthday: ["template", "for girls", "evite", "printable", "pastel"],
  stream: ["pastel", "cozy", "retro", "minimal", "for vtubers"],
};

/**
 * Long-tail expansion (Etsy-autocomplete style): seed phrase + modifier.
 * Long-tail phrases get slightly lower demand and noticeably lower competition, per eRank guidance.
 */
export const longTailSource: KeywordSource = {
  name: "long-tail",
  async collect() {
    return NICHE_LIST.flatMap((n) =>
      n.seeds.flatMap((s, i) =>
        LONG_TAIL[n.id].map((mod, j) => ({
          phrase: `${s.phrase} ${mod}`,
          niche: n.id,
          source: "long-tail",
          demand: Math.round(s.demand * (0.72 + ((i + j) % 4) * 0.05) * 100) / 100,
          competition: Math.round(s.competition * (0.55 + ((i * 3 + j) % 5) * 0.06) * 100) / 100,
        })),
      ),
    );
  },
};

export const KEYWORD_SOURCES: KeywordSource[] = [seedListSource, longTailSource, envSeedSource];

/**
 * Google Trends relative interest (0-1) for the last 90 days, US.
 * Unofficial endpoint: frequently rate-limited, so failures return null and the caller falls back.
 */
export async function googleTrendScore(phrase: string, timeoutMs = 6000): Promise<number | null> {
  try {
    type GT = { interestOverTime(opts: { keyword: string; startTime: Date; geo: string }): Promise<string> };
    const mod = (await import("google-trends-api")) as { default?: GT } & GT;
    const gt: GT = mod.default ?? mod;
    const raw: string = await Promise.race([
      gt.interestOverTime({ keyword: phrase, startTime: new Date(Date.now() - 90 * 864e5), geo: "US" }),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    const data = JSON.parse(raw) as { default?: { timelineData?: { value?: number[] }[] } };
    const values = (data.default?.timelineData ?? []).map((d) => Number(d.value?.[0] ?? 0));
    if (values.length < 4) return null;
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const recent = avg(values.slice(-4));
    const overall = avg(values) || 1;
    const momentum = Math.min(1, Math.max(0, recent / overall / 2));
    return Math.round((0.6 * (recent / 100) + 0.4 * momentum) * 100) / 100;
  } catch {
    return null;
  }
}
