import { BrainPage as Shell } from "@/components/brain/shell";
import { getDb } from "@/db";
import type { Theme } from "@/db/schema";
import { NICHES, isNichePaused } from "@/lib/niches";
import { ALL_PRODUCTS, PRODUCT_LABEL, THEME_STATUSES, listThemes, themeRunnable } from "@/lib/themes";
import { saveThemeAction } from "./actions";
export const dynamic = "force-dynamic";

const STATUS_PILL: Record<string, string> = { active: "ok", proposed: "res", paused: "", retired: "bad" };

function ThemeForm({ t }: { t?: Theme }) {
  return (
    <form action={saveThemeAction} className="theme-form">
      {t && <input type="hidden" name="id" value={t.id} />}
      {t && <input type="hidden" name="source" value={t.source} />}
      <label>Name<input name="label" defaultValue={t?.label} required maxLength={80} /></label>
      <div className="pipe-row">
        <label style={{ flex: 1 }}>Production niche
          <select name="baseNiche" defaultValue={t?.baseNiche ?? "alpine"}>{Object.values(NICHES).map((n) => <option key={n.id} value={n.id}>{n.label}{isNichePaused(n.id) ? " (paused)" : ""}</option>)}</select>
        </label>
        <label style={{ flex: 1 }}>Status
          <select name="status" defaultValue={t?.status ?? "proposed"}>{THEME_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
      </div>
      <label>Seed buyer phrases (one per line)<textarea name="seeds" defaultValue={t?.seeds.join("\n")} /></label>
      <label>Look (image prompt, optional)<textarea name="style" defaultValue={t?.style ?? ""} maxLength={400} /></label>
      <div className="chk">{ALL_PRODUCTS.map((p) => <label key={p}><input type="checkbox" name="products" value={p} defaultChecked={t ? t.products.includes(p) : p === "wall-art"} />{PRODUCT_LABEL[p]}</label>)}</div>
      <label>Peak months (1-12, comma separated; empty = evergreen)<input name="peakMonths" defaultValue={t?.peakMonths.map((m) => m + 1).join(", ")} /></label>
      <label>Blocker (why it cannot run yet)<input name="blocker" defaultValue={t?.blocker ?? ""} maxLength={400} /></label>
      <label>Notes<input name="notes" defaultValue={t?.notes ?? ""} maxLength={1000} /></label>
      <button className="btn-primary" type="submit">{t ? "Save theme" : "Add theme"}</button>
    </form>
  );
}

export default async function Themes({ searchParams }: { searchParams: Promise<{ err?: string; saved?: string }> }) {
  const { err, saved } = await searchParams;
  const themes = await listThemes(await getDb());
  const live = themes.filter(themeRunnable).length;
  return (
    <Shell>
      {err && <div className="notice" role="alert">{err} Nothing was saved.</div>}
      {saved && <div className="notice ok" role="status">✓ Saved “{saved}”.</div>}
      <div className="page-head"><div><h2>Themes</h2><p>{themes.length} themes · {live} feeding research. A theme rides on a production niche, so prices, product mix and delivery rules stay enforced. Only active themes without a blocker feed the pipeline.</p></div></div>
      <div className="themes-grid">
        {themes.map((t) => (
          <details key={t.id} id={t.id} className="card" open={saved === t.id}>
            <summary style={{ cursor: "pointer", listStyle: "none" }}>
              <div className="row between"><b>{t.label}</b><span className={"pill " + STATUS_PILL[t.status]}>{t.status}</span></div>
              <div className="xs muted" style={{ marginTop: 4 }}>{NICHES[t.baseNiche]?.short} · {t.products.map((p) => PRODUCT_LABEL[p]).join(", ")} · {t.seeds.length} seeds{t.peakMonths.length ? ` · peaks ${t.peakMonths.map((m) => m + 1).join("/")}` : " · evergreen"}</div>
              {t.blocker && <div className="xs" style={{ marginTop: 6, color: "var(--warn, #fbbf24)" }}>⚠ {t.blocker}</div>}
              {t.notes && <div className="xs faint" style={{ marginTop: 6 }}>{t.notes}</div>}
            </summary>
            <div style={{ marginTop: 12 }}><ThemeForm t={t} /></div>
          </details>
        ))}
        <div className="card"><h3 style={{ marginTop: 0 }}>New theme</h3><ThemeForm /></div>
      </div>
    </Shell>
  );
}
