import Link from "next/link";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { designBriefs, designs, listings } from "@/db/schema";
import { resolveRequestShop } from "@/lib/shops";
import { BrainPage, Empty } from "@/components/brain/shell";
import { noteHref } from "@/lib/brain/vault";

export const dynamic = "force-dynamic";
export default async function BrainProducts() {
  const db = await getDb();
  const shop = await resolveRequestShop(db);
  const briefs = await db.select().from(designBriefs).where(and(eq(designBriefs.shopId, shop.id), isNotNull(designBriefs.brainOrigin))).orderBy(desc(designBriefs.id)).limit(50);
  const ids = briefs.map(b => b.keywordId);
  const artwork = ids.length ? await db.select().from(designs).where(and(eq(designs.shopId, shop.id), inArray(designs.keywordId, ids))).orderBy(desc(designs.id)).limit(100) : [];
  const products = ids.length ? await db.select({ id: listings.id, keywordId: listings.keywordId, status: listings.status, title: listings.title, deliveryUrl: listings.deliveryUrl, fileManifest: listings.fileManifest }).from(listings).where(and(eq(listings.shopId, shop.id), inArray(listings.keywordId, ids))).limit(200) : [];
  return <BrainPage>
    <div className="page-head"><div><h2>Reel → product progress</h2><p>Saved inspiration → approved original brief → generated artwork → verified deliverable → human approval.</p></div><Link href="/brain/ideas">Ideas</Link></div>
    <p className="small muted">Source links show inspiration and generation history. They do not prove originality or commercial rights. Inspect the artwork and actual buyer file before publishing.</p>
    {!briefs.length && <Empty title="No original product briefs yet">Open a saved reel or approve a reel-backed idea with a product and your original direction.</Empty>}
    <div className="grid">{briefs.map(b => {
      const origin = b.brainOrigin!;
      const art = artwork.find(d => d.keywordId === b.keywordId);
      const rows = products.filter(l => l.keywordId === b.keywordId);
      return <div className="card" key={b.id}>
        <h3><Link href={noteHref(origin.noteId)}>{origin.title}</Link></h3>
        <p className="small">{origin.product} · brief #{b.id} · keyword #{b.keywordId}</p>
        <p className="small">{origin.direction}</p>
        <ul className="small">{origin.reels.map(r => <li key={r.id}><a href={r.url ?? noteHref(r.id)} target="_blank" rel="noopener noreferrer">{r.title}</a></li>)}</ul>
        <p className="small">{art ? `Artwork #${art.id}: ${art.status} · ${art.provider} · ${art.imageWidth ?? "?"}×${art.imageHeight ?? "?"}px${art.isDemo ? " · DEMO: not a real product" : ""}` : "Waiting for artwork. Check Mac worker jobs and provider configuration."}</p>
        {art && <Link href={art.imageUrl} target="_blank" rel="noopener noreferrer">Open generated artwork</Link>}
        {art?.qualityReasons.map(r => <p className="small" key={r}>{r}</p>)}
        {rows.map(l => <div key={l.id} className="small"><strong>{l.title}</strong><p>Listing #{l.id}: {l.status} · {l.fileManifest?.delivery ? "Measured delivery file recorded" : "Buyer file not measured yet"}</p>{l.deliveryUrl && <a href={l.deliveryUrl} target="_blank" rel="noopener noreferrer">Open actual buyer file</a>}</div>)}
        <p className="small"><Link href="/pipeline/box">Worker jobs</Link> · <Link href="/queue">Approval queue</Link></p>
      </div>;
    })}</div>
  </BrainPage>;
}
