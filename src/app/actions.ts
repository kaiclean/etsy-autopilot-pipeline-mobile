"use server";

import { withOperationLease } from "@/lib/operation-lease";
import { takeLoginAttempt } from "@/lib/shared-login-limit";
import { approvalBlocker as sharedApprovalBlocker } from "@/lib/design-review";
import { eq, inArray } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { refresh, revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { designs, keywords, listings, type StageName } from "@/db/schema";
import { clearLoginFailures, loginLocked, recordLoginFailure, safeNext } from "@/lib/login-limit";
import { passwordMatches, createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";
import { config, hasGelatoCredentials, isDemoMode } from "@/lib/config";
import { emit } from "@/lib/events";
import { calculateFees, DEFAULT_POD_PRESETS, isPodPreset, MARGIN_TARGETS } from "@/lib/fees";
import { artRegenerationBlocker } from "@/lib/art-queue";
import { isPlaceholderUrl } from "@/lib/art-quality";
import { probeConnections } from "@/lib/provider-probe";
import { getLastRuns } from "@/lib/queries";
import { requireAuth } from "@/lib/session";
import { resolveActiveShop } from "@/lib/shops";
import { goLiveDecision, type PublishMode } from "@/lib/publish-mode";
import { PUSH_PREF_KEYS, type PushPrefs } from "@/lib/push-prefs";
import { DEFAULT_CATALOG_DRAFT, getSetting, normalizePodProductSettings, setSetting, type AutomationSettings } from "@/lib/settings";
import {
  activateDigitalListing,
  markDeliveryVerified,
  publishPodListingToEtsy,
  recordDeliveryManifest,
  recordPodSample,
} from "@/pipeline/human-publish";
import { runFullPipeline, runStage } from "@/pipeline/runner";
import { isStage } from "@/pipeline/types";
import { prepareSupplierPreview, refreshSupplierDescription, validateSupplierApproval, WAITING_FOR_PRINTIFY_MOCKUPS } from "@/pipeline/supplier-preview";

export async function login(_prev: { error?: string } | undefined, form: FormData) {
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/");
  const secret = config.authSecret;
  if (!secret || !config.dashboardPassword) {
    return { error: "Server is missing DASHBOARD_PASSWORD / AUTH_SECRET." };
  }
  if(!await takeLoginAttempt(await getDb())) return {error:"Too many sign-in attempts. Try again in 15 minutes."};
  const h = await headers();
  const client = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim();
  if (loginLocked(client)) return { error: "Too many wrong passwords. Try again in 15 minutes." };
  if (!(await passwordMatches(password, config.dashboardPassword, secret))) {
    recordLoginFailure(client);
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Wrong password." };
  }
  clearLoginFailures(client);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await createSessionToken(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect(safeNext(next));
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

const DRY_RUN_ONLY_APPROVAL_ERROR = "This supplier/product type is dry-run only; live fulfillment is not enabled.";

function isDryRunOnlyPodProduct(listing: { supplier: string | null; podProvider: string | null }) {
  const preset = listing.podProvider?.split(":")[1];
  return listing.supplier === "gelato" || listing.podProvider?.startsWith("gelato:") ||
    Boolean(preset && !DEFAULT_POD_PRESETS.some((enabled) => enabled === preset));
}

async function updateListingInner(id: number, edit: ListingEdit, approve = false) {
  await requireAuth();
  const db = await getDb();
  const [l] = await db.select().from(listings).where(eq(listings.id, id));
  if (!l) return { ok: false as const, error: "Listing not found" };
  if (approve) { const blocker = await sharedApprovalBlocker(db, l); if (blocker) return { ok: false as const, error: blocker }; }
  if (approve && isDryRunOnlyPodProduct(l)) return { ok: false as const, error: DRY_RUN_ONLY_APPROVAL_ERROR };
  const edited = { ...l, ...edit, description: edit.description ?? l.description };
  const next = approve ? await refreshSupplierDescription(db, edited) : edited;
  const { valid, issues } = validateSupplierApproval(next);
  const automation = await getSetting(db, "automation");
  const fees = calculateFees({ priceChf: next.priceChf, podCostChf: l.podCostChf, offsiteAds: automation.assumeOffsiteAds });
  const preview = approve && valid ? await prepareSupplierPreview(db, next, { timingsRefreshed: true }) : null;
  const canApprove = approve && valid && preview?.ready;
  await db
    .update(listings)
    .set({
      title: next.title,
      tags: next.tags,
      description: next.description,
      priceChf: next.priceChf,
      netChf: fees.netChf,
      marginPct: fees.marginPct,
      validation: preview && !preview.ready ? [...issues, ...preview.listing.validation.filter((issue) =>
        issue.code === "supplier_mockups_pending" || issue.code === "supplier_preview_error")] : issues,
      updatedAt: new Date(),
      ...(canApprove ? { status: "approved" as const, approvedAt: new Date() } : {}),
    })
    .where(eq(listings.id, id));
  revalidateAll();
  if (approve && !valid) return { ok: false as const, error: issues.find((issue) => issue.code === "supplier_preview_error")?.message ?? "Fix validation errors before approving", issues };
  if (preview && !preview.ready) return { ok: false as const, error: preview.error ?? WAITING_FOR_PRINTIFY_MOCKUPS };
  return { ok: true as const, issues };
}

/** Stale mockups or a held print file block approval until Printify mockups are regenerated from the current file. */
function approvalBlocker(validation: { code: string; message: string }[] | null | undefined) {
  return (validation ?? []).find((issue) => issue.code === "mockups_stale" || issue.code === "print_file_held")?.message ?? null;
}

async function setListingStatusInner(id: number, status: "approved" | "rejected" | "pending_approval", reason?: string) {
  await requireAuth();
  const db = await getDb();
  const [l] = await db.select().from(listings).where(eq(listings.id, id));
  if (!l) return { ok: false as const, error: "Listing not found" };
  if (status === "approved") {
    if (isDryRunOnlyPodProduct(l)) return { ok: false as const, error: DRY_RUN_ONLY_APPROVAL_ERROR };
    let blocker = approvalBlocker(l.validation);
    if (!blocker && l.designId) {
      const { designReviewBlocker } = await import("@/lib/design-review");
      blocker = await designReviewBlocker(db, l.designId);
    }
    if (blocker) return { ok: false as const, error: blocker };
    const refreshed = await refreshSupplierDescription(db, l);
    const { valid, issues } = validateSupplierApproval(refreshed);
    if (!valid) {
      await db.update(listings).set({ validation: issues }).where(eq(listings.id, id));
      revalidateAll();
      return { ok: false as const, error: issues.find((i) => i.code === "supplier_preview_error")?.message ?? issues.find((i) => i.severity === "error")?.message ?? "Invalid listing" };
    }
    const preview = await prepareSupplierPreview(db, refreshed, { timingsRefreshed: true });
    if (!preview.ready) {
      revalidateAll();
      return { ok: false as const, error: preview.error ?? WAITING_FOR_PRINTIFY_MOCKUPS };
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

export async function updateListing(id:number,edit:ListingEdit,approve=false) {
  await requireAuth();
  return withOperationLease(await getDb(),`listing:${id}`,()=>updateListingInner(id,edit,approve));
}
export async function setListingStatus(id:number,status:"approved"|"rejected"|"pending_approval",reason?:string) {
  await requireAuth();
  return withOperationLease(await getDb(),`listing:${id}`,()=>setListingStatusInner(id,status,reason));
}
export async function bulkSetListingStatus(ids:number[],status:"approved"|"rejected"|"pending_approval") {
  await requireAuth();
  const unique=[...new Set(ids.filter(id=>Number.isInteger(id)&&id>0))].slice(0,100);
  if(!unique.length) return {ok:false as const,error:"Select at least one listing"};
  const changed:number[]=[];const skipped:{id:number;title:string;error:string}[]=[];
  const db=await getDb();
  for(const id of unique) {
    const [row]=await db.select().from(listings).where(eq(listings.id,id));
    try {
      const result=await setListingStatus(id,status);
      if(result.ok) changed.push(id); else skipped.push({id,title:row?.title.slice(0,80)??`#${id}`,error:result.error});
    } catch { skipped.push({id,title:row?.title.slice(0,80)??`#${id}`,error:"Operation busy or blocked; retry review"}); }
  }
  return {ok:true as const,changed,skipped};
}

export async function savePushPrefs(patch: Partial<PushPrefs>) {
  await requireAuth();
  const db = await getDb();
  const current = await getSetting(db, "pushPrefs");
  const next = { ...current };
  for (const key of PUSH_PREF_KEYS) {
    if (typeof patch[key] === "boolean") next[key] = patch[key];
  }
  await setSetting(db, "pushPrefs", next);
  revalidateAll();
  return { ok: true as const, pushPrefs: next };
}

export async function triggerStage(stage: string, opts?: { force?: boolean }) {
  await requireAuth();
  if (!isStage(stage)) return { ok: false as const, error: "Unknown stage" };
  const force = stage === "daily" && opts?.force === true;
  const run = await runStage(stage as StageName, "manual", { force });
  revalidateAll();
  refresh();
  return { ok: run.status !== "failed", status: run.status, summary: run.summary };
}

export async function testProviderConnections() {
  await requireAuth();
  return probeConnections();
}

/** Mark placeholder listings' keywords selected so the next Design run replaces the art. Does not publish. */
export async function queueArtRegeneration(ids: number[]) {
  await requireAuth();
  const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
  if (!unique.length) return { ok: false as const, queued: 0, error: "No listings selected." };
  const design = (await getLastRuns()).find((stage) => stage.id === "design")?.run ?? null;
  const blocker = artRegenerationBlocker(config.imageProvider, design);
  if (blocker) return { ok: false as const, queued: 0, error: blocker };
  const db = await getDb();
  const shop = await resolveActiveShop(db);
  const live = !isDemoMode(shop.etsyShopId ?? undefined);
  const rows = await db.select().from(listings).where(inArray(listings.id, unique));
  // A live shop never pays to redraw seeded demo rows.
  const targets = rows.filter((row) => isPlaceholderUrl(row.imageUrl) && row.keywordId && row.shopId === shop.id && !(live && row.isDemo));
  const keywordIds = [...new Set(targets.map((row) => row.keywordId).filter((id): id is number => typeof id === "number"))];
  if (!keywordIds.length) return { ok: false as const, queued: 0, error: "None of those listings have placeholder art to regenerate." };
  await db.update(keywords).set({ status: "selected", updatedAt: new Date() }).where(inArray(keywords.id, keywordIds));
  await emit(db, {
    type: "design.queued",
    title: `${targets.length} listing${targets.length === 1 ? "" : "s"} queued for new art`,
    body: "The next Design run will replace placeholder images. Nothing was published.",
    severity: "info",
    href: "/products",
  });
  revalidateAll();
  return { ok: true as const, queued: targets.length };
}

export async function triggerFullPipeline() {
  await requireAuth();
  const runs = await runFullPipeline("manual");
  revalidateAll();
  refresh();
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
    body: decision.mode === "live" && config.publishMode === "live" && !a.killSwitch ? "Live publishing selected. Quality and review gates still apply." : "Live writes are off or blocked by the host/pause gate.",
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

export async function savePodProducts(value: unknown) {
  await requireAuth();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false as const, error: "Invalid POD product settings." };
  }
  const input = value as Record<string, unknown>;
  if (
    !Array.isArray(input.enabledPresets) ||
    input.enabledPresets.some((preset) => typeof preset !== "string" || !isPodPreset(preset)) ||
    !input.suppliers || typeof input.suppliers !== "object" || Array.isArray(input.suppliers) ||
    Object.entries(input.suppliers).some(([preset, supplier]) => !isPodPreset(preset) || (supplier !== "printify" && supplier !== "gelato"))
  ) {
    return { ok: false as const, error: "Choose valid POD presets and suppliers." };
  }
  const podProducts = normalizePodProductSettings(input);
  if (!hasGelatoCredentials() && Object.values(podProducts.suppliers).includes("gelato")) {
    return { ok: false as const, error: "Set GELATO_API_KEY before selecting Gelato." };
  }
  const db = await getDb();
  await setSetting(db, "podProducts", podProducts);
  revalidatePath("/settings");
  return { ok: true as const, podProducts };
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

/** Queue one budgeted repair per source/day; never publishes or approves the replacement. */
export async function queueDesignRepair(designId:number) {
  await requireAuth();
  if(!Number.isInteger(designId)||designId<1) return {ok:false as const,error:"Invalid design"};
  const db=await getDb();
  const [design]=await db.select().from(designs).where(eq(designs.id,designId));
  if(!design || design.isDemo) return {ok:false as const,error:"A real design is required"};
  const {assertOperationAllowed}=await import("@/lib/operation-policy");
  await assertOperationAllowed(db,design.shopId);
  const at=new Date().toISOString();
  await db.update(designs).set({needsRedesign:design.needsRedesign??{reason:"Repair failed upscale or insufficient print file",sourcePx:design.sourcePx??{width:design.imageWidth??1024,height:design.imageHeight??1280},target:{minW:4016,minH:5057,targetW:4016,targetH:5057},presets:[],scale:4,at}}).where(eq(designs.id,designId));
  const {enqueueJob}=await import("@/lib/durable-jobs");
  const job=await enqueueJob(db,design.shopId,"redesign",`repair:${designId}:${at.slice(0,10)}`,{designId});
  revalidateAll();
  return {ok:true as const,jobId:job.id};
}
