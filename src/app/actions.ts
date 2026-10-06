"use server";

import { eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb, type DB } from "@/db";
import { listings, type Listing, type StageName } from "@/db/schema";
import { passwordMatches, createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";
import { config } from "@/lib/config";
import { emit } from "@/lib/events";
import { calculateFees, MARGIN_TARGETS, priceFloorIssue } from "@/lib/fees";
import { resolveUsdToChf } from "@/lib/fee-schedule";
import { planBulkStatus } from "@/lib/catalog-filters";
import { validateListing } from "@/lib/listing-validator";
import { requireAuth } from "@/lib/session";
import { goLiveDecision, type PublishMode } from "@/lib/publish-mode";
import type { PushPrefs } from "@/lib/push-prefs";
import { DEFAULT_CATALOG_DRAFT, getSetting, setSetting, type AutomationSettings } from "@/lib/settings";
import {
  activateDigitalListing,
  markDeliveryVerified,
  publishPodListingToEtsy,
  recordDeliveryManifest,
  recordPodSample,
} from "@/pipeline/human-publish";
import { runFullPipeline, runStage } from "@/pipeline/runner";
import { isStage } from "@/pipeline/types";

export async function login(_prev: { error?: string } | undefined, form: FormData) {
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/");
  const secret = config.authSecret;
  if (!secret || !config.dashboardPassword) {
    return { error: "Server is missing DASHBOARD_PASSWORD / AUTH_SECRET." };
  }
  if (!(await passwordMatches(password, config.dashboardPassword, secret))) {
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Wrong password." };
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await createSessionToken(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logout() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

function revalidateAll() {
  revalidatePath("/", "layout");
}

export type ListingEdit = { title: string; tags: string[]; priceChf: number; description?: string };

async function pricingContext(db: DB) {
  const [automation, feeFx] = await Promise.all([getSetting(db, "automation"), getSetting(db, "feeFx")]);
  return { automation, usdToChf: resolveUsdToChf({ stored: feeFx?.usdToChf, storedAsOf: feeFx?.asOf }).rate };
}

function floorFor(listing: Pick<Listing, "priceChf" | "productType" | "podCostChf">, offsiteAds: boolean, usdToChf: number) {
  return priceFloorIssue({
    priceChf: listing.priceChf,
    productType: listing.productType,
    podCostChf: listing.podCostChf,
    offsiteAds,
    usdToChf,
  });
}

export async function updateListing(id: number, edit: ListingEdit, approve = false) {
  await requireAuth();
  const db = await getDb();
  const [l] = await db.select().from(listings).where(eq(listings.id, id));
  if (!l) return { ok: false as const, error: "Listing not found" };
  const next = { ...l, ...edit, description: edit.description ?? l.description };
  const { valid, issues: textIssues } = validateListing(next);
  const { automation, usdToChf } = await pricingContext(db);
  const floor = floorFor({ ...l, priceChf: next.priceChf }, automation.assumeOffsiteAds, usdToChf);
  const issues = floor ? [...textIssues, floor] : textIssues;
  const fees = calculateFees({ priceChf: next.priceChf, podCostChf: l.podCostChf, offsiteAds: automation.assumeOffsiteAds, usdToChf });
  const canApprove = approve && valid && !floor;
  await db
    .update(listings)
    .set({
      title: next.title,
      tags: next.tags,
      description: next.description,
      priceChf: next.priceChf,
      netChf: fees.netChf,
      marginPct: fees.marginPct,
      validation: issues,
      updatedAt: new Date(),
      ...(canApprove ? { status: "approved" as const, approvedAt: new Date() } : {}),
    })
    .where(eq(listings.id, id));
  revalidateAll();
  if (approve && (!valid || floor)) return { ok: false as const, error: floor?.message ?? "Fix validation errors before approving", issues };
  return { ok: true as const, issues };
}

export async function setListingStatus(id: number, status: "approved" | "rejected" | "pending_approval", reason?: string) {
  await requireAuth();
  const db = await getDb();
  const [l] = await db.select().from(listings).where(eq(listings.id, id));
  if (!l) return { ok: false as const, error: "Listing not found" };
  if (status === "approved") {
    const { automation, usdToChf } = await pricingContext(db);
    const floor = floorFor(l, automation.assumeOffsiteAds, usdToChf);
    const { valid, issues } = validateListing(l);
    const all = floor ? [...issues, floor] : issues;
    if (!valid || floor) {
      await db.update(listings).set({ validation: all }).where(eq(listings.id, id));
      revalidateAll();
      return { ok: false as const, error: floor?.message ?? all.find((i) => i.severity === "error")?.message ?? "Invalid listing" };
    }
  }
  await db
    .update(listings)
    .set({
      status,
      rejectedReason: status === "rejected" ? reason ?? "Rejected in review" : null,
      approvedAt: status === "approved" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(listings.id, id));
  if (status !== "pending_approval") {
    await emit(db, {
      type: `listing.${status}`,
      title: `${status === "approved" ? "Approved" : "Rejected"}: ${l.title.slice(0, 48)}…`,
      severity: status === "approved" ? "success" : "info",
      href: status === "approved" ? "/products" : "/queue",
    });
  }
  revalidateAll();
  return { ok: true as const };
}

export async function bulkSetListingStatus(ids: number[], status: "approved" | "rejected" | "pending_approval") {
  await requireAuth();
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);
  if (unique.length === 0) return { ok: false as const, error: "Select at least one listing" };
  const db = await getDb();
  const { automation, usdToChf } = await pricingContext(db);
  const rows = await db.select().from(listings).where(inArray(listings.id, unique));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const known = unique.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  const missing = unique.filter((id) => !byId.has(id)).map((id) => ({ id, title: `#${id}`, error: "Listing not found" }));
  const plan = planBulkStatus(
    known.map((row) => {
      const text = validateListing(row);
      const floor = status === "approved" ? floorFor(row, automation.assumeOffsiteAds, usdToChf) : null;
      return {
        id: row.id,
        title: row.title,
        hasErrors: status === "approved" && (!text.valid || Boolean(floor)),
        error: floor?.message ?? text.issues.find((issue) => issue.severity === "error")?.message,
      };
    }),
    status,
  );
  for (const skip of plan.skipped) {
    const row = byId.get(skip.id);
    if (!row) continue;
    const text = validateListing(row);
    const floor = floorFor(row, automation.assumeOffsiteAds, usdToChf);
    await db
      .update(listings)
      .set({ validation: floor ? [...text.issues, floor] : text.issues, updatedAt: new Date() })
      .where(eq(listings.id, row.id));
  }
  if (plan.changed.length > 0) {
    await db
      .update(listings)
      .set({
        status,
        rejectedReason: status === "rejected" ? "Rejected in review" : null,
        approvedAt: status === "approved" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(inArray(listings.id, plan.changed));
  }
  if (status !== "pending_approval" && plan.changed.length > 0) {
    const verb = status === "approved" ? "Approved" : "Rejected";
    await emit(db, {
      type: `listing.${status}`,
      title: `${verb} ${plan.changed.length} listing${plan.changed.length === 1 ? "" : "s"}`,
      body: plan.skipped.length > 0 ? `${plan.skipped.length} still need validation fixes` : undefined,
      severity: status === "approved" ? "success" : "info",
      href: status === "approved" ? "/products" : "/queue",
    });
  }
  revalidateAll();
  return {
    ok: true as const,
    changed: plan.changed,
    skipped: [...plan.skipped, ...missing].map((row) => ({ ...row, title: row.title.slice(0, 80) })),
  };
}

export async function savePushPrefs(patch: Partial<PushPrefs>) {
  await requireAuth();
  const db = await getDb();
  const current = await getSetting(db, "pushPrefs");
  const next = { ...current };
  for (const key of ["order.new", "approval.pending", "job.failed"] as const) {
    if (typeof patch[key] === "boolean") next[key] = patch[key];
  }
  await setSetting(db, "pushPrefs", next);
  revalidateAll();
  return { ok: true as const, pushPrefs: next };
}

export async function triggerStage(stage: string) {
  await requireAuth();
  if (!isStage(stage)) return { ok: false as const, error: "Unknown stage" };
  const run = await runStage(stage as StageName, "manual");
  revalidateAll();
  return { ok: run.status !== "failed", status: run.status, summary: run.summary };
}

export async function triggerFullPipeline() {
  await requireAuth();
  const runs = await runFullPipeline("manual");
  revalidateAll();
  return runs.map((r) => ({ stage: r.stage, status: r.status, summary: r.summary }));
}

export async function setStagePaused(stage: string, paused: boolean) {
  await requireAuth();
  if (!isStage(stage)) return;
  const db = await getDb();
  const stages = await getSetting(db, "stages");
  stages[stage] = { ...stages[stage], paused };
  await setSetting(db, "stages", stages);
  await emit(db, { type: "stage.toggle", title: `${stage[0].toUpperCase()}${stage.slice(1)} ${paused ? "paused" : "resumed"}`, severity: "info", href: "/pipeline" });
  revalidateAll();
}

export async function setKillSwitch(on: boolean) {
  await requireAuth();
  const db = await getDb();
  const a = await getSetting(db, "automation");
  await setSetting(db, "automation", { ...a, killSwitch: on });
  await emit(db, {
    type: "killswitch",
    title: on ? "Kill switch ON: all automation paused" : "Automation resumed",
    severity: on ? "error" : "success",
    href: "/settings",
  });
  revalidateAll();
}

export async function setPublishMode(mode: PublishMode, confirmation = "", understood = false) {
  await requireAuth();
  const decision = goLiveDecision({ mode, confirmation, understood });
  if (!decision.ok) return decision;
  const db = await getDb();
  const a = await getSetting(db, "automation");
  await setSetting(db, "automation", { ...a, publishMode: decision.mode });
  await emit(db, {
    type: "publish.mode",
    title: decision.mode === "live" ? "Go live confirmed" : "Returned to dry-run",
    body: decision.mode === "live" ? "Etsy and Printify writes are armed." : "Live writes are off.",
    severity: decision.mode === "live" ? "warning" : "success",
    href: "/connections",
  });
  revalidateAll();
  return { ok: true as const, publishMode: decision.mode };
}

export async function readDeliveryFile(id: number) {
  await requireAuth();
  const db = await getDb();
  const result = await recordDeliveryManifest(db, id);
  revalidateAll();
  return result;
}

export async function verifyDeliveryFile(id: number) {
  await requireAuth();
  const db = await getDb();
  const result = await markDeliveryVerified(db, id, "human");
  revalidateAll();
  return result;
}

export async function activateListing(id: number) {
  await requireAuth();
  const db = await getDb();
  const result = await activateDigitalListing(db, id);
  revalidateAll();
  return result;
}

export async function savePodSample(blueprintId: number, providerId: number, note?: string) {
  await requireAuth();
  const db = await getDb();
  const result = await recordPodSample(db, { blueprintId, providerId, note, actor: "human" });
  revalidateAll();
  return result;
}

export async function publishPodListing(id: number) {
  await requireAuth();
  const db = await getDb();
  const result = await publishPodListingToEtsy(db, id);
  revalidateAll();
  return result;
}

export async function saveAutomation(patch: Partial<AutomationSettings>) {
  await requireAuth();
  const db = await getDb();
  const a = await getSetting(db, "automation");
  const clean: Partial<AutomationSettings> = {};
  for (const [k, v] of Object.entries(patch) as [keyof AutomationSettings, unknown][]) {
    if (k === "publishMode") continue;
    if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) continue;
    (clean as Record<string, unknown>)[k] = v;
  }
  if (clean.targetMarginPct !== undefined) clean.targetMarginPct = Math.min(80, clean.targetMarginPct);
  if (clean.podTargetMarginPct !== undefined) {
    clean.podTargetMarginPct = Math.min(MARGIN_TARGETS.podMax, Math.max(MARGIN_TARGETS.podMin, clean.podTargetMarginPct));
  }
  if (clean.digitalTargetMarginPct !== undefined) {
    clean.digitalTargetMarginPct = Math.min(MARGIN_TARGETS.digitalMax, Math.max(MARGIN_TARGETS.digitalMin, clean.digitalTargetMarginPct));
  }
  if (clean.designsPerRun !== undefined) clean.designsPerRun = Math.max(1, Math.min(20, Math.round(clean.designsPerRun)));
  if (typeof clean.adsEnabled === "boolean") {
    if (clean.adsEnabled && !a.adsEnabled) clean.adsEnabledAt = new Date().toISOString();
    if (!clean.adsEnabled) clean.adsEnabledAt = null;
  }
  await setSetting(db, "automation", { ...a, ...clean });
  revalidateAll();
  return { ok: true };
}

/** Records Kai's review of the catalog draft. Does not write listings or call Etsy. */
export async function setCatalogDraftReviewed(reviewed: boolean) {
  await requireAuth();
  const db = await getDb();
  const current = await getSetting(db, "catalogDraft");
  await setSetting(db, "catalogDraft", {
    ...DEFAULT_CATALOG_DRAFT,
    ...current,
    reviewedByKai: reviewed,
    pending: !reviewed,
  });
  revalidateAll();
  return { ok: true as const, reviewed };
}
