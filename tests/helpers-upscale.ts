import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { DB } from "@/db";
export async function upscaleFixture(id:number,key?:string) {
  const client=new PGlite('memory://');
  const db=drizzle(client,{schema}) as unknown as DB;
  await migrate(db,{migrationsFolder:path.join(process.cwd(),'drizzle')});
  await db.insert(schema.designs).values({id,niche:'alpine',prompt:'test',provider:'fixture',imageUrl:'https://app/source.png'});
  if(key) await db.insert(schema.upscaleUploads).values({key,designId:id});
  return {client,db};
}
