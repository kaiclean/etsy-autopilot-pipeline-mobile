import { ExternalLink, Flame } from "lucide-react";
import { Panel, SectionTitle } from "@/components/common";
import { TZ } from "@/lib/format";
import type { HotProvider } from "@/pipeline/hot-signals/types";

export interface HotTodayItem {
  phrase: string;
  score: number;
  providers: {
    provider: HotProvider;
    rank: number | null;
    badge: string | null;
    labelText: string | null;
    metric: number | null;
    sourceUrl: string;
    fetchedAt: Date | string | null;
  }[];
}

const PROVIDER_LABELS: Record<HotProvider, string> = {
  amazon: "Amazon",
  etsy: "Etsy",
  "google-trends": "Google Trends",
  pinterest: "Pinterest",
};

const PROVIDER_HOSTS: Record<HotProvider, readonly string[]> = {
  amazon: ["amazon.com", "amazon.de", "amazon.co.uk", "amazon.fr", "amazon.it", "amazon.es", "amazon.ca", "amazon.com.au", "amazon.co.jp", "amazon.in"],
  etsy: ["etsy.com"],
  "google-trends": ["trends.google.com"],
  pinterest: ["pinterest.com"],
};

export function safeHotSourceUrl(sourceUrl: string, provider: HotProvider, demo = false): string | null {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (url.hostname === "example.invalid") return demo && url.pathname.startsWith("/hot/") ? url.href : null;
    return PROVIDER_HOSTS[provider]?.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null;
  } catch {
    return null;
  }
}

function observedTime(value: Date | string | null) {
  if (value == null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    text: new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date),
  };
}

function observedNumber(value: number | null) {
  return value != null && Number.isFinite(value) ? String(value) : "—";
}

export function HotTodayCard({ items, demo = false, observedDay }: {
  items: HotTodayItem[];
  demo?: boolean;
  observedDay: string;
}) {
  return (
    <section aria-label="Top 10 today">
      <SectionTitle action={<span className="text-[11px] text-muted-foreground">{observedDay} · Zurich</span>}>
        <span className="inline-flex items-center gap-1.5"><Flame className="size-3.5 text-primary" /> Top 10 today</span>
      </SectionTitle>
      <Panel className="overflow-hidden">
        <div className="border-b border-border p-4">
          <p className="text-xs text-muted-foreground">
            {demo ? "Demo fixture — not live demand" : "Marketplace and search signals observed today in Europe/Zurich."}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            24h sales: — · Sales counts unavailable. Rank, badges and search interest are not sales.
          </p>
        </div>
        {items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No observed signals today. Yesterday&apos;s cached signals are not shown as today&apos;s demand.</p>
        ) : (
          <ol className="divide-y divide-border">
            {items.slice(0, 10).map((item) => (
              <li key={item.phrase} className="p-4">
                <h3 className="text-sm font-semibold">{item.phrase}</h3>
                <ul className="mt-2 space-y-2">
                  {item.providers.map((evidence, index) => {
                    const href = safeHotSourceUrl(evidence.sourceUrl, evidence.provider, demo);
                    const observed = demo ? null : observedTime(evidence.fetchedAt);
                    return (
                      <li key={`${evidence.provider}:${index}`} className="rounded-lg bg-muted/40 p-2 text-[11px] text-muted-foreground">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-foreground">{PROVIDER_LABELS[evidence.provider]}</span>
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary" aria-label={`${PROVIDER_LABELS[evidence.provider]} source for ${item.phrase}`}>
                              {demo ? "Fixture source" : "Source"} <ExternalLink className="size-3" />
                            </a>
                          ) : <span>Source unavailable</span>}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                          <span>Rank {observedNumber(evidence.rank)}</span>
                          <span>Badge {evidence.badge || "—"}</span>
                          <span>Label {evidence.labelText || "—"}</span>
                          <span>Metric {observedNumber(evidence.metric)}</span>
                        </div>
                        <div className="mt-1">
                          {demo ? "Fixture — no live observation" : <>Observed {observed ? <time dateTime={observed.iso}>{observed.text} Zurich</time> : "—"}</>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </section>
  );
}
