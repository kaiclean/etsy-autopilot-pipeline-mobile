import { CopyButton } from "@/components/copy-button";
import { Panel, SectionTitle } from "@/components/common";
import { relTime } from "@/lib/format";
import { printifyCallbackUrl, PRINTIFY_WEBHOOK_TOPICS, type PrintifyEventLogRow } from "@/lib/ops-copy";

export function PrintifyWebhookCard({
  origin,
  secretSet,
  events,
}: {
  origin: string | undefined;
  secretSet: boolean;
  events: PrintifyEventLogRow[];
}) {
  const url = printifyCallbackUrl(origin);
  const topics = PRINTIFY_WEBHOOK_TOPICS.join("\n");
  return (
    <section id="printify-webhook" className="scroll-mt-20 space-y-3">
      <SectionTitle
        action={
          <div className="flex gap-2">
            <CopyButton text={url} label="Copy URL" />
            <CopyButton text={topics} label="Copy topics" />
          </div>
        }
      >
        Printify webhook
      </SectionTitle>
      <Panel className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          In Printify, create one webhook per topic with this callback. The handler stores the event and does not publish listings, so it is safe while dry-run is on.
          {origin
            ? " The URL is the APP_URL origin plus the webhook path."
            : " APP_URL is unset, so only the path is shown. Set APP_URL to the public https origin before registering."}
        </p>
        <div>
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Callback URL</div>
          <code className="mt-1 block overflow-x-auto rounded-xl bg-muted px-3 py-2 text-xs">{url}</code>
        </div>
        <div>
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Topics</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PRINTIFY_WEBHOOK_TOPICS.map((topic) => (
              <span key={topic} className="rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
                {topic}
              </span>
            ))}
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          <code>PRINTIFY_WEBHOOK_SECRET</code> must match the secret on each webhook. The value is never shown.{" "}
          {secretSet ? "A secret is set on this host." : "No secret is set, so production rejects unsigned deliveries."}
        </p>
      </Panel>
      <Panel className="divide-y divide-border">
        {events.length === 0 ? (
          <p className="p-4 text-xs leading-relaxed text-muted-foreground">
            No Printify events stored yet. A zero count means this database has not accepted a delivery. It is not a live status from Printify.
          </p>
        ) : (
          events.map((event) => (
            <div key={event.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs">{event.topic}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground" title={event.eventId}>
                  #{event.id} · {event.eventId}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[10px] font-semibold uppercase text-muted-foreground">{event.verified ? "Signed" : "Unsigned"}</div>
                <div className="text-[11px] text-muted-foreground" suppressHydrationWarning>
                  {relTime(event.createdAt)}
                </div>
              </div>
            </div>
          ))
        )}
      </Panel>
    </section>
  );
}
