import { PageHeader } from "@/components/common";
import { SourcingTable } from "@/components/products/sourcing-table";
import { getDb } from "@/db";
import { sourcingChoices } from "@/db/schema";
import { requireAuth } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { SOURCING_REGIONS } from "@/lib/sourcing";
import { latestQuotes, sourcingAvailable } from "@/pipeline/sourcing";

export const metadata = { title: "Supplier sourcing" };

export default async function SourcingPage() {
  await requireAuth();
  const db = await getDb();
  const available = await sourcingAvailable(db);
  const settings = await getSetting(db, "podProducts");
  const quotes = available ? (await Promise.all(settings.enabledPresets.flatMap((preset) =>
    SOURCING_REGIONS.map((region) => latestQuotes(db, preset, region))))).flat() : [];
  const choices = available ? await db.select().from(sourcingChoices) : [];
  return (
    <div className="space-y-6">
      <PageHeader title="Supplier sourcing" subtitle="Cheapest verified in-stock landed cost · CH / EU (Germany representative) / US" />
      <p className="text-sm text-muted-foreground">Refreshed daily by Maintenance. Unknown values are — and excluded from automatic selection. Order rechecks use the buyer country and only record dry-run recommendations; no orders are placed or moved.</p>
      {!available && <p>Sourcing schema unavailable; check database migrations. Pricing currently uses preset estimates.</p>}
      <SourcingTable quotes={quotes} choices={choices} />
    </div>
  );
}
