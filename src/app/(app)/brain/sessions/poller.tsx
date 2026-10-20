"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
/** Refreshes the server-rendered page every 3s while a session is queued or running. */
export function SessionPoller({ active }: { active: boolean }) {
  const r = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") r.refresh(); }, 3000);
    return () => clearInterval(t);
  }, [active, r]);
  return active ? <span className="pill res" role="status" aria-live="polite">● live</span> : null;
}
