import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { designs } from "@/db/schema";
import { assertOperationAllowed } from "./operation-policy";
import { readStoredObject } from "./object-storage";
import { primeArtworkBytes } from "./artwork-source";
import { attachA3Crop, clearRedesignFlag } from "./upscale-jobs";
import { upscaleDesigns } from "@/db/upscale-designs";

export async function completeStoredUpscale(db:DB,payload:Record<string,unknown>) {
  const designId=Number(payload.designId);
  const [design]=await db.select().from(designs).where(eq(designs.id,designId));
  if(!design) throw new Error('Design missing');
  await assertOperationAllowed(db,design.shopId);
  if(design.imageUrl!==payload.sourceUrl && design.imageUrl!==payload.url) throw new Error('Artwork changed during upscale');
  const object=await readStoredObject(String(payload.key));
  if(!object) throw new Error('Stored upscale unavailable');
  const bytes=Buffer.from(object.bytes);
  if(createHash("sha256").update(bytes).digest("hex")!==payload.sha256) throw new Error("Stored upscale content changed");
  const url=String(payload.url);
  const size=payload.outputPx as {width:number;height:number};
  primeArtworkBytes(url,bytes);
  await upscaleDesigns(db,[designId],true,new Map([[designId,{url,upscaleMethod:'realesrgan' as const,sourcePx:payload.sourcePx as {width:number;height:number},outputPx:size}]]));
  await db.update(designs).set({upscaleFailure:null,...(payload.flatReview?{designReview:{status:'pending' as const,note:'dark/flat edge bands — check at zoom',at:new Date().toISOString()}}:{})}).where(eq(designs.id,designId));
  await attachA3Crop(db,designId,bytes,url,size);
  await clearRedesignFlag(db,designId,size);
  await db.execute(sql`delete from upscale_work_leases where design_id=${designId}`);
  return {designId,status:'completed'};
}
