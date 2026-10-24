import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import type { FulfillmentStatus } from "@/db/schema";
const ranks:Record<string,number>={pending:1,in_production:2,shipped:3,delivered:4};
/** Compare rank in SQL, never against a stale application snapshot. */
export async function advanceOrder(db:DB,id:number,incoming:FulfillmentStatus|undefined,podId?:string) {
  const rank=incoming?ranks[incoming]??0:0;
  const result=await db.execute(sql`
    update orders set fulfillment_status=case when ${rank} > case fulfillment_status when 'pending' then 1 when 'in_production' then 2 when 'shipped' then 3 when 'delivered' then 4 else 99 end then ${incoming??'pending'} else fulfillment_status end,
      fulfillment_changed_at=case when ${rank} > case fulfillment_status when 'pending' then 1 when 'in_production' then 2 when 'shipped' then 3 when 'delivered' then 4 else 99 end then now() else fulfillment_changed_at end,
      pod_order_id=case when (pod_order_id is null or pod_order_id like 'dry-%') then coalesce(${podId??null},pod_order_id) else pod_order_id end,
      updated_at=now()
    where id=${id} and (${rank} > case fulfillment_status when 'pending' then 1 when 'in_production' then 2 when 'shipped' then 3 when 'delivered' then 4 else 99 end
      or (${podId??null}::text is not null and (pod_order_id is null or pod_order_id like 'dry-%'))) returning id
  `);
  return result.rows.length>0;
}
