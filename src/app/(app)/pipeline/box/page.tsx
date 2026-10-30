import Link from "next/link";
import { getDb } from "@/db";
import { resolveActiveShop } from "@/lib/shops";
import { boxExecutionEnabled, listBoxJobs } from "@/lib/box-jobs";
import { PageHeader, Panel } from "@/components/common";
import { retryBoxJob, closeHeldBoxJob } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mac worker jobs" };

export default async function BoxJobsPage() {
  const db = await getDb();
  const shop = await resolveActiveShop(db);
  const jobs = boxExecutionEnabled() ? await listBoxJobs(db, shop.id) : [];
  return <div className="space-y-5">
    <PageHeader title="Mac worker jobs" subtitle="Queued work waits for your Mac. Refresh this page to see progress." />
    <Link href="/pipeline" className="text-sm text-primary">Back to Pipeline</Link>
    {!boxExecutionEnabled() && <Panel className="p-4">Local worker mode is not enabled for this deployment.</Panel>}
    {boxExecutionEnabled() && !jobs.length && <Panel className="p-4">No jobs yet. Start a stage from Pipeline.</Panel>}
    {jobs.map(job => <Panel key={job.id} className="space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>{job.stage}</strong><span>{job.status}</span></div>
      <p className="text-sm">{job.summary}</p>
      <p className="text-xs text-muted-foreground">Queued {job.createdAt.toISOString()} · attempt {job.attempts}/3{job.startedAt ? ` · started ${job.startedAt.toISOString()}` : ""}</p>
      {job.status === "running" && <p className="text-xs">Lease valid until {job.leaseUntil?.toISOString() ?? "unknown"}. An expired job needs review before it can run again.</p>}
      {job.status === "held" && <form action={closeHeldBoxJob} className="space-y-2">
        <input type="hidden" name="id" value={job.id} />
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="reviewed" value="yes" required />I reconciled existing provider results. Close this job and let later work proceed.</label>
        <button type="submit" className="rounded-md border px-3 py-2 text-sm">Close without running again</button>
      </form>}
      {(job.status === "held" || job.status === "failed") && job.attempts < 3 && <form action={retryBoxJob} className="space-y-2">
        <input type="hidden" name="id" value={job.id} />
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="reviewed" value="yes" required />I checked Etsy, Printify and the image provider for existing results. Retrying is appropriate.</label>
        <button type="submit" className="rounded-md border px-3 py-2 text-sm">Retry on Mac</button>
      </form>}
    </Panel>)}
  </div>;
}
