import { decidePinApproval } from "@/app/actions";
import { Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import type { PinQueueItem } from "@/lib/queries";

export function PinQueue({ items }: { items: PinQueueItem[] }) {
  if (!items.length) return null;
  return (
    <section className="space-y-3" data-testid="pin-queue">
      <h2 className="text-sm font-semibold">Pin drafts</h2>
      {items.map((item) => (
        <Panel key={item.id} className="space-y-2 p-4" data-testid={`pin-${item.id}`} data-business-id={item.businessId} data-action={item.action}>
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold tracking-wide">
            <span className="rounded-full bg-muted px-2 py-1">{item.businessName}</span>
            <span className="rounded-full bg-muted px-2 py-1">{item.action}</span>
            <span className="rounded-full bg-muted px-2 py-1">{item.access}</span>
          </div>
          <h3 className="font-medium">{item.title}</h3>
          <p className="text-sm text-muted-foreground">{item.description}</p>
          <p className="text-xs text-muted-foreground">Alt: {item.altText}</p>
          <p className="text-xs text-muted-foreground">Board: {item.board}</p>
          <p className="break-all text-xs text-muted-foreground">{item.imageUrl ? `Image: ${item.imageUrl}` : "Image is not in S3 yet."}</p>
          <p className="break-all text-xs text-muted-foreground">{item.destinationLink}</p>
          {item.quality.length ? <p className="text-xs text-destructive">{item.quality.join(" ")}</p> : null}
          <div className="flex gap-2">
            <form action={decidePinApproval}>
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="status" value="approved" />
              <Button type="submit" className="h-10 rounded-xl">Approve pin</Button>
            </form>
            <form action={decidePinApproval}>
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="status" value="rejected" />
              <Button type="submit" variant="secondary" className="h-10 rounded-xl">Reject</Button>
            </form>
          </div>
        </Panel>
      ))}
    </section>
  );
}
