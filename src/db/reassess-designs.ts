import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { getDb } from "@/db";
import { getLLMProvider } from "@/adapters/llm";
import { reassessDesigns } from "@/pipeline/reassess-designs";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const ids = args.filter((arg) => arg !== "--apply").map((arg) => /^\d+$/.test(arg) ? Number(arg) : NaN);
  const report = await reassessDesigns(await getDb(), ids, getLLMProvider({ demo: false }), apply);
  console.log(JSON.stringify({ applied: apply, assessments: report }, null, 2));
}

main().catch(() => {
  console.error("Design re-assessment failed. Check IDs, database and vision configuration; no listings were approved.");
  process.exitCode = 1;
});
