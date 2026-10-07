import Link from "next/link";
import { LiveLog } from "@/components/pipeline/live-log";
import { PageHeader } from "@/components/common";
import { getDb } from "@/db";
import { loadPipelineLive } from "@/lib/pipeline-live";

export const metadata = { title: "Pipeline live" };
export const dynamic = "force-dynamic";

export default async function PipelineLivePage() {
  const live = await loadPipelineLive(await getDb(), { limit: 20 });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline live"
        subtitle="Recent stage runs, log lines, and publish errors. This view polls every few seconds and does not start a run."
        action={
          <Link href="/pipeline" className="text-sm font-medium text-primary">
            All stages
          </Link>
        }
      />
      <LiveLog initial={live} />
    </div>
  );
}
