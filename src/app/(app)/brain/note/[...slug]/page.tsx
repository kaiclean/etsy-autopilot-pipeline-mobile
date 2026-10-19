import { clip } from "@/lib/brain/quicksearch";
import Link from "next/link";
import { Fragment } from "react";
import { notFound } from "next/navigation";
import { BrainPage as Shell } from "@/components/brain/shell";
import { getVault, noteHref } from "@/lib/brain/vault";
import { renderMarkdown } from "@/lib/brain/markdown";
export const dynamic = "force-dynamic";
const KC: Record<string, string> = { reel: "var(--reel)", idea: "var(--idea)", summary: "var(--summary)", home: "var(--home)", template: "var(--faint)" };
export default async function NotePage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const v = getVault();
  const n = v.byId.get(slug.map(decodeURIComponent).join("/"));
  if (!n) notFound();
  const backlinks = v.notes.filter((o) => o.links.includes(n.id));
  const url = typeof n.data.url === "string" && n.data.url.startsWith("https://") ? n.data.url : null;
  const meta = Object.entries(n.data).filter(([k, val]) => !["tags", "url", "source_reels"].includes(k) && val !== "" && val != null);
  const folder = n.id.split("/").slice(0, -1).join(" / ");
  const linkList = (ids: string[]) => ids.length ? <>{ids.map((l) => { const t = v.byId.get(l); return <Link key={l} href={noteHref(l)} className="list-item small"><span style={{ color: KC[t?.kind || "home"] }}>●</span> {clip((t?.title || l), 64)}</Link>; })}</> : <div className="xs faint">None</div>;
  return (
    <Shell>
      <div className="crumb"><Link href="/brain">Brain</Link> / {folder ? <Link href={n.kind === "reel" ? "/brain/reels" : n.kind === "idea" ? "/brain/ideas" : "/brain/search"}>{folder}</Link> : "Home"}</div>
      <div className="note-wrap">
        <article className="card note" dangerouslySetInnerHTML={{ __html: renderMarkdown(n.body) }} />
        <aside className="side">
          {(url || meta.length > 0) && <div className="card">
            {url && <a href={url} target="_blank" rel="noopener noreferrer" className="btn-primary" style={{ display: "block", textAlign: "center", padding: "9px 12px", borderRadius: 10, marginBottom: 14, color: "#fff" }}>Open on Instagram ↗</a>}
            <dl className="meta">{meta.map(([k, val]) => <Fragment key={k}><dt>{k.replace(/_/g, " ")}</dt><dd>{String(val)}</dd></Fragment>)}</dl>
            {n.tags.length > 0 && <div style={{ marginTop: 12 }}>{n.tags.map((t) => <Link key={t} href={`/brain/reels?tag=${encodeURIComponent(t)}`} className="pill">{t}</Link>)}</div>}
          </div>}
          <div className="card"><h3>Links · {n.links.length}</h3>{linkList(n.links)}</div>
          <div className="card"><h3>Backlinks · {backlinks.length}</h3>{linkList(backlinks.map((b) => b.id))}</div>
        </aside>
      </div>
    </Shell>
  );
}
