import { config as loadEnv } from "dotenv";
import { pathToFileURL } from "node:url";
import { isPodPreset, type PodPreset } from "@/lib/fees";
import {
  blueprintRows, matchesBlueprint, providerRows, variantRows, verifiedEuropeanShipping,
} from "./catalog";

const API = "https://api.printify.com/v1";

export async function listPrintifyCandidates(preset: PodPreset, token: string, fetchImpl: typeof fetch = fetch) {
  async function read(path: string): Promise<unknown> {
    const res = await fetchImpl(`${API}${path}`, {
      method: "GET",
      headers: { Authorization: ["Bearer", token].join(" "), "User-Agent": "EtsyAutopilot", Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Printify catalog GET ${path} failed (${res.status})`);
    return res.json();
  }
  const blueprints = blueprintRows(await read("/catalog/blueprints.json")).filter((row) => matchesBlueprint(preset, row));
  const candidates = [];
  for (const blueprint of blueprints) {
    const providers = providerRows(await read(`/catalog/blueprints/${blueprint.id}/print_providers.json`));
    for (const provider of providers) {
      const path = `/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}`;
      const variants = variantRows(await read(`${path}/variants.json`));
      const shipping = await read(`${path}/shipping.json`).catch(() => null);
      for (const variant of variants) {
        const profiles = verifiedEuropeanShipping(shipping, variant.id);
        candidates.push({
          preset, blueprintId: blueprint.id, blueprint: blueprint.title,
          printProviderId: provider.id, provider: provider.title, variantId: variant.id,
          variant: variant.title, placeholders: variant.placeholders ?? [],
          verifiedEuChShipping: profiles.length > 0,
          shippingCountries: [...new Set(profiles.flatMap((profile) => profile.countries as string[]))].sort(),
          deliveryTimes: profiles.map((profile) => profile.delivery_time),
        });
      }
    }
  }
  return candidates.sort((a, b) => Number(b.verifiedEuChShipping) - Number(a.verifiedEuChShipping)
    || a.blueprintId - b.blueprintId || a.printProviderId - b.printProviderId || a.variantId - b.variantId);
}

async function main() {
  loadEnv({ path: [".env.local", ".env"], quiet: true });
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--preset" || !isPodPreset(args[1])) {
    throw new Error("Usage: npm run printify:catalog -- --preset mug");
  }
  const token = process.env.PRINTIFY_API_TOKEN?.trim();
  if (!token) throw new Error("PRINTIFY_API_TOKEN missing (catalog is read-only; no shop ID needed)");
  const candidates = await listPrintifyCandidates(args[1], token);
  console.log(JSON.stringify({ preset: args[1], readOnly: true, candidates }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    let message = error instanceof Error ? error.message : "Catalog discovery failed";
    const token = process.env.PRINTIFY_API_TOKEN;
    if (token) message = message.split(token).join("[redacted]");
    console.error(message);
    process.exitCode = 1;
  });
}
