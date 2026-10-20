import Link from "next/link";
import { BrainPage as Shell, Empty } from "@/components/brain/shell";
import { getVault, noteHref, sectionOf, type Note } from "@/lib/brain/vault";
import { latestByIdea, keywordStatuses, type Decision } from "@/lib/brain/decisions";
import { mapIdea, type Mapping } from "@/lib/brain/mapper";
import { pendingCandidates } from "@/lib/brain/idea-feed";
import { listThemes, themeRunnable, PRODUCT_LABEL } from "@/lib/themes";
import { getDb } from "@/db";
import type { IdeaCandidate, Theme } from "@/db/schema";
import { decideIdea, decideCandidateAction } from "./actions";
import { renderMarkdown } from "@/lib/brain/markdown";
export const dynamic = "force-dynamic";
const COLS = ["idea", "validating", "building", "shipped"];
const clip = (s: string, n = 240) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join("").replace(/\s\S*$/, "") + "…" : s; };
const VERDICT: Record<string, string> = { approved: "ok", rejected: "bad", needs_research: "res" };
const KIND: Record<Mapping["kind"], string> = { product: "Etsy product", software: "Software", content: "Content" };

/** Theme picker + phrase + the explicit confirm. Nothing reaches the pipeline without the tick. */
function PipelineFields({ themes, themeId, phrase, legend }: { themes: Theme[]; themeId?: string | null; phrase: string; legend: string }) {
  const runnable = themes.filter(themeRunnable);
  return (
    <fieldset className="pipe">
      <legend>{legend}</legend>
      <div className="pipe-row">
        <select name="theme" defaultValue={themeId && runnable.some((t) => t.id === themeId) ? themeId : runnable[0]?.id} aria-label="Theme">
          {runnable.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <input name="phrase" defaultValue={phrase} maxLength={80} aria-label="Primary buyer phrase" placeholder="Primary buyer phrase" />
      </div>
      <label className="pipe-ok"><input type="checkbox" name="confirm" /><span>I confirm this buyer phrase. Approving creates a keyword and design brief. The design uses the existing daily AI budget, then must pass the quality gate and wait in the approval queue. Nothing publishes on its own.</span></label>
    </fieldset>
  );
}

function MapLine({ m }: { m: Mapping }) {
  return (
    <div className="map">
      <span className={"pill " + (m.pipelineReady ? "ok" : m.kind === "product" ? "res" : "")}>{KIND[m.kind]}{m.productLabel ? ` · ${m.productLabel}` : ""}</span>
      {m.theme && <span className="pill hi">{m.theme.label}</span>}
      <span className="xs muted">{m.reason}</span>
      {m.derivative && <div className="xs" style={{ marginTop: 6 }}><span className="faint">Etsy derivative · </span><b>{m.derivative.title}</b> <span className="muted">({PRODUCT_LABEL[m.derivative.product]}, phrase “{m.derivative.phrase}”). {m.derivative.note}</span></div>}
    </div>
  );
}

function IdeaCard({ i, d, actions, compact, m, themes, kwStatus }: { i: Note; d?: Decision; actions: boolean; compact?: boolean; m: Mapping; themes: Theme[]; kwStatus?: string }) {
  const src = Array.isArray(i.data.source_reels) ? (i.data.source_reels as string[]) : [];
  const artwork = m.kind === "product" && m.product && ["wall-art", "poster", "pod-apparel", "pod-mug"].includes(m.product);
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
        <MapLine m={m} />
      </>}
      {d?.keywordId && <div className="small" style={{ marginTop: 8 }}>⚙ In pipeline as <Link href="/pipeline">“{d.phrase}”</Link> · {d.niche} · keyword {kwStatus ?? "…"}</div>}
      {d?.comment && <div className="small" style={{ marginTop: 8 }}>💬 {d.comment}</div>}
      {actions && (
        <form action={decideIdea} className="decide">
          <input type="hidden" name="idea" value={i.id} />
          {artwork && <PipelineFields themes={themes} themeId={m.theme?.id} phrase={m.phrase ?? ""} legend={m.pipelineReady ? "Send to the design pipeline on approve" : "Optional: pick a theme to send it to the pipeline"} />}
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

function CandidateCard({ c, themes }: { c: IdeaCandidate; themes: Theme[] }) {
  const theme = themes.find((t) => t.id === c.themeId);
  return (
    <div className="card idea">
      <div className="title">{c.title}</div>
      <div style={{ marginTop: 6 }}>
        {theme && <span className="pill hi">{theme.label}</span>}
        {c.product && <span className="pill">{PRODUCT_LABEL[c.product]}</span>}
        <span className="pill">{c.source}</span>
      </div>
      <p className="small muted">{c.rationale}</p>
      <form action={decideCandidateAction} className="decide">
        <input type="hidden" name="candidate" value={c.id} />
        <PipelineFields themes={themes} themeId={c.themeId} phrase={c.phrase} legend="Send to the design pipeline" />
        <div className="acts" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button className="b-ok" name="verdict" value="approved">✓ Approve</button>
          <button className="b-bad" name="verdict" value="rejected">✕ Dismiss</button>
        </div>
      </form>
    </div>
  );
}

const MSG: Record<string, [string, string]> = {
  saved: ["ok", "✓ Decision saved."],
  backlog: ["ok", "✓ Approved and kept in the backlog (no pipeline keyword)."],
  pipeline: ["ok", "✓ Approved. Keyword and design brief created; the next design run picks it up."],
  existing: ["ok", "✓ Approved. That phrase was already a keyword, so it was linked instead of duplicated."],
  dismissed: ["ok", "✓ Candidate dismissed."],
  confirm: ["", "Tick the confirm box to send a candidate to the pipeline. Nothing was saved."],
  phrase: ["", "That buyer phrase needs 2+ words, 4–80 characters. Nothing was saved."],
  theme: ["", "That theme is not active. Activate it under Themes first. Nothing was saved."],
  niche: ["", "That theme is paused or unknown. Nothing was saved."],
  bad: ["", "Unknown idea or verdict."],
  error: ["", "Saving failed. Nothing was sent to the pipeline; try again."],
};

export default async function Ideas({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = await getDb();
  const themes = await listThemes(db);
  const ideas = getVault().notes.filter((n) => n.kind === "idea");
  const maps = new Map(ideas.map((i) => [i.id, mapIdea(i, themes)]));
  const dec = await latestByIdea();
  const kw = await keywordStatuses([...dec.values()].flatMap((d) => (d.keywordId ? [d.keywordId] : []))).catch(() => new Map<number, string>());
  const candidates = await pendingCandidates(db).catch(() => []);
  const queue = ideas.filter((i) => !dec.has(i.id) || dec.get(i.id)!.verdict === "needs_research");
  const approved = ideas.filter((i) => dec.get(i.id)?.verdict === "approved");
  const ready = queue.filter((i) => maps.get(i.id)!.pipelineReady).length;
  const m = msg ? MSG[msg] : undefined;
  return (
    <Shell>
      {m && <div className={"notice " + m[0]} role="status">{m[1]}</div>}
      <div className="page-head"><div><h2>Approval queue</h2><p>{queue.length ? `${queue.length} idea${queue.length === 1 ? "" : "s"} waiting · ${ready} ready for the design pipeline. Software ideas show an honest Etsy derivative where one exists.` : "You're all caught up."}</p></div><Link href="/brain/themes" className="btn-ghost small">Themes →</Link></div>
      {queue.length ? <div className="grid">{queue.map((i) => <IdeaCard key={i.id} i={i} d={dec.get(i.id)} actions m={maps.get(i.id)!} themes={themes} />)}</div>
        : <Empty icon="✓" title="Inbox zero">Every idea has a decision. New ones appear here after the next vault sync.</Empty>}
      <div className="page-head" id="candidates" style={{ marginTop: 40 }}><div><h2>New candidates</h2><p>From the daily idea step: seasonal theme phrases and trending signals. Rule-based, no AI spend.</p></div></div>
      {candidates.length ? <div className="grid">{candidates.map((c) => <CandidateCard key={c.id} c={c} themes={themes} />)}</div>
        : <Empty icon="✦" title="No candidates waiting">The idea step runs with research each day.</Empty>}
      <div className="page-head" style={{ marginTop: 40 }}><div><h2>Approved</h2><p>{approved.filter((i) => dec.get(i.id)?.keywordId).length} in the pipeline · {approved.filter((i) => !dec.get(i.id)?.keywordId).length} in the backlog</p></div></div>
      {approved.length ? <div className="grid">{approved.map((i) => { const d = dec.get(i.id)!; return <IdeaCard key={i.id} i={i} d={d} actions={false} compact m={maps.get(i.id)!} themes={themes} kwStatus={d.keywordId ? kw.get(d.keywordId) : undefined} />; })}</div>
        : <Empty icon="✦" title="Nothing approved yet" />}
      <div className="page-head" style={{ marginTop: 40 }}><div><h2>Ideas board</h2><p>By pipeline status from the vault frontmatter.</p></div></div>
      <div className="kanban">
        {COLS.map((c) => {
          const items = ideas.filter((i) => String(i.data.status || "idea") === c);
          return (<div key={c} className="col"><div className="col-h"><span>{c}</span><span className="pill">{items.length}</span></div>
            {items.length ? items.map((i) => <IdeaCard key={i.id} i={i} d={dec.get(i.id)} actions={false} compact m={maps.get(i.id)!} themes={themes} />) : <div className="empty xs" style={{ padding: 18 }}>Nothing {c} yet</div>}</div>);
        })}
      </div>
    </Shell>
  );
}
