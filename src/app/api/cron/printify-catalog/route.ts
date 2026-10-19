import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { surveyPrintifySuppliers, type SupplierPreset } from "@/adapters/printify/supplier-catalog";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Read-only Printify supplier survey (poster A3/A2, mug 11oz, tee, sweatshirt), behind CRON_SECRET.
 * Creates nothing and never returns the token. Each row is also logged as `[printify-catalog] {...}`
 * so the cron dispatcher (which truncates bodies) can be read from deploy logs.
 */
export async function GET(req: Request) {
  const secret = config.cronSecret;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = config.printify.token;
  if (!token) return NextResponse.json({ error: "PRINTIFY_API_TOKEN is not set" }, { status: 503 });
  try {
    const wanted = (new URL(req.url).searchParams.get("presets") ?? process.env.PRINTIFY_SURVEY_PRESETS ?? "")
      .split(/[,\s+]/).map((value) => value.trim()).filter((value): value is SupplierPreset => ["posterA3", "posterA2", "mug", "tshirt", "sweatshirt"].includes(value));
    const result = await surveyPrintifySuppliers(token, { shopId: config.printify.shopId ?? undefined, ...(wanted.length ? { presets: wanted } : {}) });
    for (const row of result.rows) console.log(`[printify-catalog] ${JSON.stringify(row)}`);
    for (const error of result.errors) console.warn(`[printify-catalog] error ${error}`);
    console.log(`[printify-catalog] done rows=${result.rows.length} errors=${result.errors.length}`);
    return NextResponse.json({ rowCount: result.rows.length, errorCount: result.errors.length, ...result });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "survey failed").split(token).join("[redacted]");
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
