import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { get, getConfig, post, type AppConfig, type Me } from "../api";
import { Link, navigate } from "../router";
import { Button, Icon, Logo, Spinner } from "../ui";
import { toastError } from "../toast";
import type { Role } from "../../shared/types";
import { safeNextPath, signInErrorText } from "../../shared/sign-in";
import "./pages.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useConfig(): AppConfig | null {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    getConfig().then(setConfig).catch(toastError);
  }, []);
  return config;
}

function nextPath(): string {
  return safeNextPath(new URLSearchParams(location.search).get("next"));
}

const errorParam = () => signInErrorText(new URLSearchParams(location.search).get("error"));

/** A hosting's sign-in url with the page's invite and next path, so they survive the trip to the provider. */
function optionUrl(url: string, invite?: string, next?: string): string {
  const params = new URLSearchParams();
  if (invite) params.set("invite", invite);
  if (next && next !== "/") params.set("next", next);
  const q = params.toString();
  return q ? `${url}${url.includes("?") ? "&" : "?"}${q}` : url;
}

function SignInOptions({ config, invite, next }: { config: AppConfig; invite?: string; next?: string }) {
  if (!config.signInOptions.length) return null;
  return (
    <>
      <div className="auth-options">
        {config.signInOptions.map(o => (
          <a key={o.id} className="btn btn-block" href={optionUrl(o.url, invite, next)}>{o.label}</a>
        ))}
      </div>
      <div className="auth-or">or</div>
    </>
  );
}

/** Email, then the 6-digit code mailed to it; the account is created on the first correct code. */
function CodeForm({ invite, onDone }: { invite?: string; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (err) {
      setError(message(err));
    }
    setBusy(false);
  };
  const sendCode = () => run(async () => {
    await post("/api/auth/code", { email, invite });
    setStep("code");
    setCode("");
  });
  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    sendCode();
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await post("/api/auth/code/verify", { email, code, invite });
      onDone();
    });
  };
  if (step === "email") {
    return (
      <form className="auth-form" onSubmit={submitEmail}>
        <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} />
        {error && <div className="page-err" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy && <Spinner size={14} />} Continue with email
        </button>
      </form>
    );
  }
  return (
    <form className="auth-form" onSubmit={submitCode}>
      <div className="page-note" role="status">We sent a 6-digit code to <strong>{email}</strong>. It works for 10 minutes.</div>
      <Field label="Code" name="code" className="input auth-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} />
      {error && <div className="page-err" role="alert">{error}</div>}
      {note && <div className="small muted" role="status">{note}</div>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
        {busy && <Spinner size={14} />} Sign in
      </button>
      <div className="auth-links small">
        <button type="button" className="text-link" onClick={() => { setStep("email"); setError(""); setNote(""); }}>Use a different email</button>
        <button type="button" className="text-link" disabled={busy} onClick={() => sendCode().then(() => setNote("A new code is on its way."))}>Send a new code</button>
      </div>
    </form>
  );
}

/** The one sign-in page of an instance without passwords: sign-up and log-in are the same. */
function CodeSignIn({ config }: { config: AppConfig }) {
  const next = nextPath();
  const error = errorParam();
  return (
    <Shell
      title="Sign in to Rowflare"
      subtitle={config.signupOpen ? "New here? Signing in creates your account." : undefined}
    >
      {error && <div className="page-err auth-error" role="alert">{error}</div>}
      <SignInOptions config={config} next={next} />
      <CodeForm onDone={() => navigate(next)} />
    </Shell>
  );
}

function Shell({ title, subtitle, children, foot }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <main className="center-page auth-page">
      <div className="card auth-card">
        <div className="auth-head">
          <Link to="/" className="brand"><Logo size={24} /> Rowflare</Link>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
        {foot && <div className="auth-foot">{foot}</div>}
      </div>
    </main>
  );
}

function Field({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = "f-" + props.name;
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} className="input" {...props} />
    </div>
  );
}

