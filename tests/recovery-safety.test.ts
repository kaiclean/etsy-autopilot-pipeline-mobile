import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql,eq } from 'drizzle-orm';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import type { DB } from '@/db';
import * as schema from '@/db/schema';
import { enqueueJob,drainJobs,findJob } from '@/lib/durable-jobs';
import { providerAttempt } from '@/lib/provider-attempt';
import { advanceOrder } from '@/lib/fulfillment-state';
import { withOperationLease,assertExecutionLease } from '@/lib/operation-lease';
import { withAiBudgetContext,budgetedAi } from '@/lib/ai-budget';
import { getSetting,setSetting } from '@/lib/settings';
import { readBoundedText } from '@/lib/request-body';
import { takeLoginAttempt } from '@/lib/shared-login-limit';
import { publicAddress } from '@/lib/public-artwork-fetch';
const mocks=vi.hoisted(()=>({stage:vi.fn(async()=>({id:1,status:'success',summary:'done'}))}));
vi.mock('@/pipeline/runner',()=>({runStage:mocks.stage}));
describe('durable recovery and side-effect safety',()=>{
  const client=new PGlite('memory://');const db=drizzle(client,{schema}) as unknown as DB;let shopId:string;
  beforeAll(async()=>{await migrate(db,{migrationsFolder:path.join(process.cwd(),'drizzle')});shopId=(await db.select().from(schema.shops))[0].id;});
  afterAll(async()=>{await client.close();});
  it('persists one job before acknowledgment and drains it once across 20 workers',async()=>{
    const jobs=await Promise.all(Array.from({length:30},()=>enqueueJob(db,shopId,'stage','test-stage',{stage:'research'})));
    expect(new Set(jobs.map(j=>j.id)).size).toBe(1);
    expect((await findJob(db,'test-stage'))?.status).toBe('queued');
    await Promise.all(Array.from({length:20},()=>drainJobs(db,1)));
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    expect((await findJob(db,'test-stage'))?.status).toBe('completed');
  });
  it('recovers a worker killed after claiming a job',async()=>{
    await enqueueJob(db,shopId,'stage','interrupted',{stage:'orders'});
    await db.execute(sql`update durable_jobs set status='running',attempts=1,owner='gone',lease_until=now()-interval '1 minute' where dedupe_key='interrupted'`);
    await drainJobs(db,1);
    expect((await findJob(db,'interrupted'))?.status).toBe('completed');
  });
  it('deduplicates provider creation and blocks an uncertain retry',async()=>{
    let calls=0;
    const results=await Promise.allSettled(Array.from({length:50},()=>providerAttempt(db,'test-create',{revision:1},async()=>{calls++;return {productId:'real-1'};})));
    expect(calls).toBe(1);expect(results.some(r=>r.status==='fulfilled')).toBe(true);
    expect(await providerAttempt(db,'test-create',{revision:1},async()=>{throw new Error('duplicate');})).toEqual({productId:'real-1'});
    await expect(providerAttempt(db,'uncertain',{revision:1},async()=>{throw new Error('lost response');})).rejects.toThrow('lost response');
    await expect(providerAttempt(db,'uncertain',{revision:1},async()=>{calls++;return {};})).rejects.toThrow('reconciliation');
    expect(calls).toBe(1);
  });
  it('fences an expired lease before the next side effect',async()=>{
    await expect(withOperationLease(db,'fence',async()=>{
      await db.execute(sql`update operation_leases set expires_at=now()-interval '1 second' where key='fence'`);
      await assertExecutionLease();
    })).rejects.toThrow('lease lost');
  });
  it('reserves the monetary cap atomically across 50 requests',async()=>{
    const old=await getSetting(db,'automation');await setSetting(db,'automation',{...old,dailyAiCapChf:0.5,monthlyAiBudgetChf:1});
    let calls=0;
    try {
      await Promise.allSettled(Array.from({length:50},()=>withAiBudgetContext(db,shopId,()=>budgetedAi(0.1,async()=>{calls++;return {costChf:0.01};}))));
      expect(calls).toBe(5);
    } finally {await setSetting(db,'automation',old);}
  });
  it('never regresses fulfillment under shuffled simultaneous events',async()=>{
    const [order]=await db.insert(schema.orders).values({etsyReceiptId:'race-order',buyerCountry:'CH',quantity:1,totalChf:20,feesChf:2,profitChf:10,fulfillmentStatus:'pending'}).returning();
    const statuses=['shipped','in_production','delivered','pending'] as const;
    await Promise.all(Array.from({length:100},(_,i)=>advanceOrder(db,order.id,statuses[i%4])));
    const [row]=await db.select().from(schema.orders).where(eq(schema.orders.id,order.id));
    expect(row.fulfillmentStatus).toBe('delivered');
  });
  it('bounds chunked ingress even without content-length',async()=>{
    const req=new Request('https://app/webhook',{method:'POST',body:'x'.repeat(2000)});
    await expect(readBoundedText(req,1000)).rejects.toThrow('too large');
  });
  it('shares the login cap across 100 simultaneous attempts',async()=>{
    const results=await Promise.all(Array.from({length:100},()=>takeLoginAttempt(db)));
    expect(results.filter(Boolean)).toHaveLength(32);
  });
  it.each(['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fe80::1'])('rejects private DNS address %s',address=>{expect(publicAddress(address)).toBe(false);});
});
