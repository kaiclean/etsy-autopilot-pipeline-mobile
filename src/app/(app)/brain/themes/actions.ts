"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { getDb } from "@/db";
import { cleanThemeInput, saveTheme } from "@/lib/themes";

export async function saveThemeAction(form: FormData) {
  if (!(await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value, config.authSecret))) redirect("/login?next=/brain/themes");
  const months = String(form.get("peakMonths") ?? "").split(/[,\s]+/).filter(Boolean).map((m) => Number(m) - 1);
  const res = cleanThemeInput({
    id: String(form.get("id") ?? "") || undefined,
    label: String(form.get("label") ?? ""),
    baseNiche: String(form.get("baseNiche") ?? ""),
    status: String(form.get("status") ?? "proposed"),
    style: String(form.get("style") ?? ""),
    seeds: String(form.get("seeds") ?? "").split(/[\n,]+/),
    products: form.getAll("products").map(String),
    peakMonths: months,
    blocker: String(form.get("blocker") ?? ""),
    notes: String(form.get("notes") ?? ""),
    source: String(form.get("source") ?? "") || "manual",
  });
  if (!res.ok) redirect(`/brain/themes?err=${encodeURIComponent(res.error)}${form.get("id") ? `#${form.get("id")}` : ""}`);
  await saveTheme(await getDb(), res.row);
  revalidatePath("/brain", "layout");
  redirect(`/brain/themes?saved=${encodeURIComponent(res.row.id)}#${res.row.id}`);
}
