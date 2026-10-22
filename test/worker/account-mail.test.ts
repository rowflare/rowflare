import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { setMailerForTests, type AccountMail } from "../../src/worker/account-mail";

let sent: AccountMail[] = [];

async function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { "x-rf": "1", "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) };
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://app.test" + path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

const signup = async (email: string) => (await call("/api/auth/signup", { method: "POST", body: { email, password: "correct horse" } })).cookie!;
const login = async (email: string, password = "correct horse") => call("/api/auth/login", { method: "POST", body: { email, password } });
const tokenIn = (m: AccountMail, page: string) => new RegExp(`https://app\\.test/${page}\\?token=([A-Za-z0-9_-]+)`).exec(m.body)![1];

describe("account emails", () => {
  beforeEach(() => {
    sent = [];
    setMailerForTests(async m => void sent.push(m));
  });
  afterEach(() => setMailerForTests(undefined));

  it("sign-up sends a verification link that confirms the email once", async () => {
    const cookie = await signup("verify-1@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("verify-1@example.com");
    expect((await call("/api/auth/me", { cookie })).json.user.emailVerified).toBe(false);
    const token = tokenIn(sent[0], "verify");
    expect((await call("/api/auth/verify", { method: "POST", body: { token } })).status).toBe(200);
    expect((await call("/api/auth/me", { cookie })).json.user.emailVerified).toBe(true);
    const again = await call("/api/auth/verify", { method: "POST", body: { token } });
    expect(again.status).toBe(400);
    expect(again.json.error).toBe("This link is invalid or has expired");
  });

  it("an expired link is refused", async () => {
    await signup("verify-2@example.com");
    const token = tokenIn(sent[0], "verify");
    await env.DB.prepare("UPDATE email_tokens SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await call("/api/auth/verify", { method: "POST", body: { token } })).status).toBe(400);
  });

  it("send again mails a new link to the signed-in user", async () => {
    const cookie = await signup("verify-3@example.com");
    expect((await call("/api/auth/verify/resend", { method: "POST", body: {}, cookie })).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(tokenIn(sent[1], "verify")).not.toBe(tokenIn(sent[0], "verify"));
  });

  it("forgot answers the same for unknown emails and sends nothing", async () => {
    const r = await call("/api/auth/forgot", { method: "POST", body: { email: "nobody@example.com" } });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(sent).toHaveLength(0);
  });

  it("a reset link sets a new password, signs out other sessions and signs in the person", async () => {
    const first = await signup("reset-1@example.com");
    const second = (await login("reset-1@example.com")).cookie!;
    sent = [];
    expect((await call("/api/auth/forgot", { method: "POST", body: { email: " Reset-1@Example.com " } })).json).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const token = tokenIn(sent[0], "reset");
    const short = await call("/api/auth/reset", { method: "POST", body: { token, password: "short" } });
    expect(short.json.error).toBe("Password must be at least 8 characters");
    const r = await call("/api/auth/reset", { method: "POST", body: { token, password: "a new password" }, cookie: second });
    expect(r.status).toBe(200);
    expect((await call("/api/auth/me", { cookie: first })).json.user).toBeNull();
    expect((await call("/api/auth/me", { cookie: second })).json.user.email).toBe("reset-1@example.com");
    expect((await login("reset-1@example.com")).status).toBe(401);
    expect((await login("reset-1@example.com", "a new password")).status).toBe(200);
    expect((await call("/api/auth/reset", { method: "POST", body: { token, password: "another one" } })).status).toBe(400);
  });

  it("a reset from a signed-out browser signs in with a new session", async () => {
    await signup("reset-2@example.com");
    sent = [];
    await call("/api/auth/forgot", { method: "POST", body: { email: "reset-2@example.com" } });
    const r = await call("/api/auth/reset", { method: "POST", body: { token: tokenIn(sent[0], "reset"), password: "a new password" } });
    expect(r.status).toBe(200);
    expect((await call("/api/auth/me", { cookie: r.cookie })).json.user.email).toBe("reset-2@example.com");
    expect((await call("/api/auth/me", { cookie: r.cookie })).json.user.emailVerified).toBe(true);
  });

  it("an address gets at most 5 emails an hour", async () => {
    await signup("reset-3@example.com");
    for (let k = 0; k < 6; k++) expect((await call("/api/auth/forgot", { method: "POST", body: { email: "reset-3@example.com" } })).json).toEqual({ ok: true });
    expect(sent).toHaveLength(5);
  });

  it("config reports account mail", async () => {
    expect((await call("/api/config")).json.accountMail).toBe(true);
  });
});

describe("account emails without mail", () => {
  beforeEach(() => setMailerForTests(null));
  afterEach(() => setMailerForTests(undefined));

  it("forgot says email is not set up, and sign-up still works", async () => {
    expect((await call("/api/config")).json.accountMail).toBe(false);
    const r = await call("/api/auth/forgot", { method: "POST", body: { email: "nomail@example.com" } });
    expect(r).toMatchObject({ status: 400, json: { error: "Email is not set up on this instance" } });
    const cookie = await signup("nomail@example.com");
    expect((await call("/api/auth/me", { cookie })).json.user.email).toBe("nomail@example.com");
  });
});
