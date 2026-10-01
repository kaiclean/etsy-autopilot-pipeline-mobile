import type { StageName } from "@/db/schema";
import type { HealthLevel } from "@/lib/health";
import type { PublishMode } from "@/lib/publish-mode";

export type AttentionSeverity = "blocker" | "watch";

export type AttentionItem = {
  id: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  href: string;
  hrefLabel: string;
};

export type StageSnapshot = {
  id: StageName;
  label: string;
  paused: boolean;
  cron: string;
  lastStatus: "running" | "success" | "failed" | "skipped" | null;
  lastStartedAt: string | null;
  lastSummary: string | null;
};

export type HealthFact = {
  id: string;
  name: string;
  level: HealthLevel;
  detail: string;
};

export type NextActionInput = {
  etsyConnected: boolean;
  etsyKeysReady: boolean;
  printifyConfigured: boolean;
  webhookSecretSet: boolean;
  printifyEventCount: number;
  killSwitch: boolean;
  publishMode: PublishMode;
  stages: StageSnapshot[];
  checks: HealthFact[];
};

const ETSY_BILLING =
  "Etsy shop billing onboarding blocks Shop Manager until Etsy finishes it, so OAuth cannot complete while that gate is closed.";

/** Red checks already explained by a dedicated item. */
const COVERED_HEALTH = new Set(["etsy", "publish", "printify"]);

export function toStageSnapshots(
  lastRuns: {
    id: StageName;
    label: string;
    run: { status: "running" | "success" | "failed" | "skipped"; startedAt: Date | string; summary: string | null } | null;
  }[],
  stageSettings: Record<StageName, { paused: boolean; cron: string }>,
): StageSnapshot[] {
  return lastRuns.map((stage) => ({
    id: stage.id,
    label: stage.label,
    paused: stageSettings[stage.id]?.paused ?? false,
    cron: stageSettings[stage.id]?.cron ?? "",
    lastStatus: stage.run?.status ?? null,
    lastStartedAt: stage.run ? new Date(stage.run.startedAt).toISOString() : null,
    lastSummary: stage.run?.summary ?? null,
  }));
}

/**
 * Operational blockers derived from stored facts and connection health.
 * Dry-run is the safe default and is not listed. Nothing here probes Etsy or Printify.
 */
export function buildNextActions(input: NextActionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (!input.etsyConnected) {
    items.push({
      id: "etsy-oauth",
      severity: "blocker",
      title: "Etsy OAuth not connected",
      detail: input.etsyKeysReady
        ? `App keys are set, but OAuth tokens are missing. ${ETSY_BILLING} Connect the shop once Shop Manager is available. Publishing stays dry-run.`
        : `OAuth tokens are missing, and the Etsy app keys are not all set. ${ETSY_BILLING} Set the four Etsy variables, then connect. Publishing stays dry-run.`,
      href: "/connections",
      hrefLabel: "Open Connections",
    });
  }

  if (input.printifyConfigured && !input.webhookSecretSet) {
    items.push({
      id: "printify-webhook-secret",
      severity: "blocker",
      title: "Printify webhook secret is missing",
      detail: "PRINTIFY_WEBHOOK_SECRET is unset, so production rejects unsigned deliveries. The secret value is never shown. Register the callback on Connections.",
      href: "/connections#printify-webhook",
      hrefLabel: "Webhook setup",
    });
  } else if ((input.printifyConfigured || input.webhookSecretSet) && input.printifyEventCount === 0) {
    items.push({
      id: "printify-webhook-quiet",
      severity: "watch",
      title: "Printify webhook not receiving events",
      detail: "No rows are stored in printify_events. That is a database count, not a live Printify status. Register the callback and topics, and keep the secret matched.",
      href: "/connections#printify-webhook",
      hrefLabel: "Webhook setup",
    });
  }

  const ran = input.stages.filter((stage) => stage.lastStartedAt);
  const failed = input.stages.filter((stage) => stage.lastStatus === "failed");
  const never = input.stages.filter((stage) => !stage.lastStartedAt && !stage.paused);
  if (input.stages.length > 0 && ran.length === 0) {
    items.push({
      id: "cron-never",
      severity: "watch",
      title: "Cron has never run",
      detail: "No job_runs are stored for any stage. Railway does not run these schedules. GitHub Actions does, after the CRON_SECRET repository secret is set, or any caller can hit /api/cron/<stage>.",
      href: "/connections#cron",
      hrefLabel: "Cron setup",
    });
  } else {
    if (failed.length > 0) {
      items.push({
        id: "cron-failed",
        severity: "blocker",
        title: failed.length === 1 ? `${failed[0].label} last run failed` : "A stage last run failed",
        detail: `${failed.map((stage) => stage.label).join(", ")} failed on the last stored job run. This comes from job_runs, not a live scheduler probe.`,
        href: "/connections#cron",
        hrefLabel: "Review stages",
      });
    }
    if (never.length > 0) {
      items.push({
        id: "cron-partial",
        severity: "watch",
        title: "Some stages have never run",
        detail: `${never.map((stage) => stage.label).join(", ")} have no stored job run. Railway needs an external scheduler calling /api/cron/<stage>.`,
        href: "/connections#cron",
        hrefLabel: "Cron setup",
      });
    }
  }

  if (input.killSwitch) {
    items.push({
      id: "kill-switch",
      severity: "blocker",
      title: "Automation is paused",
      detail: "The kill switch is on, so scheduled and manual stages do not generate, publish, or sync.",
      href: "/settings",
      hrefLabel: "Open Settings",
    });
  }

  if (input.publishMode === "live") {
    items.push({
      id: "publish-live",
      severity: "watch",
      title: "Live writes are armed",
      detail: "The dashboard publish choice is live, so the next publish run can call Etsy and Printify. Return to dry-run from Connections. Host PUBLISH_MODE does not change that choice by itself.",
      href: "/connections",
      hrefLabel: "Open Connections",
    });
  }

  for (const check of input.checks) {
    if (check.level !== "red" || COVERED_HEALTH.has(check.id)) continue;
    items.push({
      id: `health-${check.id}`,
      severity: "blocker",
      title: `${check.name} needs a fix`,
      detail: check.detail,
      href: "/connections#setup",
      hrefLabel: "Setup guide",
    });
  }

  return items;
}
