import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/db/etsy-sync.ts", "./src/db/etsy-events.ts", "./src/db/etsy-finance.ts"],
  out: "./drizzle",
  dialect: "postgresql",
});
