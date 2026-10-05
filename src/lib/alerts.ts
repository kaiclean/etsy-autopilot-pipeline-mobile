import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { jobRuns, listings } from "@/db/schema";
import { listingNeedsEtsyId } from "@/lib/catalog-filters";
import { visible } from "@/lib/events";
import type { EtsyTokens } from "@/lib/settings";

export type AlertSeverity = "blocker" | "watch" | "info";

export type CockpitAlert = {
  id: string;
  severity: AlertSeverity;
  title: string;
  evidence: string;
  href: string;
  hrefLabel: string;
};

export type CronRunFact = {
  stage: string;
  status: string;
  summary: string | null;
  logs: { msg: string }[];
};

const OAUTH_EXPIRY_WINDOW_MS = 48 * 60 * 60 * 1000;

export function countMissingEtsyIds(rows: { etsyListingId: string | null; imageUrl: string | null }[]) {
  return rows.filter(listingNeedsEtsyId).length;
}

export async function countListingsMissingEtsyId(db: DB) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(listings)
    .where(and(visible(listings.isDemo), sql`${listings.etsyListingId} is null`, sql`length(trim(${listings.imageUrl})) > 0`));
  return Number(row?.n ?? 0);
}

export function railwayDeploySha(
  env: { RAILWAY_GIT_COMMIT_SHA?: string; RAILWAY_DEPLOYMENT_ID?: string; [key: string]: string | undefined } = process.env,
): string | null {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  return sha || null;
}

export function cronRunIsUnauthorized(run: { summary: string | null; logs: { msg: string }[] }) {
  const blob = `${run.summary ?? ""}\n${run.logs.map((line) => line.msg).join("\n")}`;
  return /\b401\b|unauthorized/i.test(blob);
}

/** Latest cron run per stage. `runs` must be newest first. */
export function latestCronRuns<T extends { stage: string }>(runs: T[]): T[] {
  const seen = new Set<string>();
  const latest: T[] = [];
  for (const run of runs) {
    if (seen.has(run.stage)) continue;
    seen.add(run.stage);
    latest.push(run);
  }
  return latest;
}

export function buildCockpitAlerts(input: {
  cronRuns: CronRunFact[];
  nullEtsyIdCount: number;
  deploySha: string | null;
  tokens: Pick<EtsyTokens, "accessToken" | "expiresAt"> | null;
  now?: number;
  killSwitch: boolean;
  catalogDraftPending: boolean;
}): CockpitAlert[] {
  const now = input.now ?? Date.now();
  const alerts: CockpitAlert[] = [];
  const latest = latestCronRuns(input.cronRuns);
  const unauthorized = latest.find((run) => run.status === "failed" && cronRunIsUnauthorized(run));
  const failed = latest.find((run) => run.status === "failed");

  if (unauthorized) {
    alerts.push({
      id: "cron-401",
      severity: "blocker",
      title: "Cron stage reported unauthorized / 401",
      evidence: `${unauthorized.stage} recorded an authorization error during execution, not at the cron endpoint. ${unauthorized.summary ?? "No summary stored."}`,
      href: "/connections#cron",
      hrefLabel: "Open cron",
    });
  } else if (failed) {
    alerts.push({
      id: "cron-secret",
      severity: "watch",
      title: "Cron run failed",
      evidence: `Last failed cron stage: ${failed.stage}. Inspect the run logs; endpoint CRON_SECRET failures are not recorded as job runs.`,
      href: "/connections#cron",
      hrefLabel: "Open cron",
    });
  }

  if (input.nullEtsyIdCount > 0) {
    alerts.push({
      id: "null-etsy-id",
      severity: "watch",
      title: "Listings missing an Etsy id",
      evidence: `${input.nullEtsyIdCount} listing${input.nullEtsyIdCount === 1 ? "" : "s"} have media and a null etsy_listing_id.`,
      href: "/products?triage=needs_etsy_id",
      hrefLabel: "Review products",
    });
  }

  if (input.deploySha) {
    const short = input.deploySha.slice(0, 7);
    alerts.push({
      id: "deploy-pin",
      severity: "info",
      title: "Railway deployed commit",
      evidence: `Running commit ${short}. Commit metadata alone does not indicate whether automatic deploys are enabled.`,
      href: "/connections#deploy",
      hrefLabel: "Open deploy pin",
    });
  }

  if (!input.tokens?.accessToken) {
    alerts.push({
      id: "oauth-missing",
      severity: "blocker",
      title: "Etsy OAuth tokens missing",
      evidence: "etsyTokens has no access token. Shop reads stay unauthorized until the shop is connected.",
      href: "/connections",
      hrefLabel: "Open connections",
    });
  } else if (input.tokens.expiresAt - now < OAUTH_EXPIRY_WINDOW_MS) {
    const hours = Math.max(0, Math.round((input.tokens.expiresAt - now) / 36e5));
    alerts.push({
      id: "oauth-expiry",
      severity: "watch",
      title: "Etsy access token expires soon",
      evidence: `Access token expiry is inside 48 hours (${hours}h left). Refresh still uses the stored refresh token.`,
      href: "/connections",
      hrefLabel: "Open connections",
    });
  }

  if (input.killSwitch) {
    alerts.push({
      id: "kill-switch",
      severity: "blocker",
      title: "Kill switch is on",
      evidence: "automation.killSwitch is true. Scheduled stages skip until it is turned off.",
      href: "/settings",
      hrefLabel: "Open settings",
    });
  }

  if (input.catalogDraftPending) {
    alerts.push({
      id: "catalog-draft",
      severity: "watch",
      title: "Catalog draft is pending",
      evidence: "Meridian catalog order (2026-10-05) is not marked reviewed. Nothing is applied to Etsy.",
      href: "/products#catalog-draft",
      hrefLabel: "Open catalog draft",
    });
  }

  return alerts;
}

export async function loadCronRunFacts(db: DB): Promise<CronRunFact[]> {
  const rows = await db
    .select({
      stage: jobRuns.stage,
      status: jobRuns.status,
      summary: jobRuns.summary,
      logs: jobRuns.logs,
    })
    .from(jobRuns)
    .where(and(eq(jobRuns.trigger, "cron"), visible(jobRuns.isDemo)))
    .orderBy(desc(jobRuns.id))
    .limit(80);
  return rows.map((row) => ({
    stage: row.stage,
    status: row.status,
    summary: row.summary,
    logs: row.logs ?? [],
  }));
}
