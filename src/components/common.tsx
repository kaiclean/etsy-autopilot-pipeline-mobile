import {
  BarChart3Icon,
  Lightbulb,
  Megaphone,
  Paintbrush,
  PenLine,
  Receipt,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { FulfillmentStatus, ListingStatus, StageName } from "@/db/schema";
import { NICHES } from "@/lib/niches";
import { cn } from "@/lib/utils";

export const STAGE_ICONS: Record<StageName, LucideIcon> = {
  research: Lightbulb,
  design: Paintbrush,
  listing: PenLine,
  publish: Send,
  orders: Receipt,
  analytics: BarChart3Icon,
};

export const AdsIcon = Megaphone;

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</h2>
      {action}
    </div>
  );
}

export function Panel({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-2xl border border-border bg-card", className)} {...props} />;
}

const LISTING_STYLE: Record<ListingStatus, { label: string; cls: string }> = {
  pending_approval: { label: "Awaiting approval", cls: "bg-warning/15 text-warning" },
  approved: { label: "Approved", cls: "bg-chart-4/15 text-chart-4" },
  pod_created: { label: "Printify only", cls: "bg-chart-4/15 text-chart-4" },
  publishing: { label: "Awaiting Etsy id", cls: "bg-warning/15 text-warning" },
  published: { label: "On Etsy", cls: "bg-success/15 text-success" },
  rejected: { label: "Rejected", cls: "bg-muted text-muted-foreground" },
  failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
};

export function ListingStatusPill({ status, dryRun }: { status: ListingStatus; dryRun?: boolean }) {
  const s = LISTING_STYLE[status];
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap", s.cls)}>
      {status === "published" && dryRun ? "Dry-run" : s.label}
    </span>
  );
}

const FULFILL: Record<FulfillmentStatus, { label: string; cls: string }> = {
  delivered_digital: { label: "Auto-delivered", cls: "bg-success/15 text-success" },
  pending: { label: "Awaiting POD", cls: "bg-warning/15 text-warning" },
  in_production: { label: "In production", cls: "bg-chart-4/15 text-chart-4" },
  shipped: { label: "Shipped", cls: "bg-chart-5/15 text-chart-5" },
  delivered: { label: "Delivered", cls: "bg-success/15 text-success" },
};

export function FulfillmentPill({ status }: { status: FulfillmentStatus }) {
  const s = FULFILL[status];
  return <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap", s.cls)}>{s.label}</span>;
}

export function NicheTag({ niche }: { niche: keyof typeof NICHES }) {
  const n = NICHES[niche];
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full" style={{ background: n.color }} />
      {n.short}
    </span>
  );
}

export function Thumb({ src, alt, className }: { src: string | null | undefined; alt: string; className?: string }) {
  if (!src) return <div className={cn("rounded-xl bg-muted", className)} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading="lazy" className={cn("rounded-xl bg-muted object-cover", className)} />
  );
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: LucideIcon; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="font-semibold">{title}</div>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Delta({ cur, prev, invert }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev && !cur) return <span className="text-xs text-muted-foreground">No change</span>;
  if (!prev) return <span className="text-xs font-medium text-success">New</span>;
  const d = ((cur - prev) / Math.abs(prev)) * 100;
  const good = invert ? d < 0 : d >= 0;
  return (
    <span className={cn("tabular text-xs font-semibold", good ? "text-success" : "text-destructive")}>
      {d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(0)}%
    </span>
  );
}
