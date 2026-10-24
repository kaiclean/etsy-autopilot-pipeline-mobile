import { CatalogDraftPanel } from "@/components/catalog-draft-panel";
import { PageHeader } from "@/components/common";
import { QueueStack } from "@/components/queue/queue-stack";
import { getDb } from "@/db";
import { parseQueueTriage } from "@/lib/catalog-filters";
import { getQueue } from "@/lib/queries";
import { getSetting } from "@/lib/settings";

export const metadata = { title: "Approval queue" };

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ triage?: string | string[] }> }) {
  const params = await searchParams;
  const [queue, automation, catalogDraft] = await Promise.all([
    getQueue(),
    getDb().then((db) => getSetting(db, "automation")),
    getDb().then((db) => getSetting(db, "catalogDraft")),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Approval queue"
        subtitle={queue.length ? `${queue.filter(l=>l.status==='pending_approval').length} ready for review · ${queue.filter(l=>l.status==='quality_failed').length} blocked · nothing publishes without you` : "No items ready or blocked in this queue"}
      />
      <CatalogDraftPanel reviewed={catalogDraft.reviewedByKai} />
      <QueueStack listings={queue} offsiteAds={automation.assumeOffsiteAds} initialTriage={parseQueueTriage(params.triage)} />
    </div>
  );
}
