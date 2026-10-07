"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppEvent } from "@/db/schema";
import { SSE_FAILURES_BEFORE_POLL, sseFailuresAfterError } from "@/lib/realtime";

type LiveState = {
  status: "connecting" | "live" | "polling" | "offline";
  latest: AppEvent[];
};

const LiveContext = createContext<LiveState>({ status: "connecting", latest: [] });
export const useLive = () => useContext(LiveContext);

const NOTIFY_TYPES = new Set(["order.new", "approval.pending", "job.failed", "listing.failed", "health.report", "fulfillment.stalled"]);
const QUIET_TYPES = new Set(["job.success", "stage.toggle"]);

async function notify(e: AppEvent) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!NOTIFY_TYPES.has(e.type) || document.visibilityState === "visible") return;
  const reg = await navigator.serviceWorker?.getRegistration();
  const opts = { body: e.body ?? "", icon: "/icons/192", badge: "/icons/192", tag: `ea-${e.id}`, data: { url: e.href ?? "/" } };
  if (reg) reg.showNotification(e.title, opts);
  else new Notification(e.title, opts);
}

/** SSE with automatic fallback to 10s polling; refreshes server components when activity arrives. */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>({ status: "connecting", latest: [] });
  const cursor = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handle = useCallback(
    (e: AppEvent) => {
      if (e.id <= cursor.current) return;
      cursor.current = e.id;
      setState((s) => ({ ...s, latest: [e, ...s.latest].slice(0, 30) }));
      if (!QUIET_TYPES.has(e.type)) {
        const fn = e.severity === "success" ? toast.success : e.severity === "error" ? toast.error : e.severity === "warning" ? toast.warning : toast.info;
        fn(e.title, {
          description: e.body ?? undefined,
          action: e.href ? { label: "Open", onClick: () => router.push(e.href!) } : undefined,
        });
      }
      void notify(e);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 500);
    },
    [router],
  );

  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    let openedAt = 0;
    let stopped = false;

    const startPolling = () => {
      if (pollTimer) return;
      setState((s) => ({ ...s, status: "polling" }));
      const tick = async () => {
        try {
          const res = await fetch(`/api/events/poll?after=${cursor.current}`, { cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const data: { cursor: number; events: AppEvent[] } = await res.json();
          if (!cursor.current) cursor.current = data.cursor;
          data.events.forEach(handle);
          setState((s) => ({ ...s, status: "polling" }));
        } catch {
          setState((s) => ({ ...s, status: "offline" }));
        }
      };
      void tick();
      pollTimer = setInterval(tick, 10_000);
    };

    const connect = () => {
      if (stopped) return;
      if (typeof EventSource === "undefined") return startPolling();
      es = new EventSource(`/api/events${cursor.current ? `?after=${cursor.current}` : ""}`);
      es.onopen = () => {
        openedAt = Date.now();
        setState((s) => ({ ...s, status: "live" }));
      };
      es.addEventListener("activity", (msg) => {
        try {
          handle(JSON.parse((msg as MessageEvent).data));
        } catch {}
      });
      es.onerror = () => {
        failures = sseFailuresAfterError(openedAt, Date.now(), failures);
        openedAt = 0;
        if (failures >= SSE_FAILURES_BEFORE_POLL) {
          es?.close();
          es = null;
          startPolling();
        } else {
          setState((s) => ({ ...s, status: "connecting" }));
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [handle]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}
