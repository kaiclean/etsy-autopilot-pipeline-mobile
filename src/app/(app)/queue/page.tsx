import { PageHeader } from "@/components/common";
import { QueueStack } from "@/components/queue/queue-stack";
import { getDb } from "@/db";
import { getQueue } from "@/lib/queries";
import { getSetting } from "@/lib/settings";

export const metadata = { title: "Approval queue" };

export default async function QueuePage() {
  const [queue, automation] = await Promise.all([getQueue(), getDb().then((db) => getSetting(db, "automation"))]);
  return (
    <div>
      <PageHeader
        title="Approval queue"
        subtitle={queue.length ? `${queue.length} listing${queue.length > 1 ? "s" : ""} waiting · nothing publishes without you` : "All caught up"}
      />
      <QueueStack listings={queue} offsiteAds={automation.assumeOffsiteAds} />
    </div>
  );
}
