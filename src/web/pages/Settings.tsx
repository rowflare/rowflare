import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, del, get, getConfig, patch, post, type Me, type WorkspaceInfo } from "../api";
import { Link, navigate, useLocation } from "../router";
import { Avatar, Button, confirmDialog, copyText, Icon, Logo, Spinner } from "../ui";
import { toast, toastError } from "../toast";
import type { Member, Role } from "../../shared/types";
import { ErrorLine, Submit, useAction } from "./formParts";
import { AiSettings } from "../ai/AiSettings";
import { Billing } from "./Billing";
import "./pages.css";

type Tab = "account" | "tokens" | "members" | "email" | "ai" | "billing";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "account", label: "Account", icon: "user" },
  { id: "tokens", label: "API tokens", icon: "link" },
  { id: "members", label: "Members", icon: "user2" },
  { id: "email", label: "Email sending", icon: "email" },
  { id: "ai", label: "AI services", icon: "sparkle" },
  { id: "billing", label: "Billing", icon: "chart" },
];

/** Tabs about one workspace: they take ?ws= and show a workspace picker. */
const WS_TABS: Tab[] = ["members", "email", "ai", "billing"];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtDate = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "-");

export default function Settings({ tab }: { tab: string }) {
  const loc = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [billing, setBilling] = useState(false);
  const [passwords, setPasswords] = useState(true);
  const tabs = TABS.filter(t => t.id !== "billing" || billing);
  const active: Tab = tabs.some(t => t.id === tab) ? (tab as Tab) : "account";

  const reload = () =>
    get<Me>("/api/auth/me").then(m => {
      if (!m.user) navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
      else setMe(m);
    });

  useEffect(() => {
    reload().catch(toastError);
    getConfig()
      .then(c => {
        setBilling(c.billing);
        setPasswords(c.emailAuth === "password");
      })
      .catch(toastError);
  }, []);

  if (!me?.user) return <div className="center-page"><Spinner size={24} /></div>;
  const wsParam = new URLSearchParams(loc.split("?")[1] ?? "").get("ws");
  const ws = me.workspaces.find(w => w.id === wsParam) ?? me.workspaces[0] ?? null;
  const hrefFor = (t: Tab) => WS_TABS.includes(t) && ws ? `/settings/${t}?ws=${ws.id}` : `/settings/${t}`;

  return (
    <div className="app-page">
      <header className="topbar">
        <Link to="/" className="brand"><Logo size={24} /> <span className="brand-text">Rowflare</span></Link>
        <span className="topbar-sep" />
        <Link to="/" className="btn btn-ghost btn-sm"><Icon name="back" size={14} /> Back to bases</Link>
      </header>
      <div className="settings-wrap">
        <nav className="settings-nav" aria-label="Settings">
          {tabs.map(t => (
            <Link key={t.id} to={hrefFor(t.id)} aria-current={active === t.id ? "page" : undefined}>
              <Icon name={t.icon} size={15} /> {t.label}
            </Link>
          ))}
        </nav>
        <main className="settings-main">
          <h1>{TABS.find(t => t.id === active)!.label}</h1>
          {WS_TABS.includes(active) && me.workspaces.length > 1 && ws && (
            <div className="narrow">
              <label className="field-label" htmlFor="ws-select">Workspace</label>
              <select id="ws-select" className="input" value={ws.id} onChange={e => navigate(`/settings/${active}?ws=${e.target.value}`)}>
                {me.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          )}
          {active === "account" && <Account me={me} onSaved={reload} passwords={passwords} />}
          {active === "tokens" && <Tokens />}
          {WS_TABS.includes(active) && !ws && <div className="page-note">You are not a member of any workspace.</div>}
          {active === "members" && ws && <Members key={ws.id} ws={ws} meId={me.user.id} onChanged={reload} />}
          {active === "email" && ws && <MailSettings key={ws.id} ws={ws} />}
          {active === "ai" && ws && <AiSettings key={ws.id} ws={ws} />}
          {active === "billing" && ws && <Billing key={ws.id} ws={ws} />}
        </main>
      </div>
    </div>
  );
}

function Account({ me, onSaved, passwords }: { me: Me; onSaved: () => Promise<void>; passwords: boolean }) {
  const user = me.user!;
  const [name, setName] = useState(user.name);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const nameAction = useAction();
  const pwAction = useAction();
  const saveName = (e: FormEvent) => {
    e.preventDefault();
    nameAction.run(async () => {
      await patch("/api/auth/me", { name });
      await onSaved();
      toast("Name updated");
    });
  };
  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    pwAction.run(async () => {
      if (password.length < 8) throw new Error("Password must be at least 8 characters");
      await patch("/api/auth/me", { currentPassword: current, password });
      setCurrent("");
      setPassword("");
      toast("Password changed");
    });
  };
  return (
    <>
      <section className="card section">
        <h2>Profile</h2>
        {user.email && <p className="section-desc">Signed in as {user.email}</p>}
        <form className="form-row" onSubmit={saveName}>
          <div className="grow narrow">
            <label className="field-label" htmlFor="acc-name">Name</label>
            <input id="acc-name" className="input" value={name} onChange={e => setName(e.target.value)} required autoComplete="name" />
          </div>
          <Submit busy={nameAction.busy} disabled={!name.trim() || name.trim() === user.name}>Save</Submit>
        </form>
        <ErrorLine error={nameAction.error} />
      </section>
      {passwords && (
        <section className="card section">
          <h2>Password</h2>
          <form className="stack narrow" onSubmit={savePassword}>
            <div>
              <label className="field-label" htmlFor="acc-current">Current password</label>
              <input id="acc-current" className="input" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required />
            </div>
            <div>
              <label className="field-label" htmlFor="acc-new">New password</label>
              <input id="acc-new" className="input" type="password" autoComplete="new-password" minLength={8} placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <ErrorLine error={pwAction.error} />
            <div><Submit busy={pwAction.busy}>Change password</Submit></div>
          </form>
        </section>
      )}
    </>
  );
}

