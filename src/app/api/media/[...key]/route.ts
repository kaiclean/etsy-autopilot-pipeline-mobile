import { NextResponse } from "next/server";
import { readStoredObject } from "@/lib/object-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stable public URL for private S3 objects. The key is an unguessable object id. */
export async function GET(_req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const { key } = await ctx.params;
  const objectKey = key.join("/");
  try {
    const object = await readStoredObject(objectKey);
    if (!object) return NextResponse.json({ error: "not found" }, { status: 404 });
    const copy = new Uint8Array(object.bytes.byteLength);
    copy.set(object.bytes);
    return new NextResponse(copy.buffer, {
      headers: {
        "Content-Type": object.contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("[object-storage] read failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "storage unavailable" }, { status: 502 });
  }
}
