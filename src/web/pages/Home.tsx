import { useCallback, useEffect, useState, type FormEvent } from "react";
import { del, get, getConfig, patch, post, type AppConfig, type Me, type WorkspaceInfo } from "../api";
import { Link, navigate } from "../router";
import { Avatar, Button, confirmDialog, Empty, Icon, Logo, Menu, Modal, Spinner, type MenuItem } from "../ui";
import { toastError } from "../toast";
import { fmtUsage, limitOf, setLimitContext, upgradeTarget } from "../limits";
import "./pages.css";

interface BaseRow {
  id: string;
  name: string;
  color: string;
  created_at: number;
}

const WS_KEY = "rowflare:workspace";

function readStored(): string | null {
  try {
    return localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
}

function store(id: string) {
  try {
    localStorage.setItem(WS_KEY, id);
  } catch {
    // Storage may be unavailable (private mode); the choice is simply not remembered.
  }
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0]!.toUpperCase())
    .join("") || "?";

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [wsId, setWsId] = useState<string | null>(null);
  const [bases, setBases] = useState<BaseRow[] | null>(null);
  const [wsMenu, setWsMenu] = useState<HTMLElement | null>(null);
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);
  const [modal, setModal] = useState<null | "newBase" | "newWorkspace" | { rename: BaseRow }>(null);

  const loadMe = useCallback(async (select?: string) => {
    const m = await get<Me>("/api/auth/me");
    if (!m.user) return navigate("/login", { replace: true });
    setMe(m);
    const pick = [select, readStored()].find(id => id && m.workspaces.some(w => w.id === id)) ?? m.workspaces[0]?.id ?? null;
    setWsId(pick);
    if (pick) store(pick);
  }, []);

  useEffect(() => {
    loadMe().catch(toastError);
    getConfig().then(setConfig).catch(toastError);
  }, [loadMe]);

  useEffect(() => {
    if (!wsId) return;
    const w = me?.workspaces.find(x => x.id === wsId);
    if (w) setLimitContext(w.id, w.role);
    setBases(null);
    let live = true;
    get<BaseRow[]>(`/api/workspaces/${wsId}/bases`)
      .then(b => live && setBases(b))
      .catch(e => {
        toastError(e);
        if (live) setBases([]);
      });
    return () => {
      live = false;
    };
  }, [wsId]);

  if (!me?.user) return <div className="center-page"><Spinner size={24} /></div>;
  const user = me.user;
  const ws = me.workspaces.find(w => w.id === wsId) ?? null;
  const canEdit = !!ws && ws.role !== "viewer";

  const selectWs = (id: string) => {
    setWsId(id);
    store(id);
  };

  const logout = async () => {
    try {
      await post("/api/auth/logout");
    } catch {
      // Ignore; the session cookie is cleared server side when possible.
    }
    navigate("/login");
  };

  const removeBase = async (b: BaseRow) => {
    if (!confirmDialog(`Delete "${b.name}"? All tables, records and attachments in it are deleted permanently.`)) return;
    try {
      await del(`/api/bases/${b.id}`);
      setBases(list => list?.filter(x => x.id !== b.id) ?? null);
    } catch (e) {
      toastError(e);
    }
  };

  const wsItems: (MenuItem | "sep")[] = me.workspaces.map(w => ({ label: w.name, icon: w.id === wsId ? "check" : "table", onClick: () => selectWs(w.id) }));
  wsItems.push("sep", { label: "New workspace", icon: "plus", onClick: () => setModal("newWorkspace") });

  return (
    <div className="app-page">
      <header className="topbar">
        <Link to="/" className="brand"><Logo size={24} /> <span className="brand-text">Rowflare</span></Link>
        {ws && (
          <>
            <span className="topbar-sep" />
            <button className="ws-switch" onClick={e => setWsMenu(e.currentTarget)} aria-haspopup="menu" aria-expanded={!!wsMenu} aria-label={`Workspace: ${ws.name}. Switch workspace`}>
              <span className="ws-switch-name">{ws.name}</span>
              <Icon name="chevron" size={14} />
            </button>
          </>
        )}
        <span className="grow" />
        <button className="avatar-btn" onClick={e => setUserMenu(e.currentTarget)} aria-haspopup="menu" aria-expanded={!!userMenu} aria-label="Account menu">
          <Avatar name={user.name} size={30} title={user.email || user.name} />
        </button>
      </header>
      {wsMenu && <Menu anchor={wsMenu} items={wsItems} onClose={() => setWsMenu(null)} />}
      {userMenu && (
        <Menu
          anchor={userMenu}
          onClose={() => setUserMenu(null)}
          items={[
            { label: "Settings", icon: "settings", onClick: () => navigate("/settings/account") },
            "sep",
            { label: "Log out", icon: "logout", onClick: logout },
          ]}
        />
      )}

      <main className="home-main">
        {config?.accountMail && user.emailVerified === false && <VerifyBanner email={user.email} />}
        {ws && bases && <UsageNotice key={ws.id + bases.length} ws={ws} billing={!!config?.billing} />}

        {!ws ? (
          <Empty title="No workspace yet">
            <Button variant="primary" icon="plus" onClick={() => setModal("newWorkspace")}>Create a workspace</Button>
          </Empty>
        ) : (
          <>
            <div className="home-head">
              <h1>{ws.name}</h1>
              <span className="role-chip">{ws.role}</span>
              <span className="grow" />
              {canEdit && (
                <Button variant="primary" icon="plus" onClick={() => setModal("newBase")}>New base</Button>
              )}
            </div>
            {bases === null ? (
              <div className="home-loading"><Spinner size={22} /></div>
            ) : bases.length === 0 ? (
              <div className="card">
                <Empty title="No bases yet">
                  <p className="muted">A base holds related tables, like a project tracker or a CRM.</p>
                  {canEdit && <Button variant="primary" icon="plus" onClick={() => setModal("newBase")}>Create your first base</Button>}
                </Empty>
              </div>
            ) : (
              <div className="base-grid">
                {bases.map(b => (
                  <BaseCard key={b.id} base={b} canEdit={canEdit} isOwner={ws.role === "owner"} onRename={() => setModal({ rename: b })} onDelete={() => removeBase(b)} />
                ))}
                {canEdit && (
                  <button className="new-base-card" onClick={() => setModal("newBase")}>
                    <Icon name="plus" /> New base
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {modal === "newBase" && ws && config && <NewBaseModal ws={ws} config={config} onClose={() => setModal(null)} />}
      {modal === "newWorkspace" && (
        <NameModal
          title="New workspace"
          label="Workspace name"
          initial=""
          submitText="Create workspace"
          onClose={() => setModal(null)}
          onSubmit={async name => {
            const r = await post<{ id: string }>("/api/workspaces", { name });
            await loadMe(r.id);
          }}
        />
      )}
      {modal && typeof modal === "object" && (
        <NameModal
          title="Rename base"
          label="Base name"
          initial={modal.rename.name}
          submitText="Save"
          onClose={() => setModal(null)}
          onSubmit={async name => {
            await patch(`/api/bases/${modal.rename.id}`, { name });
            setBases(list => list?.map(x => (x.id === modal.rename.id ? { ...x, name } : x)) ?? null);
          }}
        />
      )}
    </div>
  );
}

function BaseCard({ base, canEdit, isOwner, onRename, onDelete }: { base: BaseRow; canEdit: boolean; isOwner: boolean; onRename: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const items: MenuItem[] = [];
  if (canEdit) items.push({ label: "Rename", icon: "edit", onClick: onRename });
  if (isOwner) items.push({ label: "Delete base", icon: "trash", danger: true, onClick: onDelete });
  return (
    <div className="base-card">
      <button className="base-card-main" onClick={() => navigate(`/base/${base.id}`)}>
        <span className="base-tile" style={{ background: base.color || "var(--accent-bg)" }} aria-hidden="true">{initials(base.name)}</span>
        <span className="grow">
          <span className="base-name">{base.name}</span>
          <span className="muted small">Created {new Date(base.created_at).toLocaleDateString()}</span>
        </span>
      </button>
      {items.length > 0 && (
        <button className="icon-btn" onClick={e => setMenu(e.currentTarget)} aria-label={`Options for ${base.name}`} aria-haspopup="menu" aria-expanded={!!menu}>
          <Icon name="dots" />
        </button>
      )}
      {menu && <Menu anchor={menu} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function NameModal({ title, label, initial, submitText, onClose, onSubmit }: { title: string; label: string; initial: string; submitText: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <form className="stack" onSubmit={submit}>
        <div>
          <label className="field-label" htmlFor="name-modal-input">{label}</label>
          <input id="name-modal-input" className="input" value={name} onChange={e => setName(e.target.value)} autoFocus required onFocus={e => e.target.select()} />
        </div>
        {error && <div className="page-err" role="alert">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button onClick={onClose}>Cancel</Button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy && <Spinner size={14} />} {submitText}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewBaseModal({ ws, config, onClose }: { ws: WorkspaceInfo; config: AppConfig; onClose: () => void }) {
  const [choice, setChoice] = useState("blank");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const template = config.templates.find(t => t.slug === choice);
  const placeholder = choice === "airtable" ? "Airtable import" : template?.name ?? "Untitled base";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = choice === "airtable" ? { name: name.trim() || "Airtable import" } : { name: name.trim() || placeholder, template: template?.slug };
      const r = await post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, body);
      navigate(`/base/${r.id}${choice === "airtable" ? "?import=airtable" : ""}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const options = [
    { id: "blank", icon: "plus", title: "Start from scratch", desc: "An empty base with one table." },
    ...config.templates.map(t => ({ id: t.slug, icon: "grid", title: t.name, desc: t.description })),
    { id: "airtable", icon: "import", title: "Import from Airtable", desc: "Copy tables, fields and records with a personal access token." },
  ];
  return (
    <Modal title="Create a base" onClose={onClose} width={520}>
      <form className="stack" onSubmit={submit}>
        <div className="choice-list" role="group" aria-label="How to start">
          {options.map(o => (
            <button key={o.id} type="button" className="choice" aria-pressed={choice === o.id} onClick={() => setChoice(o.id)}>
              <span className="choice-icon"><Icon name={o.icon} /></span>
              <span className="grow">
                <span className="choice-title">{o.title}</span>
                <span className="choice-desc">{o.desc}</span>
              </span>
            </button>
          ))}
        </div>
        <div>
          <label className="field-label" htmlFor="new-base-name">Base name</label>
          <input id="new-base-name" className="input" value={name} placeholder={placeholder} onChange={e => setName(e.target.value)} />
        </div>
        {error !== null && <ErrorWithUpgrade error={error} owner={ws.role === "owner"} />}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button onClick={onClose}>Cancel</Button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size={14} />} {choice === "airtable" ? "Continue to import" : "Create base"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const VERIFY_HIDDEN = "rf-verify-hidden";

/** Until the email is confirmed: a reminder with "Send again"; hiding it lasts for this browser session. */
function VerifyBanner({ email }: { email: string }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(VERIFY_HIDDEN) === "1";
    } catch {
      return false;
    }
  });
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  if (hidden) return null;
  const resend = async () => {
    setState("busy");
    try {
      await post("/api/auth/verify/resend");
      setState("sent");
    } catch (e) {
      toastError(e);
      setState("idle");
    }
  };
  const hide = () => {
    try {
      sessionStorage.setItem(VERIFY_HIDDEN, "1");
    } catch {
      // Hidden for this page view only.
    }
    setHidden(true);
  };
  return (
    <div className="banner" role="status">
      <span className="grow">Check your inbox to confirm your email, <strong>{email}</strong>.</span>
      {state === "sent" ? <span className="muted">Sent. The new link works for 24 hours.</span> : <Button small onClick={resend} disabled={state === "busy"}>Send again</Button>}
      <Button small variant="ghost" icon="x" aria-label="Hide" onClick={hide} />
    </div>
  );
}

/** An error line; for a plan limit, owners get an Upgrade button and other members are told to ask an owner. */
function ErrorWithUpgrade({ error, owner }: { error: unknown; owner: boolean }) {
  const text = error instanceof Error ? error.message : String(error);
  const limit = limitOf(error);
  const upgrade = limit && owner ? upgradeTarget(limit) : null;
  return (
    <div className="page-err row" role="alert">
      <span className="grow">{text}{limit && !owner ? ". Ask a workspace owner to upgrade." : ""}</span>
      {upgrade && <Button small variant="primary" onClick={upgrade}>Upgrade</Button>}
    </div>
  );
}

interface UsageItem {
  key: string;
  label: string;
  used: number;
  limit: number | null;
}

/** At 80% of any plan limit: a notice, with a link to the Billing tab for owners. */
function UsageNotice({ ws, billing }: { ws: WorkspaceInfo; billing: boolean }) {
  const [near, setNear] = useState<UsageItem[]>([]);
  useEffect(() => {
    let live = true;
    get<{ usage: UsageItem[] }>(`/api/workspaces/${ws.id}/usage`)
      .then(r => live && setNear(r.usage.filter(u => u.limit && u.used >= u.limit * 0.8)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ws.id]);
  if (!near.length) return null;
  const full = near.some(u => u.used >= u.limit!);
  return (
    <div className={"banner" + (full ? " warn" : "")} role="status">
      <span className="grow">
        {near.map(u => `${u.label}: ${fmtUsage(u.key, u.used)} of ${fmtUsage(u.key, u.limit!)}`).join(" · ")}. {full ? "A plan limit is reached; adding more is blocked, existing data stays." : "This workspace is close to its plan's limits."}
        {ws.role !== "owner" && " Ask a workspace owner to upgrade."}
      </span>
      {ws.role === "owner" && billing && <Link to={`/settings/billing?ws=${ws.id}`} className="btn btn-sm btn-primary">See plans</Link>}
    </div>
  );
}
