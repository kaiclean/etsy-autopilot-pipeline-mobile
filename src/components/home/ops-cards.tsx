import { AlertTriangle, HeartPulse, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Panel, SectionTitle, Thumb } from "@/components/common";
import type { HealthReportPayload, ValidationIssue } from "@/db/schema";
import { chf } from "@/lib/format";
import { recommendationsAreReviewable } from "@/lib/operator-recommendations";

type Failure = {
  id: number;
  title: string;
  validation: ValidationIssue[];
  imageUrl: string | null;
  niche: string;
};

type ReportRow = { weekStart: string; payload: HealthReportPayload; updatedAt: Date } | null;

type Stalled = {
  id: number;
  podOrderId: string | null;
  etsyReceiptId: string;
  fulfillmentStatus: string;
  title: string | null;
};

function reasons(validation: ValidationIssue[]) {
  return validation.filter((issue) => issue.severity === "error").map((issue) => issue.message);
}

export function OpsCards({
  failures,
  failureCount,
  needsFixes,
  report,
  stalled,
}: {
  failures: Failure[];
  failureCount: number;
  needsFixes: Failure[];
  report: ReportRow;
  stalled: Stalled[];
}) {
  const payload = report?.payload;
  const reviewable = payload && recommendationsAreReviewable(payload);
  return (
    <div className="space-y-6">
      <div>
        <SectionTitle>Quality gate</SectionTitle>
        {failureCount === 0 ? (
          <Panel className="p-4 text-sm text-muted-foreground">Drafts that pass the gate go to the approval queue. Nothing is held right now.</Panel>
        ) : (
          <Panel className="divide-y divide-border overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 text-sm">
              <ShieldAlert className="size-4 text-destructive" />
              <span className="font-medium">{failureCount} held before approval</span>
            </div>
            {failures.map((listing) => (
              <div key={listing.id} className="flex gap-3 px-4 py-3">
                <Thumb src={listing.imageUrl} alt="" className="size-12 shrink-0" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{listing.title}</div>
                  <ul className="mt-1 space-y-0.5 text-xs text-destructive">
                    {reasons(listing.validation).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </Panel>
        )}
      </div>

      {needsFixes.length > 0 && (
        <div>
          <SectionTitle
            action={
              <Link href="/queue" className="text-xs font-medium text-primary">
                Queue
              </Link>
            }
          >
            Needs fixes
          </SectionTitle>
          <Panel className="divide-y divide-border overflow-hidden">
            {needsFixes.map((listing) => (
              <div key={listing.id} className="flex gap-3 px-4 py-3">
                <Thumb src={listing.imageUrl} alt="" className="size-12 shrink-0" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{listing.title}</div>
                  <ul className="mt-1 space-y-0.5 text-xs text-destructive">
                    {reasons(listing.validation).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </Panel>
        </div>
      )}

      <div>
        <SectionTitle>Weekly health</SectionTitle>
        {!payload ? (
          <Panel className="p-4 text-sm text-muted-foreground">The Monday report has not run yet. It lands here and as a phone notification.</Panel>
        ) : (
          <Panel className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <HeartPulse className="size-4 text-primary" />
              Week of {payload.weekStart}
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <Stat label="View snapshots" value={String(payload.views)} />
              <Stat label="Favorite snapshots" value={String(payload.favorites)} />
              <Stat label="Eligible paid sales" value={String(payload.sales)} />
              <Stat label="Estimated profit" value={chf(payload.profitChf)} />
              <Stat label="Estimated VAT" value={chf(payload.vatChf)} />
              <Stat label="Estimated POD cost" value={chf(payload.podCostChf)} />
              <Stat label="Ad estimate" value={chf(payload.adsEstimateChf ?? payload.adsChf ?? 0)} />
              <Stat label="Actual ads" value={chf(payload.adsActualChf ?? 0)} />
            </div>
            <p className="text-xs text-muted-foreground">Views and favorites are cumulative listing snapshots, not weekly traffic or a conversion rate. Recommendations require a check within 36h and human approval. No listing, inventory or ad changes are applied.</p>
            <p className="text-xs text-muted-foreground">Canceled and refund-pending receipts are excluded from sales and financial totals; their recorded values remain in the order audit list.</p>
            {!reviewable ? (
              <p className="text-xs text-muted-foreground">Recommendations withheld: regenerate the health report with fresh, shop-owned analytics evidence.</p>
            ) : payload.suggestions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No supported refresh or retire candidates. Missing or stale analytics, demo and dry-run rows are excluded.</p>
            ) : (
              <ul className="space-y-2">
                {payload.suggestions.map((item) => (
                  <li key={`${item.action}-${item.listingId}`} className="text-sm">
                    <span className="font-semibold">Review {item.action}</span>
                    <span className="text-muted-foreground"> · {item.title}</span>
                    <div className="text-xs text-muted-foreground">{item.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>

      {stalled.length > 0 && (
        <div>
          <SectionTitle
            action={
              <Link href="/orders" className="text-xs font-medium text-primary">
                Orders
              </Link>
            }
          >
            Fulfillment watch
          </SectionTitle>
          <Panel className="divide-y divide-border overflow-hidden">
            {stalled.map((order) => (
              <div key={order.id} className="flex items-start gap-2 px-4 py-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <div className="font-medium">{order.title ?? order.etsyReceiptId}</div>
                  <div className="text-xs text-muted-foreground">
                    {order.podOrderId} has not moved for 48 hours. Still {order.fulfillmentStatus.replaceAll("_", " ")}.
                  </div>
                </div>
              </div>
            ))}
          </Panel>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="tabular font-semibold">{value}</div>
    </div>
  );
}
