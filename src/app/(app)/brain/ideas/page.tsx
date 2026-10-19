import Link from "next/link";
import { BrainPage as Shell, Empty } from "@/components/brain/shell";
import { getVault, noteHref, sectionOf, Note } from "@/lib/brain/vault";
import { latestByIdea, keywordStatuses, type Decision } from "@/lib/brain/decisions";
import { themeFit, type ThemeFit } from "@/lib/brain/fit";
import { activeNiches } from "@/lib/niches";
import { decideIdea } from "./actions";
import { renderMarkdown } from "@/lib/brain/markdown";
export const dynamic = "force-dynamic";
const COLS = ["idea", "validating", "building", "shipped"];
const clip = (s: string, n = 240) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join("").replace(/\s\S*$/, "") + "…" : s; };
const VERDICT: Record<string, string> = { approved: "ok", rejected: "bad", needs_research: "res" };

function IdeaCard({ i, d, actions, compact, fit, kwStatus }: { i: Note; d?: Decision; actions: boolean; compact?: boolean; fit?: ThemeFit | null; kwStatus?: string }) {
  const src = Array.isArray(i.data.source_reels) ? (i.data.source_reels as string[]) : [];
  return (
    <div className="card idea" id={actions ? i.id : undefined}>
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <Link href={noteHref(i.id)} className="title">{i.title}</Link>
        {d && <span className={"pill " + VERDICT[d.verdict]}>{d.verdict.replace("_", " ")}{d.priority ? ` · P${d.priority}` : ""}</span>}
      </div>
      <div style={{ marginTop: 6 }}><span className="pill">{String(i.data.type)}</span><span className={"pill" + (i.data.potential === "high" ? " hi" : "")}>{String(i.data.potential)} potential</span><span className="pill">effort {String(i.data.effort)}</span></div>
      {!compact && <>
        <p className="small">{clip(sectionOf(i.body, "Concept"))}</p>
        <div className="small"><span className="faint">Etsy fit · </span><span className="muted">{clip(sectionOf(i.body, "Etsy fit").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a), 180)}</span></div>
        <div className="xs muted" style={{ marginTop: 6 }} dangerouslySetInnerHTML={{ __html: `<span class="faint">${src.length} source reel${src.length === 1 ? "" : "s"} · </span>` + renderMarkdown(src.join(" · ")).replace(/^<p>|<\/p>\s*$/g, "") }} />
      </>}
      {d?.keywordId && <div className="small" style={{ marginTop: 8 }}>⚙ In pipeline as <Link href="/pipeline">“{d.phrase}”</Link> · {d.niche} · keyword {kwStatus ?? "…"}</div>}
      {!compact && !d?.keywordId && fit && <div className="xs" style={{ marginTop: 8 }}><span className="pill hi">fits {fit.label}</span><span className="faint">matched {fit.matched.slice(0, 4).join(", ")}</span></div>}
      {d?.comment && <div className="small" style={{ marginTop: 8 }}>💬 {d.comment}</div>}
      {actions && (
        <form action={decideIdea} className="decide">
          <input type="hidden" name="idea" value={i.id} />
          {fit && (
            <fieldset className="pipe">
              <legend>Send to the design pipeline on approve</legend>
              <div className="pipe-row">
                <select name="niche" defaultValue={fit.niche} aria-label="Theme">{activeNiches().map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</select>
                <input name="phrase" defaultValue={fit.phrase} maxLength={80} aria-label="Etsy search phrase" placeholder="Etsy search phrase" />
              </div>
              <label className="pipe-ok"><input type="checkbox" name="confirm" /><span>I confirm this search phrase. Approving creates a keyword and design brief; the design still passes the quality gate and the approval queue.</span></label>
            </fieldset>
          )}
          <input name="comment" placeholder="Comment (optional)" maxLength={2000} aria-label="Comment" />
          <select name="priority" defaultValue="" aria-label="Priority"><option value="">Priority</option>{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}</select>
          <div className="acts">
            <button className="b-ok" name="verdict" value="approved">✓ Approve</button>
            <button className="b-res" name="verdict" value="needs_research">? Research</button>
            <button className="b-bad" name="verdict" value="rejected">✕ Reject</button>
          </div>
        </form>
      )}
    </div>
  );
}

const MSG: Record<string, [string, string]> = {
  saved: ["ok", "✓ Decision saved."],
  backlog: ["ok", "✓ Approved and kept in the backlog (no pipeline keyword)."],
  pipeline: ["ok", "✓ Approved. Keyword and design brief created; the next design run picks it up."],
  existing: ["ok", "✓ Approved. That phrase was already a keyword, so it was linked instead of duplicated."],
  phrase: ["", "That search phrase needs 2+ words, 4–80 characters. Nothing was saved."],
  niche: ["", "That theme is paused or unknown. Nothing was saved."],
  bad: ["", "Unknown idea or verdict."],
  error: ["", "Saving failed. Nothing was sent to the pipeline; try again."],
};

export default async function Ideas({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const ideas = getVault().notes.filter((n) => n.kind === "idea");
  const dec = await latestByIdea();
  const kw = await keywordStatuses([...dec.values()].flatMap((d) => (d.keywordId ? [d.keywordId] : []))).catch(() => new Map<number, string>());
  const queue = ideas.filter((i) => !dec.has(i.id) || dec.get(i.id)!.verdict === "needs_research");
  const approved = ideas.filter((i) => dec.get(i.id)?.verdict === "approved");
  const m = msg ? MSG[msg] : undefined;
  return (
    <Shell>
      {m && <div className={"notice " + m[0]} role="status">{m[1]}</div>}
      <div className="page-head"><div><h2>Approval queue</h2><p>{queue.length ? `${queue.length} idea${queue.length === 1 ? "" : "s"} waiting for your call. Product ideas that fit a theme can go straight to the design pipeline.` : "You're all caught up."}</p></div></div>
      {queue.length ? <div className="grid">{queue.map((i) => <IdeaCard key={i.id} i={i} d={dec.get(i.id)} actions fit={themeFit(i)} />)}</div>
        : <Empty icon="✓" title="Inbox zero">Every idea has a decision. New ones appear here after the next vault sync.</Empty>}
      <div className="page-head" style={{ marginTop: 40 }}><div><h2>Approved</h2><p>{approved.filter((i) => dec.get(i.id)?.keywordId).length} in the pipeline · {approved.filter((i) => !dec.get(i.id)?.keywordId).length} in the backlog</p></div></div>
      {approved.length ? <div className="grid">{approved.map((i) => { const d = dec.get(i.id)!; return <IdeaCard key={i.id} i={i} d={d} actions={false} compact kwStatus={d.keywordId ? kw.get(d.keywordId) : undefined} />; })}</div>
        : <Empty icon="✦" title="Nothing approved yet" />}
      <div className="page-head" style={{ marginTop: 40 }}><div><h2>Ideas board</h2><p>By pipeline status from the vault frontmatter.</p></div></div>
      <div className="kanban">
        {COLS.map((c) => {
          const items = ideas.filter((i) => String(i.data.status || "idea") === c);
          return (<div key={c} className="col"><div className="col-h"><span>{c}</span><span className="pill">{items.length}</span></div>
            {items.length ? items.map((i) => <IdeaCard key={i.id} i={i} d={dec.get(i.id)} actions={false} compact />) : <div className="empty xs" style={{ padding: 18 }}>Nothing {c} yet</div>}</div>);
        })}
      </div>
    </Shell>
  );
}
