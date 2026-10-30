import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/db/etsy-sync.ts", "./src/db/etsy-events.ts", "./src/db/etsy-finance.ts", "./src/db/box-jobs.ts", "./src/db/runtime-budget.ts"],
  out: "./drizzle",
  dialect: "postgresql",
});
