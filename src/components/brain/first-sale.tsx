import Link from "next/link";
import CountUp from "./CountUp";
import { FIRST_SALE_NEXT, type FirstSale } from "@/lib/brain/first-sale";

const chf = (v: number) => `CHF ${v.toFixed(2)}`;

/** Road to the first real sale: pipeline counts per stage, queue, live listings, orders. */
export default function FirstSaleTracker({ f, publishMode }: { f: FirstSale; publishMode: string }) {
  const steps = [
    { label: "Keywords queued", value: f.keywordsSelected, sub: `${f.keywordsNew} in backlog · ${f.candidates} candidates`, href: "/pipeline" },
    { label: "Designs", value: f.designsGenerated, sub: `${f.briefs} briefs${f.designsNeedReview ? ` · ${f.designsNeedReview} need review` : ""}`, href: "/pipeline" },
    { label: "Pending approval", value: f.pendingApproval, sub: f.qualityHeld ? `${f.qualityHeld} held by quality gate` : "your call in the queue", href: "/queue" },
    { label: "Approved", value: f.approved, sub: `publish mode: ${publishMode}`, href: "/products" },
    { label: "Live on Etsy", value: f.live, sub: f.dryRunPublished ? `${f.dryRunPublished} dry-run only` : "real listing ids", href: "/products" },
    { label: "Orders", value: f.orders, sub: f.orders ? `${chf(f.revenueChf)} · profit ${chf(f.profitChf)} (est.)` : "no real sale yet", href: "/orders" },
  ];
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="row between"><h3 style={{ margin: 0 }}>🎯 Road to the first sale{f.demo ? " · demo data" : ""}</h3><span className="xs muted">Stage {f.stage} of 5</span></div>
      <div className="bar" aria-hidden><span style={{ width: `${(f.stage / 5) * 100}%` }} /></div>
      <div className="funnel" style={{ marginTop: 14 }}>
        {steps.map((s, i) => (
          <Link key={s.label} href={s.href} className={"step" + (i === steps.length - 1 ? " goal" : "")} style={{ color: "inherit", textDecoration: "none" }}>
            <span className="xs muted">{s.label}</span><b><CountUp to={s.value} /></b><span className="xs faint">{s.sub}</span>
          </Link>
        ))}
      </div>
      <p className="small" style={{ margin: "12px 0 0" }}><span className="faint">Next · </span>{FIRST_SALE_NEXT[f.stage]}</p>
    </div>
  );
}
