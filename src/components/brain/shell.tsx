/** Page wrapper inside the /brain layout (chrome comes from AppShell + BrainNav). */
export function BrainPage({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
export function Empty({ icon = "∅", title, children }: { icon?: string; title: string; children?: React.ReactNode }) {
  return <div className="empty"><div className="ico">{icon}</div><div style={{ color: "var(--text)", fontWeight: 600 }}>{title}</div>{children && <div className="small" style={{ marginTop: 4 }}>{children}</div>}</div>;
}
