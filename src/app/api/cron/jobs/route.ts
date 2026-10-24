import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { config } from "@/lib/config";
import { bearerMatches } from "@/lib/bearer";
import { drainJobs } from "@/lib/durable-jobs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(req:Request) {
  if(!bearerMatches(req.headers.get('authorization'),config.cronSecret)) return NextResponse.json({error:'unauthorized'},{status:401});
  const db=await getDb();
  const id=new URL(req.url).searchParams.get('id');
  if(id) {
    if(!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({error:'invalid id'},{status:400});
    const rows=await db.execute(sql`select id,status,attempts,result,error_code,updated_at from durable_jobs where id=${id}::uuid`);
    return NextResponse.json({job:rows.rows[0]??null},{headers:{'cache-control':'no-store'}});
  }
  return NextResponse.json({jobs:await drainJobs(db,1)},{headers:{'cache-control':'no-store'}});
}
