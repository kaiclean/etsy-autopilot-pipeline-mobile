import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import { OperationPaused } from "./operation-policy";
import { withOperationLease } from "./operation-lease";

export type DurableJob = { id:string; shop_id:string; kind:string; payload:Record<string,unknown>; status:string; attempts:number; result:unknown; error_code:string|null };
export async function enqueueJob(db:DB, shopId:string, kind:string, key:string, payload:unknown) {
  await db.execute(sql`insert into durable_jobs (shop_id,kind,dedupe_key,payload) values (${shopId}::uuid,${kind},${key},${JSON.stringify(payload)}::jsonb) on conflict (dedupe_key) do nothing`);
  return (await db.execute<DurableJob>(sql`select * from durable_jobs where dedupe_key=${key}`)).rows[0];
}
export async function findJob(db:DB, key:string) {
  return (await db.execute<DurableJob>(sql`select * from durable_jobs where dedupe_key=${key}`)).rows[0] ?? null;
}
export async function drainJobs(db:DB, limit=1) {
  await db.execute(sql`update durable_jobs set status=case when attempts >= 3 then 'failed' else 'queued' end, owner=null, error_code='worker_interrupted',updated_at=now() where status='running' and lease_until < now()`);
  const results=[];
  for(let n=0;n<Math.min(3,limit);n++) {
    const owner=randomUUID();
    const rows=await db.execute<DurableJob>(sql`
      update durable_jobs set status='running',owner=${owner},lease_until=now()+interval '10 minutes',attempts=attempts+1,updated_at=now()
      where id=(select id from durable_jobs where status='queued' and next_attempt_at<=now() order by created_at for update skip locked limit 1) returning *
    `);
    const job=rows.rows[0]; if(!job) break;
    try {
      const result=await withOperationLease(db,`job:${job.id}`,async()=>{
        if(job.kind==='stage') {
          const {isStage}=await import('@/pipeline/types');
          if(!isStage(String(job.payload.stage))) throw new Error('Invalid durable stage');
          const {runStage}=await import('@/pipeline/runner');
          const run=await runStage(String(job.payload.stage) as import('@/db/schema').StageName,'cron',{db,shopId:job.shop_id,force:job.payload.force===true});
          if(run.status==='skipped' && run.summary==='Already running') throw new Error('stage_busy');
          return {status:run.status,runId:run.id,summary:run.summary};
        }
        if(job.kind==='redesign') {
          const {regenerateFlaggedDesign}=await import('./redesign');
          const {withAiBudgetContext}=await import('./ai-budget');
          return withOperationLease(db,`design:${job.payload.designId}`,()=>withAiBudgetContext(db,job.shop_id,()=>regenerateFlaggedDesign(db,Number(job.payload.designId))));
        }
        if(job.kind==='upscale') {
          const {completeStoredUpscale}=await import('./upscale-completion');
          return completeStoredUpscale(db,job.payload);
        }
        throw new Error('Unknown durable job kind');
      });
      const failed=!!result && typeof result==='object' && 'status' in result && result.status==='failed';
      await db.execute(sql`update durable_jobs set status=${failed?'failed':'completed'},result=${JSON.stringify(result)}::jsonb,owner=null,lease_until=null,error_code=${failed?'stage_failed':null},updated_at=now() where id=${job.id}::uuid and owner=${owner}`);
      results.push({id:job.id,status:failed?'failed':'completed'});
    } catch(error) {
      const paused=error instanceof OperationPaused;
      await db.execute(sql`update durable_jobs set attempts=attempts-${paused?1:0},status=${!paused && job.attempts>=3?'failed':'queued'},owner=null,lease_until=null,error_code=${paused?'automation_paused':'processing_failed'},next_attempt_at=now()+interval '1 minute',updated_at=now() where id=${job.id}::uuid and owner=${owner}`);
      if(!paused && job.attempts>=3) {
        const {emit}=await import('./events');
        await emit(db,{shopId:job.shop_id,type:'job.failed',title:'Recovery job needs attention',body:`${job.kind} job ${job.id} exhausted its retries`,severity:'error',href:'/connections'});
      }
      results.push({id:job.id,status:'retry_or_failed'});
    }
  }
  return results;
}
