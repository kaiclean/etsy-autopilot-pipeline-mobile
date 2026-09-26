"use client";

import { ChartColumnBig, House, Inbox, LayoutGrid, Package, Power, Receipt, Settings, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LiveProvider, useLive } from "./live-provider";

type Shell = { pendingCount: number; demo: boolean; killSwitch: boolean };

const MOBILE_TABS = [
  { href: "/", label: "Home", icon: House },
  { href: "/pipeline", label: "Pipeline", icon: Workflow },
  { href: "/queue", label: "Queue", icon: Inbox, badge: true },
  { href: "/orders", label: "Orders", icon: Receipt },
  { href: "/more", label: "More", icon: LayoutGrid, match: ["/more", "/products", "/analytics", "/settings"] },
];

const SIDEBAR = [
  { href: "/", label: "Home", icon: House },
  { href: "/pipeline", label: "Pipeline", icon: Workflow },
  { href: "/queue", label: "Approval queue", icon: Inbox, badge: true },
  { href: "/products", label: "Products", icon: Package },
  { href: "/orders", label: "Orders", icon: Receipt },
  { href: "/analytics", label: "Analytics", icon: ChartColumnBig },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string, match?: string[]) {
  if (match) return match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function LiveDot() {
  const { status } = useLive();
  const label = status === "live" ? "Live" : status === "polling" ? "Polling" : status === "offline" ? "Offline" : "Connecting";
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground" title={`Realtime: ${label}`}>
      <span className="relative flex size-2">
        {status === "live" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            status === "live" ? "bg-success" : status === "polling" ? "bg-warning" : status === "offline" ? "bg-destructive" : "bg-muted-foreground",
          )}
        />
      </span>
      {label}
    </span>
  );
}

function Badges({ demo, killSwitch }: { demo: boolean; killSwitch: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {demo && (
        <Link
          href="/settings"
          className="rounded-md border border-warning/40 bg-warning/15 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-warning"
          title="Demo mode: seeded data and mock/dry-run adapters. Add Etsy keys to go live."
        >
          DEMO
        </Link>
      )}
      {killSwitch && (
        <Link
          href="/settings"
          className="flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-destructive"
        >
          <Power className="size-3" /> PAUSED
        </Link>
      )}
    </div>
  );
}

function CountBadge({ n, className }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <span className={cn("tabular flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground", className)}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function AppShell({ children, shell }: { children: React.ReactNode; shell: Shell }) {
  const pathname = usePathname();
  return (
    <LiveProvider>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-5 md:flex">
          <Link href="/" className="mb-6 flex items-center gap-2.5 px-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/192" alt="" className="size-8 rounded-lg" />
            <div className="leading-tight">
              <div className="text-sm font-semibold">Etsy Autopilot</div>
              <div className="text-[11px] text-muted-foreground">Designed by Kai · CH</div>
            </div>
          </Link>
          <nav className="flex flex-1 flex-col gap-0.5">
            {SIDEBAR.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                    active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <item.icon className={cn("size-[18px]", active && "text-primary")} />
                  <span className="flex-1">{item.label}</span>
                  {item.badge && <CountBadge n={shell.pendingCount} />}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <LiveDot />
            <Badges demo={shell.demo} killSwitch={shell.killSwitch} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 pt-safe backdrop-blur-xl md:hidden">
            <div className="flex h-12 items-center justify-between px-4">
              <Link href="/" className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/192" alt="" className="size-6 rounded-md" />
                <span className="text-sm font-semibold">Autopilot</span>
              </Link>
              <div className="flex items-center gap-3">
                <LiveDot />
                <Badges demo={shell.demo} killSwitch={shell.killSwitch} />
              </div>
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+88px)] md:px-8 md:pt-8 md:pb-12">
            {children}
          </main>
        </div>

        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/85 pb-safe backdrop-blur-xl md:hidden" aria-label="Primary">
          <div className="grid h-16 grid-cols-5">
            {MOBILE_TABS.map((tab) => {
              const active = isActive(pathname, tab.href, tab.match);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className="relative flex flex-col items-center justify-center gap-1 text-[10px] font-medium"
                >
                  <span
                    className={cn(
                      "relative flex h-8 w-14 items-center justify-center rounded-full transition-all duration-200",
                      active ? "bg-primary/15 text-primary" : "text-muted-foreground",
                    )}
                  >
                    <tab.icon className="size-[22px]" strokeWidth={active ? 2.3 : 1.8} />
                    {tab.badge && <CountBadge n={shell.pendingCount} className="absolute -top-1 right-1.5" />}
                  </span>
                  <span className={active ? "text-foreground" : "text-muted-foreground"}>{tab.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </LiveProvider>
  );
}
