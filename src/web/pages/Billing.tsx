// Settings > Billing: whatever the hosting reports (plan, usage, buttons, notes). No payment provider is named here.
import { useEffect, useState } from "react";
import { get, post, type WorkspaceInfo } from "../api";
import { Button, Spinner } from "../ui";
import { toastError } from "../toast";
import { fmtUsage } from "../limits";

interface BillingView {
  plan: string;
  paid: boolean;
  usage: { key: string; label: string; used: number; limit: number | null }[];
  notice?: string;
  actions: { label: string; url?: string; post?: string; style?: "primary" | "default" }[];
  sections?: { title: string; text: string }[];
}

export function Billing({ ws }: { ws: WorkspaceInfo }) {
  const [view, setView] = useState<BillingView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    get<BillingView>(`/api/workspaces/${ws.id}/billing`)
      .then(setView)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [ws.id]);
  if (error) return <div className="page-err" role="alert">{error}</div>;
  if (!view) return <Spinner size={20} />;

  const act = async (i: number) => {
    const a = view.actions[i];
    if (a.url && !a.post) return void (location.href = a.url);
    setBusy(i);
    try {
      const r = await post<{ url?: string }>(a.post!, { workspaceId: ws.id });
      if (r?.url) location.href = r.url;
      else setBusy(null);
    } catch (e) {
      toastError(e);
      setBusy(null);
    }
  };

  return (
    <div className="stack billing">
      <section className="card section stack">
        <div className="row">
          <h2 className="grow">{view.plan} plan</h2>
          <span className={"role-chip" + (view.paid ? " paid" : "")}>{view.paid ? "Paid" : "Free"}</span>
        </div>
        {view.notice && <div className="banner" role="status">{view.notice}</div>}
        {view.usage.length > 0 && (
          <div className="usage-list">
            {view.usage.map(u => {
              const pct = u.limit ? Math.min(100, (u.used / u.limit) * 100) : 0;
              return (
                <div key={u.key} className="usage-row">
                  <div className="row small">
                    <span className="grow">{u.label}</span>
                    <span className="muted">{fmtUsage(u.key, u.used)}{u.limit ? ` of ${fmtUsage(u.key, u.limit)}` : " (no limit)"}</span>
                  </div>
                  {u.limit !== null && (
                    <div className="usage-bar" role="progressbar" aria-label={u.label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                      <span className={pct >= 100 ? "full" : pct >= 80 ? "near" : ""} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {view.actions.length > 0 && (
          <div className="row" style={{ flexWrap: "wrap" }}>
            {view.actions.map((a, i) => (
              <Button key={i} variant={a.style === "primary" ? "primary" : "default"} onClick={() => act(i)} disabled={busy !== null}>
                {busy === i && <Spinner size={14} />} {a.label}
              </Button>
            ))}
          </div>
        )}
        {ws.role !== "owner" && <p className="muted small">Only workspace owners can change the plan.</p>}
      </section>
      {view.sections?.map(s => (
        <section key={s.title} className="card section stack">
          <h2>{s.title}</h2>
          <p className="billing-text">{s.text}</p>
        </section>
      ))}
    </div>
  );
}