interface TokenRow {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

function CopyBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="copy-box">
      <code aria-label={label}>{value}</code>
      <Button
        icon="copy"
        onClick={() => {
          copyText(value);
          toast("Copied to clipboard");
        }}
      >
        Copy
      </Button>
    </div>
  );
}

function Tokens() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const action = useAction();
  const load = () => get<TokenRow[]>("/api/tokens").then(setTokens);
  useEffect(() => {
    load().catch(e => {
      toastError(e);
      setTokens([]);
    });
  }, []);
  const create = (e: FormEvent) => {
    e.preventDefault();
    action.run(async () => {
      const r = await post<{ id: string; token: string }>("/api/tokens", { name: name.trim() || "API token" });
      setCreated(r.token);
      setName("");
      await load();
    });
  };
  const remove = async (t: TokenRow) => {
    if (!confirmDialog(`Delete the token "${t.name}"? Apps using it stop working immediately.`)) return;
    try {
      await del(`/api/tokens/${t.id}`);
      setTokens(list => list?.filter(x => x.id !== t.id) ?? null);
    } catch (e) {
      toastError(e);
    }
  };
  const origin = location.origin;
  return (
    <>
      <section className="card section">
        <h2>Personal access tokens</h2>
        <p className="section-desc">Tokens act as you in the REST API, with access to every base you can open.</p>
        <form className="form-row" onSubmit={create}>
          <div className="grow narrow">
            <label className="field-label" htmlFor="tok-name">Token name</label>
            <input id="tok-name" className="input" placeholder="For example: Zapier sync" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <Submit busy={action.busy}>Create token</Submit>
        </form>
        <ErrorLine error={action.error} />
        {created && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="banner warn">
              <Icon name="eye" />
              <span className="grow">Copy this token now. It is shown only once and cannot be recovered.</span>
            </div>
            <CopyBox value={created} label="New API token" />
          </div>
        )}
        {tokens === null ? (
          <Spinner />
        ) : tokens.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No tokens yet.</p>
        ) : (
          <div className="list">
            {tokens.map(t => (
              <div key={t.id} className="list-row">
                <div className="grow">
                  <div className="list-title">{t.name}</div>
                  <div className="list-sub">Created {fmtDate(t.created_at)}, {t.last_used_at ? `last used ${fmtDate(t.last_used_at)}` : "never used"}</div>
                </div>
                <Button small variant="danger" icon="trash" onClick={() => remove(t)}>Delete</Button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="card section">
        <h2>Using the API</h2>
        <p className="section-desc">Send the token as a Bearer header. List your bases, then read records of a table by its name.</p>
        <pre className="code-block">{`curl -H "Authorization: Bearer $TOKEN" ${origin}/api/v1/bases\n\ncurl -H "Authorization: Bearer $TOKEN" "${origin}/api/v1/<baseId>/<table name>"`}</pre>
      </section>
    </>
  );
}

function Members({ ws, meId, onChanged }: { ws: WorkspaceInfo; meId: string; onChanged: () => Promise<void> }) {
  const isOwner = ws.role === "owner";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [wsName, setWsName] = useState(ws.name);
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const renameAction = useAction();
  const inviteAction = useAction();
  const base = `/api/workspaces/${ws.id}`;
  const load = () => get<Member[]>(`${base}/members`).then(setMembers);
  useEffect(() => {
    load().catch(e => {
      toastError(e);
      setMembers([]);
    });
  }, [ws.id]);

  const rename = (e: FormEvent) => {
    e.preventDefault();
    renameAction.run(async () => {
      await patch(base, { name: wsName });
      await onChanged();
      toast("Workspace renamed");
    });
  };
  const invite = (e: FormEvent) => {
    e.preventDefault();
    inviteAction.run(async () => {
      const r = await post<{ id: string; url: string }>(`${base}/invites`, { role: inviteRole });
      setInviteUrl(r.url);
    });
  };
  const setRole = async (m: Member, role: Role) => {
    try {
      await patch(`${base}/members/${m.id}`, { role });
      setMembers(list => list?.map(x => (x.id === m.id ? { ...x, role } : x)) ?? null);
      if (m.id === meId) await onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async (m: Member) => {
    const self = m.id === meId;
    if (!confirmDialog(self ? `Leave "${ws.name}"? You will lose access to its bases.` : `Remove ${m.name} from "${ws.name}"?`)) return;
    try {
      await del(`${base}/members/${m.id}`);
      if (self) return navigate("/");
      setMembers(list => list?.filter(x => x.id !== m.id) ?? null);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      {isOwner && (
        <section className="card section">
          <h2>Workspace</h2>
          <form className="form-row" onSubmit={rename}>
            <div className="grow narrow">
              <label className="field-label" htmlFor="ws-name">Workspace name</label>
              <input id="ws-name" className="input" value={wsName} onChange={e => setWsName(e.target.value)} required />
            </div>
            <Submit busy={renameAction.busy} disabled={!wsName.trim() || wsName.trim() === ws.name}>Rename</Submit>
          </form>
          <ErrorLine error={renameAction.error} />
        </section>
      )}
      {isOwner && (
        <section className="card section">
          <h2>Invite people</h2>
          <p className="section-desc">Members are unlimited and free. Anyone with the link can join within 7 days.</p>
          <form className="form-row" onSubmit={invite}>
            <div>
              <label className="field-label" htmlFor="inv-role">Role</label>
              <select id="inv-role" className="input" value={inviteRole} onChange={e => setInviteRole(e.target.value as Role)}>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
                <option value="owner">Owner</option>
              </select>
            </div>
            <Submit busy={inviteAction.busy}>Create invite link</Submit>
          </form>
          <ErrorLine error={inviteAction.error} />
          {inviteUrl && <CopyBox value={inviteUrl} label="Invite link" />}
        </section>
      )}
      <section className="card section">
        <h2>Members</h2>
        {!isOwner && <p className="section-desc">Members are unlimited and free. Only owners can invite people or change roles.</p>}
        {members === null ? (
          <Spinner />
        ) : (
          <div className="list">
            {members.map(m => (
              <div key={m.id} className="list-row">
                <Avatar name={m.name} size={32} />
                <div className="grow">
                  <div className="list-title">{m.name}{m.id === meId && <span className="muted"> (you)</span>}</div>
                  <div className="list-sub">{m.email}</div>
                </div>
                {isOwner ? (
                  <select className="input" value={m.role} onChange={e => setRole(m, e.target.value as Role)} aria-label={`Role of ${m.name}`}>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  <span className="role-chip">{m.role}</span>
                )}
                {(isOwner || m.id === meId) && (
                  <Button small variant="ghost" onClick={() => remove(m)} aria-label={m.id === meId ? "Leave workspace" : `Remove ${m.name}`}>
                    {m.id === meId ? "Leave" : "Remove"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

interface MailInfo {
  system: { available: boolean; from: string | null };
  secretKey: boolean;
  providers: { provider: "resend" | "smtp"; fromAddress: string; fromName: string | null; settings: { host?: string; port?: number; security?: string; username?: string }; last4: string; updatedAt: number }[];
}

function MailSettings({ ws }: { ws: WorkspaceInfo }) {
  const [info, setInfo] = useState<MailInfo | null>(null);
  const [error, setError] = useState("");
  const base = `/api/workspaces/${ws.id}/mail`;
  const load = () => get<MailInfo>(base).then(setInfo).catch(e => setError(message(e)));
  useEffect(() => {
    if (ws.role === "owner") load();
  }, [ws.id]);
  if (ws.role !== "owner") return <div className="page-note">Only workspace owners can set up email sending.</div>;
  if (error) return <ErrorLine error={error} />;
  if (!info) return <Spinner />;
  return (
    <>
      <section className="card section">
        <h2>System email</h2>
        <p className="section-desc" style={{ margin: 0 }}>
          {info.system.available ? `This server sends system email from ${info.system.from} through Cloudflare Email Service. Automations can use it without any setup.` : "This server has no system email. Set up Resend or SMTP below, or ask the person who runs the server to add Cloudflare Email Service."}
        </p>
      </section>
      {!info.secretKey && <div className="page-err">The server has no SECRET_KEY setting, so mail credentials cannot be stored. Set SECRET_KEY to a long random value and restart.</div>}
      <ProviderForm ws={ws} provider="resend" saved={info.providers.find(p => p.provider === "resend")} disabled={!info.secretKey} onChanged={load} />
      <ProviderForm ws={ws} provider="smtp" saved={info.providers.find(p => p.provider === "smtp")} disabled={!info.secretKey} onChanged={load} />
    </>
  );
}

function ProviderForm({ ws, provider, saved, disabled, onChanged }: { ws: WorkspaceInfo; provider: "resend" | "smtp"; saved?: MailInfo["providers"][number]; disabled: boolean; onChanged: () => Promise<void> }) {
  const [from, setFrom] = useState(saved?.fromAddress ?? "");
  const [fromName, setFromName] = useState(saved?.fromName ?? "");
  const [secret, setSecret] = useState("");
  const [host, setHost] = useState(saved?.settings.host ?? "");
  const [port, setPort] = useState(String(saved?.settings.port ?? 587));
  const [security, setSecurity] = useState(saved?.settings.security ?? "starttls");
  const [username, setUsername] = useState(saved?.settings.username ?? "");
  const [testTo, setTestTo] = useState("");
  const action = useAction();
  const testAction = useAction();
  const base = `/api/workspaces/${ws.id}/mail`;
  const save = (e: FormEvent) => {
    e.preventDefault();
    action.run(async () => {
      await api("PUT", base, { provider, fromAddress: from, fromName, secret: secret || undefined, settings: provider === "smtp" ? { host, port: Number(port), security, username } : undefined });
      setSecret("");
      await onChanged();
      toast(provider === "resend" ? "Resend saved" : "SMTP saved");
    });
  };
  const remove = () =>
    action.run(async () => {
      if (!confirmDialog(`Remove the ${provider === "resend" ? "Resend" : "SMTP"} settings? Email steps that use them start failing.`)) return;
      await api("PUT", base, { provider, remove: true });
      await onChanged();
    });
  const test = () =>
    testAction.run(async () => {
      const r = await post<{ to: string }>(`${base}/test`, { provider, to: testTo || undefined });
      toast(`Test email sent to ${r.to}`);
    });
  return (
    <section className="card section">
      <h2>{provider === "resend" ? "Resend" : "SMTP"}</h2>
      <p className="section-desc">
        {provider === "resend" ? "Send with your Resend account: an API key and a sender address on a domain you verified in Resend." : "Send through any mail server: your company mail, Gmail with an app password, or a mail service such as Amazon SES."}
        {saved && ` Saved ${fmtDate(saved.updatedAt)}.`}
      </p>
      <form className="stack narrow" onSubmit={save}>
        {provider === "smtp" && (
          <>
            <div className="form-row">
              <div className="grow"><label className="field-label">Host</label><input className="input" value={host} onChange={e => setHost(e.target.value)} placeholder="smtp.example.com" required /></div>
              <div style={{ width: 90 }}><label className="field-label">Port</label><input className="input" value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" required /></div>
            </div>
            <label className="field-label">Security</label>
            <select className="input" value={security} onChange={e => setSecurity(e.target.value)}>
              <option value="starttls">STARTTLS (usually port 587)</option>
              <option value="tls">TLS (usually port 465)</option>
              <option value="none">None (only for servers on your own network)</option>
            </select>
            <label className="field-label">Username</label>
            <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" />
          </>
        )}
        <label className="field-label">{provider === "resend" ? "API key" : "Password"}</label>
        <input className="input" type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={saved ? `Saved, ends in ${saved.last4}` : ""} autoComplete="new-password" />
        <label className="field-label">From address</label>
        <input className="input" type="email" value={from} onChange={e => setFrom(e.target.value)} placeholder="automations@example.com" required />
        <label className="field-label">From name</label>
        <input className="input" value={fromName} onChange={e => setFromName(e.target.value)} placeholder="Rowflare" />
        <ErrorLine error={action.error} />
        <div className="row">
          <Submit busy={action.busy} disabled={disabled}>Save</Submit>
          {saved && <button type="button" className="btn btn-danger" onClick={remove}>Remove</button>}
        </div>
      </form>
      {saved && (
        <div className="form-row" style={{ marginTop: 12 }}>
          <div className="grow narrow"><input className="input" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="Send a test email to (default: you)" aria-label="Test email address" /></div>
          <button type="button" className="btn" onClick={test} disabled={testAction.busy}>{testAction.busy && <Spinner size={14} />} Send test email</button>
        </div>
      )}
      <ErrorLine error={testAction.error} />
    </section>
  );
}