function LoginForm({ invite, onDone, submitText = "Log in" }: { invite?: string; onDone: () => void; submitText?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/auth/login", { email, password, invite });
      onDone();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <form className="auth-form" onSubmit={submit}>
      <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
      {error && <div className="page-err" role="alert">{error}</div>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy && <Spinner size={14} />} {submitText}
      </button>
      <Link to="/forgot" className="text-link small auth-forgot">Forgot password?</Link>
    </form>
  );
}

function SignupForm({ invite, onDone, submitText = "Create account" }: { invite?: string; onDone: () => void; submitText?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError("Password must be at least 8 characters");
    setBusy(true);
    setError("");
    try {
      await post("/api/auth/signup", { name, email, password, invite });
      onDone();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <form className="auth-form" onSubmit={submit}>
      <Field label="Name" name="name" autoComplete="name" required autoFocus value={name} onChange={e => setName(e.target.value)} />
      <Field label="Email" name="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
      <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} />
      {error && <div className="page-err" role="alert">{error}</div>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy && <Spinner size={14} />} {submitText}
      </button>
    </form>
  );
}

export function Login() {
  const config = useConfig();
  const next = nextPath();
  const error = errorParam();
  if (!config) return <div className="center-page"><Spinner size={24} /></div>;
  if (config.emailAuth === "code") return <CodeSignIn config={config} />;
  return (
    <Shell
      title="Log in"
      subtitle="Welcome back. Enter your details to continue."
      foot={config.signupOpen && <span>No account yet? <Link to="/signup" className="text-link">Sign up</Link></span>}
    >
      {error && <div className="page-err auth-error" role="alert">{error}</div>}
      <SignInOptions config={config} next={next} />
      <LoginForm onDone={() => navigate(next)} />
    </Shell>
  );
}

export function Signup() {
  const config = useConfig();
  if (!config) return <div className="center-page"><Spinner size={24} /></div>;
  if (config.emailAuth === "code") return <CodeSignIn config={config} />;
  if (!config.signupOpen) {
    return (
      <Shell title="Invite only" foot={<span>Already have an account? <Link to="/login" className="text-link">Log in</Link></span>}>
        <div className="page-note">
          This Rowflare instance is invite-only. Ask a workspace owner for an invite link.
          <br />
          On a self-hosted instance the first account becomes the owner, and sign-up then stays closed unless the server sets ALLOW_SIGNUP=true.
        </div>
      </Shell>
    );
  }
  const subtitle =
    config.mode === "cloud"
      ? "Unlimited members in every workspace."
      : "On a new self-hosted instance, the first account becomes the owner.";
  return (
    <Shell
      title="Create your account"
      subtitle={subtitle}
      foot={<span>Already have an account? <Link to="/login" className="text-link">Log in</Link></span>}
    >
      <SignInOptions config={config} next={nextPath()} />
      <SignupForm onDone={() => navigate(nextPath())} />
    </Shell>
  );
}

const article = (role: Role) => (role === "owner" ? "an owner" : role === "editor" ? "an editor" : "a viewer");

export function Invite({ inviteId }: { inviteId: string }) {
  const config = useConfig();
  const [invite, setInvite] = useState<{ workspace: string; role: Role } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"signup" | "login">("signup");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([get(`/api/invites/${encodeURIComponent(inviteId)}`), get<Me>("/api/auth/me")])
      .then(([inv, m]) => {
        setInvite(inv);
        setMe(m);
      })
      .catch(e => setError(message(e)));
  }, [inviteId]);
  if (error) {
    return (
      <Shell title="Invite unavailable" foot={<Link to="/" className="text-link">Go to Rowflare</Link>}>
        <div className="page-err" role="alert">{error}</div>
      </Shell>
    );
  }
  if (!invite || !me || !config) return <div className="center-page"><Spinner size={24} /></div>;
  const done = () => navigate("/");
  const title = <>Join {invite.workspace} as {article(invite.role)}</>;
  const subtitle = "You have been invited to collaborate in this workspace on Rowflare.";
  if (me.user) {
    const accept = async () => {
      setBusy(true);
      try {
        await post(`/api/invites/${encodeURIComponent(inviteId)}/accept`);
        done();
      } catch (e) {
        toastError(e);
        setBusy(false);
      }
    };
    return (
      <Shell title={title} subtitle={subtitle} foot={<Link to="/" className="text-link">Not now</Link>}>
        <div className="stack">
          <div className="page-note">Signed in as <strong>{me.user.email}</strong></div>
          <Button variant="primary" className="btn-block" onClick={accept} disabled={busy}>
            {busy ? <Spinner size={14} /> : <Icon name="check" />} Accept invite
          </Button>
        </div>
      </Shell>
    );
  }
  if (config.emailAuth === "code") {
    return (
      <Shell title={title} subtitle={subtitle}>
        <SignInOptions config={config} invite={inviteId} />
        <CodeForm invite={inviteId} onDone={done} />
      </Shell>
    );
  }
  return (
    <Shell title={title} subtitle={subtitle}>
      <SignInOptions config={config} invite={inviteId} />
      <div className="auth-tabs" role="tablist">
        <button type="button" role="tab" className="auth-tab" aria-selected={tab === "signup"} onClick={() => setTab("signup")}>Sign up</button>
        <button type="button" role="tab" className="auth-tab" aria-selected={tab === "login"} onClick={() => setTab("login")}>Log in</button>
      </div>
      {tab === "signup" ? <SignupForm key="s" invite={inviteId} onDone={done} submitText="Create account and join" /> : <LoginForm key="l" invite={inviteId} onDone={done} submitText="Log in and join" />}
    </Shell>
  );
}

