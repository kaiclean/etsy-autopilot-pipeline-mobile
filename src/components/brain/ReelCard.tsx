import Image from "next/image";
import Link from "next/link";
import type { IndexDoc } from "@/lib/brain/vault";
const href = (id: string) => "/brain/note/" + id.split("/").map(encodeURIComponent).join("/");
const dur = (s: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
export default function ReelCard({ d, i = 0, children }: { d: IndexDoc; i?: number; children?: React.ReactNode }) {
  return (
    <Link href={href(d.id)} className="reel-card fade-up" style={{ animationDelay: `${Math.min(i, 24) * 28}ms` }}>
      <div className="thumb">
        {d.thumb ? <Image src={d.thumb} alt="" width={320} height={180} unoptimized /> : <div className="thumb-ph">▶</div>}
        <div className="thumb-grad" />
        {d.duration > 0 && <span className="dur">{dur(d.duration)}</span>}
        <span className={"st st-" + d.status}>{d.status}</span>
        <span className="play">▶</span>
      </div>
      <div className="rc-body">
        <div className="rc-title">{children ?? d.title}</div>
        <div className="xs muted row between"><span>@{d.handle || "unknown"}</span><span>{d.date || "—"}</span></div>
      </div>
    </Link>
  );
}
