import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"], quiet: true });

import { getDb } from "@/db";
import { getLLMProvider } from "@/adapters/llm";
import { reassessDesigns, sanitizeReassessmentError } from "@/pipeline/reassess-designs";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const rescore = args.includes("--rescore");
  const ids = args.filter((arg) => arg !== "--apply" && arg !== "--rescore").map((arg) => /^\d+$/.test(arg) ? Number(arg) : NaN);
  const report = await reassessDesigns(await getDb(), ids, getLLMProvider({ demo: false }), { apply, rescore });
  console.log(JSON.stringify({ applied: apply, assessments: report }, null, 2));
}

main().catch((error) => {
  console.error(`Design re-assessment failed: ${sanitizeReassessmentError(error)}. No listings were approved.`);
  process.exitCode = 1;
});
