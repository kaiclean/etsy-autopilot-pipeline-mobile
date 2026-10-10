import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { jobRuns, listings } from "@/db/schema";
import { listingNeedsEtsyId } from "@/lib/catalog-filters";
import { visible } from "@/lib/events";
import { isProviderCreditsError } from "@/lib/provider-errors";
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

export type PublishFailureFact = {
  id: number;
  title: string;
  publishError: string;
};

/** Published rows are the ones that should already have an Etsy id. Rejected and failed rows are not. */
const ETSY_ID_EXPECTED = new Set(["published"]);

export function listingShouldHaveEtsyId(row: { status?: string | null; etsyListingId: string | null; imageUrl: string | null }) {
  if (!row.status || !ETSY_ID_EXPECTED.has(row.status)) return false;
  return listingNeedsEtsyId(row);
}

export function countMissingEtsyIds(rows: { status?: string | null; etsyListingId: string | null; imageUrl: string | null }[]) {
  return rows.filter(listingShouldHaveEtsyId).length;
}

export async function countListingsMissingEtsyId(db: DB) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(listings)
    .where(
      and(
        visible(listings.isDemo),
        eq(listings.status, "published"),
        sql`${listings.etsyListingId} is null`,
        sql`length(trim(${listings.imageUrl})) > 0`,
      ),
    );
  return Number(row?.n ?? 0);
}

export function railwayDeploySha(
  env: { RAILWAY_GIT_COMMIT_SHA?: string; RAILWAY_DEPLOYMENT_ID?: string; [key: string]: string | undefined } = process.env,
): string | null {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  return sha || null;
}

export function cronRunText(run: { summary: string | null; logs: { msg: string }[] }) {
  return `${run.summary ?? ""}\n${run.logs.map((line) => line.msg).join("\n")}`;
}

export function cronRunIsUnauthorized(run: { summary: string | null; logs: { msg: string }[] }) {
  return /\b401\b|unauthorized/i.test(cronRunText(run));
}

export function cronRunIsCreditsError(run: { summary: string | null; logs: { msg: string }[] }) {
  return isProviderCreditsError(cronRunText(run));
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
  tokens: (Pick<EtsyTokens, "accessToken" | "expiresAt"> & { refreshToken?: string | null; refreshError?: string | null }) | null;
  now?: number;
  killSwitch: boolean;
  catalogDraftPending: boolean;
  publishFailures?: PublishFailureFact[];
}): CockpitAlert[] {
  const alerts: CockpitAlert[] = [];
  const latest = latestCronRuns(input.cronRuns);
  const unauthorized = latest.find((run) => run.status === "failed" && cronRunIsUnauthorized(run));
  const credits = latest.find((run) => (run.status === "failed" || run.status === "warning") && cronRunIsCreditsError(run));
  const failed = latest.find((run) => run.status === "failed");
  const warned = latest.find((run) => run.status === "warning");

  if (credits) {
    alerts.push({
      id: "image-credits",
      severity: credits.status === "failed" ? "blocker" : "watch",
      title: "Image provider out of credits",
      evidence: `${credits.stage} stopped because the image provider returned 402 Insufficient credits. ${credits.summary ?? ""}`.trim(),
      href: "/pipeline/live",
      hrefLabel: "Open live log",
    });
  }

  if (unauthorized && unauthorized !== credits) {
    alerts.push({
      id: "cron-401",
      severity: "blocker",
      title: "Cron stage reported unauthorized / 401",
      evidence: `${unauthorized.stage} recorded an authorization error during execution, not at the cron endpoint. ${unauthorized.summary ?? "No summary stored."}`,
      href: "/connections#cron",
      hrefLabel: "Open cron",
    });
  } else if (failed && failed !== credits) {
    alerts.push({
      id: "cron-secret",
      severity: "watch",
      title: "Cron run failed",
      evidence: `Last failed cron stage: ${failed.stage}. Inspect the run logs; endpoint CRON_SECRET failures are not recorded as job runs.`,
      href: "/pipeline/live",
      hrefLabel: "Open live log",
    });
  }

  if (warned && warned !== credits) {
    alerts.push({
      id: "cron-warning",
      severity: "watch",
      title: "Pipeline run finished with warnings",
      evidence: `${warned.stage} produced only part of its intended output. ${warned.summary ?? "Open the live log for the error lines."}`.trim(),
      href: "/pipeline/live",
      hrefLabel: "Open live log",
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
  } else if ("refreshToken" in input.tokens && !input.tokens.refreshToken) {
    alerts.push({
      id: "oauth-refresh",
      severity: "blocker",
      title: "Etsy refresh token missing",
      evidence: "The access token is stored, but the refresh token is missing. Shop reads fail once that access token expires. Token values are hidden.",
      href: "/connections",
      hrefLabel: "Open connections",
    });
  } else if (input.tokens.refreshError) {
    alerts.push({
      id: "oauth-refresh",
      severity: "blocker",
      title: "Etsy token refresh failed",
      evidence: "The last Etsy token refresh failed. Shop reads stay unauthorized until the shop is connected again. Token values are hidden.",
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

  for (const row of input.publishFailures ?? []) {
    alerts.push({
      id: `publish-error-${row.id}`,
      severity: "watch",
      title: `Publish failed · ${row.title}`,
      evidence: row.publishError,
      href: "/products",
      hrefLabel: "Open products",
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

export async function loadPublishFailures(db: DB): Promise<PublishFailureFact[]> {
  const rows = await db
    .select({ id: listings.id, title: listings.title, publishError: listings.publishError })
    .from(listings)
    .where(and(eq(listings.status, "failed"), isNotNull(listings.publishError), visible(listings.isDemo)))
    .orderBy(desc(listings.updatedAt))
    .limit(8);
  return rows.flatMap((row) => (row.publishError ? [{ id: row.id, title: row.title, publishError: row.publishError }] : []));
}
