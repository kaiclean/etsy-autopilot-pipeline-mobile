"use server";
import { requireAuth } from "@/lib/session";
import { getDb } from "@/db";
import { resolveActiveShop } from "@/lib/shops";
import { retryHeldBoxJob, resolveHeldBoxJob } from "@/lib/box-jobs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function retryBoxJob(form: FormData) {
  await requireAuth();
  if (form.get("reviewed") !== "yes") throw new Error("Inspect Etsy/Printify and provider results before retrying");
  const id = String(form.get("id") ?? "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid job");
  const db = await getDb();
  const shop = await resolveActiveShop(db);
  const job = await retryHeldBoxJob(db, id, shop.id);
  revalidatePath("/pipeline/box");
  redirect(`/pipeline/box?${job ? "retried=1" : "retryUnavailable=1"}`);
}

export async function closeHeldBoxJob(form: FormData) {
  await requireAuth();
  if (form.get("reviewed") !== "yes") throw new Error("Inspect provider results before closing this job");
  const id = String(form.get("id") ?? "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid job");
  const db = await getDb();
  const shop = await resolveActiveShop(db);
  await resolveHeldBoxJob(db, id, shop.id);
  revalidatePath("/pipeline/box");
  redirect("/pipeline/box");
}
