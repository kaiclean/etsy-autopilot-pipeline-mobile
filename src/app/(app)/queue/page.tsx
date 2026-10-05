import { CatalogDraftPanel } from "@/components/catalog-draft-panel";
import { PageHeader } from "@/components/common";
import { QueueStack } from "@/components/queue/queue-stack";
import { getDb } from "@/db";
import { parseQueueTriage } from "@/lib/catalog-filters";
import { resolveUsdToChf } from "@/lib/fee-schedule";
import { getQueue } from "@/lib/queries";
import { getSetting } from "@/lib/settings";

export const metadata = { title: "Approval queue" };

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ triage?: string | string[] }> }) {
  const params = await searchParams;
  const db = await getDb();
  const [queue, automation, catalogDraft, feeFx] = await Promise.all([
    getQueue(),
    getSetting(db, "automation"),
    getSetting(db, "catalogDraft"),
    getSetting(db, "feeFx"),
  ]);
  const fx = resolveUsdToChf({ stored: feeFx?.usdToChf, storedAsOf: feeFx?.asOf });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Approval queue"
        subtitle={queue.length ? `${queue.length} listing${queue.length > 1 ? "s" : ""} waiting · nothing publishes without you` : "All caught up"}
      />
      <CatalogDraftPanel reviewed={catalogDraft.reviewedByKai} />
      <QueueStack
        listings={queue}
        offsiteAds={automation.assumeOffsiteAds}
        usdToChf={fx.rate}
        initialTriage={parseQueueTriage(params.triage)}
      />
    </div>
  );
}
