import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { setMailerForTests, type AccountMail } from "../../src/worker/account-mail";
import { CODES_PER_HOUR_TOTAL } from "../../src/worker/email-code";

let sent: AccountMail[] = [];
const codeEnv = { ...env, AUTH_EMAIL: "code" };

async function call(path: string, init: { method?: string; body?: unknown; cookie?: string; env?: object; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-rf": "1", "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) };
  const ctx = createExecutionContext();
  const req = new Request("https://app.test" + path, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const res = await worker.fetch(req, (init.env ?? codeEnv) as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

const codeIn = (m: AccountMail) => /\b(\d{6})\b/.exec(m.body)![1];
const send = (email: string, extra: object = {}) => call("/api/auth/code", { body: { email, ...extra } });
const verify = (email: string, code: string, extra: object = {}, cookie?: string) => call("/api/auth/code/verify", { body: { email, code, ...extra }, cookie });
const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

describe("email code sign-in", () => {
  beforeEach(() => {
    sent = [];
    setMailerForTests(async m => void sent.push(m));
  });
  afterEach(() => setMailerForTests(undefined));

  it("a code signs up a new person with a workspace", async () => {
    expect(await send("code-1@example.com")).toMatchObject({ status: 200, json: { ok: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("code-1@example.com");
    const r = await verify("code-1@example.com", codeIn(sent[0]));
    expect(r.status).toBe(200);
    const me = (await call("/api/auth/me", { cookie: r.cookie })).json;
    expect(me.user).toMatchObject({ email: "code-1@example.com", emailVerified: true });
    expect(me.workspaces).toHaveLength(1);
  });

  it("the same email in another case reaches the same account and code", async () => {
    await send("Code-2@Example.com");
    const first = await verify(" code-2@example.com ", codeIn(sent[0]));
    expect(first.status).toBe(200);
    await send("CODE-2@example.com");
    const second = await verify("code-2@example.com", codeIn(sent[1]));
    const id = async (cookie?: string) => (await call("/api/auth/me", { cookie })).json.user.id;
    expect(await id(second.cookie)).toBe(await id(first.cookie));
  });

  it("a second code voids the first", async () => {
    await send("code-3@example.com");
    await send("code-3@example.com");
    const [a, b] = sent.map(codeIn);
    if (a !== b) expect((await verify("code-3@example.com", a)).status).toBe(400);
    expect((await verify("code-3@example.com", b)).status).toBe(200);
  });

  it("a code works once", async () => {
    await send("code-4@example.com");
    expect((await verify("code-4@example.com", codeIn(sent[0]))).status).toBe(200);
    const again = await verify("code-4@example.com", codeIn(sent[0]));
    expect(again).toMatchObject({ status: 400, json: { error: "This code is wrong or has expired" } });
  });

  it("an expired code is refused", async () => {
    await send("code-5@example.com");
    await env.DB.prepare("UPDATE email_codes SET expires_at = ? WHERE email = ?").bind(Date.now() - 1, "code-5@example.com").run();
    expect((await verify("code-5@example.com", codeIn(sent[0]))).status).toBe(400);
  });

  it("the fifth wrong try voids the code", async () => {
    await send("code-6@example.com");
    const code = codeIn(sent[0]);
    for (let k = 0; k < 5; k++) expect((await verify("code-6@example.com", wrong(code))).status).toBe(400);
    expect((await verify("code-6@example.com", code)).status).toBe(400);
  });

  it("four wrong tries still leave the code usable", async () => {
    await send("code-7@example.com");
    const code = codeIn(sent[0]);
    for (let k = 0; k < 4; k++) await verify("code-7@example.com", wrong(code));
    expect((await verify("code-7@example.com", code)).status).toBe(200);
  });

  it("the sixth request in an hour sends nothing but answers ok", async () => {
    for (let k = 0; k < 6; k++) expect((await send("code-8@example.com")).json).toEqual({ ok: true });
    expect(sent).toHaveLength(5);
  });

  it("an unknown email gets the same answer as a known one", async () => {
    await send("code-9@example.com");
    await verify("code-9@example.com", codeIn(sent[0]));
    const known = await send("code-9@example.com");
    const unknown = await send("nobody-yet@example.com");
    expect(unknown).toEqual(known);
  });

  it("a malformed email is refused", async () => {
    expect(await send("not an email")).toMatchObject({ status: 400, json: { error: "Enter a valid email" } });
  });

  it("an invite is carried", async () => {
    await send("code-owner@example.com");
    const owner = (await verify("code-owner@example.com", codeIn(sent[0]))).cookie;
    const ws = (await call("/api/auth/me", { cookie: owner })).json.workspaces[0].id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, { body: { role: "editor" }, cookie: owner })).json.id;
    await send("code-invited@example.com", { invite });
    const r = await verify("code-invited@example.com", codeIn(sent[1]), { invite });
    const me = (await call("/api/auth/me", { cookie: r.cookie })).json;
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual([ws]);
  });

  it("password routes are off in code mode", async () => {
    const off = [
      ["/api/auth/signup", { email: "pw@example.com", password: "correct horse" }],
      ["/api/auth/login", { email: "pw@example.com", password: "correct horse" }],
      ["/api/auth/forgot", { email: "pw@example.com" }],
      ["/api/auth/reset", { token: "x", password: "correct horse" }],
      ["/api/auth/verify/resend", {}],
    ] as const;
    for (const [path, body] of off) expect((await call(path, { body })).status).toBe(404);
    await send("code-11@example.com");
    const cookie = (await verify("code-11@example.com", codeIn(sent[0]))).cookie;
    expect((await call("/api/auth/me", { method: "PATCH", body: { password: "correct horse", currentPassword: "" }, cookie })).status).toBe(404);
    expect((await call("/api/auth/me", { method: "PATCH", body: { name: "Eleven" }, cookie })).status).toBe(200);
  });

  it("config reports code mode", async () => {
    expect((await call("/api/config")).json.emailAuth).toBe("code");
  });

  it("code mode needs a mailer", async () => {
    setMailerForTests(null);
    expect((await call("/api/config")).json.emailAuth).toBe("password");
    expect((await send("code-12@example.com")).status).toBe(404);
  });

  it("password mode is unchanged", async () => {
    expect((await call("/api/config", { env })).json.emailAuth).toBe("password");
    expect((await call("/api/auth/code", { body: { email: "code-13@example.com" }, env })).status).toBe(404);
    expect((await call("/api/auth/signup", { body: { email: "code-13@example.com", password: "correct horse" }, env })).status).toBe(200);
  });

  it("parallel wrong guesses cannot beat the try limit", async () => {
    await send("code-par@example.com");
    const code = codeIn(sent[0]);
    const guesses: string[] = [...Array.from({ length: 12 }, () => wrong(code)), code];
    const results = await Promise.all(guesses.map(g => verify("code-par@example.com", g)));
    expect(results.at(-1)!.status).toBe(400);
    expect(results.every(r => r.status === 400)).toBe(true);
  });

  it("a burst of requests for one address sends at most 5", async () => {
    await Promise.all(Array.from({ length: 12 }, () => send("code-burst@example.com")));
    expect(sent.length).toBeLessThanOrEqual(5);
  });

  it("one network address gets at most 10 codes an hour", async () => {
    const from = { "cf-connecting-ip": "203.0.113.9" };
    for (let k = 0; k < 12; k++) expect((await call("/api/auth/code", { body: { email: `code-ip-${k}@example.com` }, headers: from })).json).toEqual({ ok: true });
    expect(sent).toHaveLength(10);
    await call("/api/auth/code", { body: { email: "code-ip-other@example.com" }, headers: { "cf-connecting-ip": "203.0.113.10" } });
    expect(sent).toHaveLength(11);
  });

  it("the instance sends at most its hourly total of codes", async () => {
    const now = Date.now();
    await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO email_codes (id, email, code_hash, expires_at, used_at, created_at) SELECT 'fill' || i, 'fill' || i || '@example.com', 'x', ?, ?, ? FROM n")
      .bind(CODES_PER_HOUR_TOTAL, now, now, now)
      .run();
    expect((await send("code-total@example.com")).json).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    await env.DB.prepare("DELETE FROM email_codes WHERE id LIKE 'fill%'").run();
  });

  it("an invalid invite neither creates an account nor uses up the code", async () => {
    const closed = { ...codeEnv, ALLOW_SIGNUP: "false" };
    await call("/api/auth/code", { body: { email: "code-badinvite@example.com" }, env: closed });
    const r = await call("/api/auth/code/verify", { body: { email: "code-badinvite@example.com", code: codeIn(sent[0]), invite: "no-such-invite" }, env: closed });
    expect(r).toMatchObject({ status: 400, json: { error: "This invite link is invalid or expired" } });
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = 'code-badinvite@example.com'").first()).toBeNull();
    const again = await call("/api/auth/code/verify", { body: { email: "code-badinvite@example.com", code: codeIn(sent[0]) }, env: closed });
    expect(again).toMatchObject({ status: 403, json: { error: "Sign up is invite-only on this instance" } });
  });

  it("sign-in posts without the x-rf header are refused", async () => {
    expect((await call("/api/auth/code", { body: { email: "code-csrf@example.com" }, headers: { "x-rf": "" } })).status).toBe(403);
    expect((await call("/api/auth/code/verify", { body: { email: "code-csrf@example.com", code: "123456" }, headers: { "x-rf": "" } })).status).toBe(403);
    expect((await call("/api/auth/login", { body: { email: "x@example.com", password: "correct horse" }, headers: { "x-rf": "" }, env })).status).toBe(403);
    expect((await call("/api/auth/signup", { body: { email: "x@example.com", password: "correct horse" }, headers: { "x-rf": "" }, env })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
