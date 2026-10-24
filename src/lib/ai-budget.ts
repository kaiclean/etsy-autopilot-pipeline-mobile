import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import { getSetting } from "./settings";
import { assertOperationAllowed } from "./operation-policy";
import { withOperationLease, OperationBusy } from "./operation-lease";
const context=new AsyncLocalStorage<{db:DB;shopId:string}>();
export function withAiBudgetContext<T>(db:DB,shopId:string,work:()=>Promise<T>) { return context.run({db,shopId},work); }
export function budgetEstimate(value:string|undefined,fallback:number) { const n=Number(value); return Number.isFinite(n)&&n>0?n:fallback; }
/** Reservations cover all AI calls, including text, vision and uncertain failed calls. */
export async function budgetedAi<T extends {costChf?:number}>(estimate:number,work:()=>Promise<T>):Promise<T> {
  const ctx=context.getStore(); if(!ctx) return work();
  await assertOperationAllowed(ctx.db,ctx.shopId);
  const {db}=ctx; const id=randomUUID(); const now=new Date();
  const day=now.toISOString().slice(0,10),month=day.slice(0,7);
  if(!Number.isFinite(estimate)||estimate<0) throw new Error('Invalid AI reservation');
  let reserved=false;
  for(let retry=0;retry<50&&!reserved;retry++) {
    try {
      await withOperationLease(db,'ai-budget',async()=>{
        const a=await getSetting(db,'automation');
        const sums=await db.execute<{daily:number;monthly:number}>(sql`
          select
            coalesce((select sum(coalesce(actual_chf,reserved_chf)) from ai_reservations where day=${day}),0)
              + coalesce((select sum(amount_chf) from costs where kind in ('ai_text','ai_image') and created_at>=${day}::date and created_at<(select started_at from ai_budget_epoch limit 1)),0) as daily,
            coalesce((select sum(coalesce(actual_chf,reserved_chf)) from ai_reservations where month=${month}),0)
              + coalesce((select sum(amount_chf) from costs where kind in ('ai_text','ai_image') and created_at>=${month+'-01'}::date and created_at<(select started_at from ai_budget_epoch limit 1)),0) as monthly
        `);
        const usage=sums.rows[0];
        if(Number(usage.daily)+estimate>a.dailyAiCapChf || Number(usage.monthly)+estimate>a.monthlyAiBudgetChf) throw new Error('AI budget reached; operation deferred before dispatch');
        await db.execute(sql`insert into ai_reservations (id,day,month,reserved_chf) values (${id}::uuid,${day},${month},${estimate})`);
      });
      reserved=true;
    } catch(error) {
      if(!(error instanceof OperationBusy)) throw error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
  if(!reserved) throw new Error('AI budget busy; retry later');
  // A failed provider call may have been charged. Its reservation remains until reconciled.
  const result=await work();
  const actual=Number.isFinite(result.costChf)&&result.costChf!>=0?result.costChf!:estimate;
  await db.execute(sql`update ai_reservations set actual_chf=${Math.max(estimate,actual)} where id=${id}::uuid`);
  return result;
}
