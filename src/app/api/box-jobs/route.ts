import { requireAuth } from "@/lib/session";
import { getDb } from "@/db";
import { resolveActiveShop } from "@/lib/shops";
import { boxExecutionEnabled, listBoxJobs } from "@/lib/box-jobs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { await requireAuth(); } catch { return Response.json({ error: "unauthorized" }, { status: 401 }); }
  if (!boxExecutionEnabled()) return Response.json({ enabled: false, jobs: [] });
  const db = await getDb();
  const shop = await resolveActiveShop(db);
  return Response.json({ enabled: true, jobs: await listBoxJobs(db, shop.id) });
}
