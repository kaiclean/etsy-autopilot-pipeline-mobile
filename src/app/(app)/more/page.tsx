import { ChartColumnBig, ChevronRight, LogOut, Package, Settings } from "lucide-react";
import Link from "next/link";
import { logout } from "@/app/actions";
import { PageHeader, Panel } from "@/components/common";

export const metadata = { title: "More" };

const LINKS = [
  { href: "/products", label: "Products & listings", desc: "Every draft, live and rejected listing", icon: Package },
  { href: "/analytics", label: "Analytics", desc: "Revenue, profit, niches, costs", icon: ChartColumnBig },
  { href: "/settings", label: "Settings", desc: "Keys, budgets, schedules, kill switch", icon: Settings },
];

export default function MorePage() {
  return (
    <div>
      <PageHeader title="More" />
      <Panel className="divide-y divide-border overflow-hidden">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="flex items-center gap-3.5 px-4 py-4 active:bg-muted/50">
            <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
              <l.icon className="size-5" />
            </span>
            <span className="flex-1">
              <span className="block font-medium">{l.label}</span>
              <span className="block text-xs text-muted-foreground">{l.desc}</span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
      </Panel>
      <form action={logout} className="mt-4">
        <button className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border py-3.5 text-sm font-medium text-muted-foreground active:bg-muted/50">
          <LogOut className="size-4" /> Sign out
        </button>
      </form>
    </div>
  );
}
