import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
import { getDb } from "./index";
import { clearDemo, seedDemo } from "./seed";

async function main() {
  const db = await getDb();
  await clearDemo(db);
  await seedDemo(db);
  console.log("Demo data reseeded (all rows flagged is_demo=true).");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
