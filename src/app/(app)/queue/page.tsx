import { CatalogDraftPanel } from "@/components/catalog-draft-panel";
import { PageHeader } from "@/components/common";
import { PinQueue } from "@/components/queue/pin-queue";
import { QueueStack } from "@/components/queue/queue-stack";
import { getDb } from "@/db";
import { parseQueueTriage } from "@/lib/catalog-filters";
import { getPinQueue, getQueue } from "@/lib/queries";
import { getSetting } from "@/lib/settings";

export const metadata = { title: "Approval queue" };

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ triage?: string | string[] }> }) {
  const params = await searchParams;
  const [queue, pins, automation, catalogDraft] = await Promise.all([
    getQueue(),
    getPinQueue(),
    getDb().then((db) => getSetting(db, "automation")),
    getDb().then((db) => getSetting(db, "catalogDraft")),
  ]);
  const waiting = queue.length + pins.length;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Approval queue"
        subtitle={waiting ? `${waiting} item${waiting > 1 ? "s" : ""} waiting · nothing publishes without you` : "All caught up"}
      />
      <CatalogDraftPanel reviewed={catalogDraft.reviewedByKai} />
      <PinQueue items={pins} />
      <QueueStack listings={queue} offsiteAds={automation.assumeOffsiteAds} initialTriage={parseQueueTriage(params.triage)} />
    </div>
  );
}