const tokenParam = () => new URLSearchParams(location.search).get("token") ?? "";

export function Forgot() {
  const config = useConfig();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const foot = <Link to="/login" className="text-link">Back to log in</Link>;
  useEffect(() => {
    if (config?.emailAuth === "code") navigate("/login", { replace: true });
  }, [config]);
  if (!config || config.emailAuth === "code") return <div className="center-page"><Spinner size={24} /></div>;
  if (!config.accountMail) {
    return (
      <Shell title="Reset your password" foot={foot}>
        <div className="page-note">This instance cannot send email, so passwords cannot be reset by link. Ask the person who runs it to set a new password for you, or to set up email (see the self-hosting guide).</div>
      </Shell>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/auth/forgot", { email });
      setSent(true);
    } catch (err) {
      setError(message(err));
    }
    setBusy(false);
  };
  return (
    <Shell title="Reset your password" subtitle={sent ? undefined : "Enter your account's email and we will send you a link to choose a new password."} foot={foot}>
      {sent ? (
        <div className="page-note" role="status">If <strong>{email}</strong> has an account, a link is on its way. It works for one hour.</div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} />
          {error && <div className="page-err" role="alert">{error}</div>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy && <Spinner size={14} />} Send link
          </button>
        </form>
      )}
    </Shell>
  );
}

export function Reset() {
  const config = useConfig();
  useEffect(() => {
    if (config?.emailAuth === "code") navigate("/login", { replace: true });
  }, [config]);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError("Password must be at least 8 characters");
    setBusy(true);
    setError("");
    try {
      await post("/api/auth/reset", { token: tokenParam(), password });
      navigate("/", { replace: true });
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <Shell title="Choose a new password" subtitle="Other devices signed in to your account are signed out." foot={<Link to="/forgot" className="text-link">Send a new link</Link>}>
      <form className="auth-form" onSubmit={submit}>
        <Field label="New password" name="password" type="password" autoComplete="new-password" required autoFocus minLength={8} placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} />
        {error && <div className="page-err" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy && <Spinner size={14} />} Set password
        </button>
      </form>
    </Shell>
  );
}

export function Verify() {
  const [state, setState] = useState<"busy" | "done" | string>("busy");
  useEffect(() => {
    post("/api/auth/verify", { token: tokenParam() })
      .then(() => setState("done"))
      .catch(e => setState(message(e)));
  }, []);
  if (state === "busy") return <div className="center-page"><Spinner size={24} /></div>;
  return (
    <Shell title={state === "done" ? "Email confirmed" : "Could not confirm"} foot={<Link to="/" className="text-link">Go to Rowflare</Link>}>
      {state === "done" ? <div className="page-note" role="status">Thanks, your email address is confirmed.</div> : <div className="page-err" role="alert">{state} Sign in and use "Send again" for a new link.</div>}
    </Shell>
  );
}
