// Rowflare Worker: control plane (accounts, workspaces, bases in D1), routing to one Durable Object per base,
// attachments in R2, public forms and the REST API. Static app assets are served by Workers Assets.
import { Hono } from "hono";
import { baseAccess, HttpError, ROLE_RANK, stubFor, workspaceMembers, type AppContext, type Vars } from "./access";
import type { Env } from "./env";
import { authenticate, clearCookie, hashPassword, randomToken, sha256, verifyPassword, type User } from "./auth";
import { requireUser } from "./access";
import { acceptInvite, checkInvite, createAccount, createWorkspace, newId, normalEmail, sessionHeader, signInProvenEmail, signupOpen, syncMembers } from "./accounts";
import { TEMPLATES } from "./templates";
import type { RowOp, SchemaOp } from "./base-do";
import type { Role } from "../shared/types";
import { COLORS, COMPUTED_TYPES } from "../shared/types";
import { newAttachmentId } from "../shared/ids";
import { apiV1 } from "./api-v1";
import { mcpRoutes } from "./mcp/server";
import { benchRoutes } from "./bench";
import { automationRoutes } from "./routes-automations";
import { aiRoutes } from "./routes-ai";
import { ensureSchema } from "./schema";
import { devHostingRoutes, useDevHosting } from "./dev-hosting";
import { codeMail, instanceMailer, issueToken, resetMail, underMailLimit, useToken, verifyMail } from "./account-mail";
import { checkCode, emailAuthMode, issueCode } from "./email-code";
import { addUpload, recountStorage, storageUsed, workspaceUsage } from "./limits";
import { failure, hosting, hostingExempt, LimitError, planFor, setHosting, type Hosting, type LimitInfo } from "./hosting";

export { BaseDO } from "./base-do";


const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const id = newId;
const isSecure = (c: AppContext) => new URL(c.req.url).protocol === "https:";

app.onError((err, c) => {
  if (err instanceof LimitError) return c.json({ error: err.message, limit: err.limit }, 402);
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

const SIGN_IN_PATHS = new Set(["/api/auth/login", "/api/auth/signup", "/api/auth/code", "/api/auth/code/verify"]);

// Auth for every API call; cookie-authenticated writes must carry a custom header (CSRF guard).
app.use("/api/*", async (c, next) => {
  useDevHosting(c.env);
  await ensureSchema(c.env);
  const auth = await authenticate(c.env, c.req.raw);
  c.set("user", auth?.user ?? null);
  c.set("via", auth?.via ?? null);
  const m = c.req.method;
  // Webhooks and public forms authenticate otherwise; a hosting may add more exempt prefixes.
  const exempt = c.req.path.startsWith("/api/forms/") || c.req.path.startsWith("/api/hooks/") || hostingExempt(c.req.path);
  // Sign-in posts need it too, without a session: a form on another site must not sign a visitor into someone else's account.
  const signIn = m === "POST" && SIGN_IN_PATHS.has(c.req.path);
  if ((auth?.via === "session" || signIn) && m !== "GET" && m !== "HEAD" && !exempt && c.req.header("x-rf") !== "1") throw new HttpError(403, "Missing x-rf header");
  await next();
});


async function body<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string; status?: number; limit?: LimitInfo }): T {
  if (!r.ok) throw r.limit ? failure(r, 400) : new HttpError(400, r.error);
  return r.value;
}

// ---------- config ----------

app.get("/api/config", async c => {
  return c.json({
    mode: c.env.MODE ?? "selfhost",
    signupOpen: await signupOpen(c.env),
    billing: !!hosting().billing,
    accountMail: !!instanceMailer(c.env),
    emailAuth: emailAuthMode(c.env),
    signInOptions: hosting().signInOptions?.(c.env) ?? [],
    templates: TEMPLATES,
  });
});

// ---------- accounts ----------

const validEmail = (email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

/** Password routes exist only in password mode, the code routes only in code mode. */
function requireEmailAuth(c: AppContext, mode: "password" | "code") {
  if (emailAuthMode(c.env) !== mode) throw new HttpError(404, "Not found");
}

app.post("/api/auth/code", async c => {
  requireEmailAuth(c, "code");
  const b = await body<{ email?: string }>(c);
  const email = normalEmail(String(b.email ?? ""));
  if (!validEmail(email)) throw new HttpError(400, "Enter a valid email");
  // The answer is the same for every address, known or not, and when the hourly limit is reached.
  const code = await issueCode(c.env, email, c.req.header("cf-connecting-ip") ?? null);
  if (code) c.executionCtx.waitUntil(instanceMailer(c.env)!(codeMail(email, code)).catch(e => console.error("code email failed", e)));
  return c.json({ ok: true });
});

app.post("/api/auth/code/verify", async c => {
  requireEmailAuth(c, "code");
  const b = await body<{ email?: string; code?: string; invite?: string }>(c);
  const email = normalEmail(String(b.email ?? ""));
  // A bad invite is refused before the code is used up.
  if (b.invite) await checkInvite(c.env, String(b.invite));
  if (!(await checkCode(c.env, email, String(b.code ?? "")))) throw new HttpError(400, "This code is wrong or has expired");
  const { userId } = await signInProvenEmail(c.env, { email, invite: b.invite ? String(b.invite) : undefined });
  c.header("Set-Cookie", await sessionHeader(c.env, userId, isSecure(c)));
  return c.json({ ok: true });
});

app.post("/api/auth/signup", async c => {
  requireEmailAuth(c, "password");
  const b = await body<{ email: string; password: string; name?: string; invite?: string }>(c);
  const email = normalEmail(String(b.email ?? ""));
  if (!validEmail(email)) throw new HttpError(400, "Enter a valid email");
  if (String(b.password ?? "").length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  const open = await signupOpen(c.env);
  if (!open && !b.invite) throw new HttpError(403, "Sign up is invite-only on this instance");
  if (await c.env.DB.prepare("SELECT 1 x FROM users WHERE email = ?").bind(email).first()) throw new HttpError(400, "An account with this email already exists");
  const userId = await createAccount(c.env, { email, name: String(b.name ?? ""), passwordHash: await hashPassword(b.password), verified: false, invite: b.invite });
  c.header("Set-Cookie", await sessionHeader(c.env, userId, isSecure(c)));
  c.executionCtx.waitUntil(sendVerify(c, userId, email).catch(e => console.error("verification email failed", e)));
  return c.json({ ok: true });
});

const appOrigin = (c: AppContext) => (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, "");

/** Mails a verification link; false when this instance has no mail or the address had its emails for this hour. */
async function sendVerify(c: AppContext, userId: string, email: string): Promise<boolean> {
  const mailer = instanceMailer(c.env);
  if (!mailer || !(await underMailLimit(c.env, userId))) return false;
  const token = await issueToken(c.env, userId, "verify");
  await mailer(verifyMail(email, `${appOrigin(c)}/verify?token=${token}`));
  return true;
}

function requireMailer(c: AppContext) {
  const mailer = instanceMailer(c.env);
  if (!mailer) throw new HttpError(400, "Email is not set up on this instance");
  return mailer;
}

app.post("/api/auth/forgot", async c => {
  requireEmailAuth(c, "password");
  const mailer = requireMailer(c);
  const b = await body<{ email?: string }>(c);
  const email = String(b.email ?? "").trim().toLowerCase();
  const row = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  // The answer is the same whether or not the address has an account.
  if (row && (await underMailLimit(c.env, row.id))) {
    const token = await issueToken(c.env, row.id, "reset");
    c.executionCtx.waitUntil(mailer(resetMail(email, `${appOrigin(c)}/reset?token=${token}`)).catch(e => console.error("reset email failed", e)));
  }
  return c.json({ ok: true });
});

app.post("/api/auth/reset", async c => {
  requireEmailAuth(c, "password");
  const b = await body<{ token?: string; password?: string }>(c);
  const password = String(b.password ?? "");
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  const userId = await useToken(c.env, String(b.token ?? ""), "reset");
  if (!userId) throw new HttpError(400, "This link is invalid or has expired");
  const now = Date.now();
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, email_verified_at = coalesce(email_verified_at, ?) WHERE id = ?").bind(await hashPassword(password), now, userId).run();
  // Every other session of the account ends; the browser that reset the password stays or becomes signed in.
  const auth = await authenticate(c.env, c.req.raw);
  const keep = auth?.via === "session" && auth.user.id === userId ? auth.sessionId! : "";
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(userId, keep).run();
  if (!keep) {
    c.header("Set-Cookie", await sessionHeader(c.env, userId, isSecure(c)));
  }
  return c.json({ ok: true });
});

app.post("/api/auth/verify", async c => {
  const b = await body<{ token?: string }>(c);
  const userId = await useToken(c.env, String(b.token ?? ""), "verify");
  if (!userId) throw new HttpError(400, "This link is invalid or has expired");
  await c.env.DB.prepare("UPDATE users SET email_verified_at = coalesce(email_verified_at, ?) WHERE id = ?").bind(Date.now(), userId).run();
  return c.json({ ok: true });
});

app.post("/api/auth/verify/resend", async c => {
  requireEmailAuth(c, "password");
  const u = requireUser(c);
  requireMailer(c);
  if (await emailVerified(c.env, u.id)) return c.json({ ok: true });
  if (!(await sendVerify(c, u.id, u.email))) throw new HttpError(429, "Too many emails to this address; try again in an hour");
  return c.json({ ok: true });
});

async function emailVerified(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT email_verified_at FROM users WHERE id = ?").bind(userId).first<{ email_verified_at: number | null }>())?.email_verified_at;
}

app.post("/api/auth/login", async c => {
  requireEmailAuth(c, "password");
  const b = await body<{ email: string; password: string; invite?: string }>(c);
  const row = await c.env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?").bind(String(b.email ?? "").trim().toLowerCase()).first<{ id: string; password_hash: string }>();
  if (!row || !(await verifyPassword(String(b.password ?? ""), row.password_hash))) throw new HttpError(401, "Wrong email or password");
  if (b.invite) await acceptInvite(c.env, b.invite, row.id);
  c.header("Set-Cookie", await sessionHeader(c.env, row.id, isSecure(c)));
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async c => {
  const auth = await authenticate(c.env, c.req.raw);
  if (auth?.sessionId) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(auth.sessionId).run();
  c.header("Set-Cookie", clearCookie(isSecure(c)));
  return c.json({ ok: true });
});

app.get("/api/auth/me", async c => {
  const u = c.get("user");
  if (!u) return c.json({ user: null, workspaces: [] });
  return c.json({ user: { ...u, emailVerified: await emailVerified(c.env, u.id) }, workspaces: await listWorkspaces(c.env, u.id) });
});

app.patch("/api/auth/me", async c => {
  const u = requireUser(c);
  const b = await body<{ name?: string; password?: string; currentPassword?: string }>(c);
  if (b.name !== undefined) await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(String(b.name).trim() || u.name, u.id).run();
  if (b.password !== undefined) {
    requireEmailAuth(c, "password");
    const row = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(u.id).first<{ password_hash: string }>();
    if (!(await verifyPassword(String(b.currentPassword ?? ""), row?.password_hash ?? null))) throw new HttpError(400, "Current password is wrong");
    if (String(b.password).length < 8) throw new HttpError(400, "Password must be at least 8 characters");
    await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(b.password), u.id).run();
  }
  return c.json({ ok: true });
});

// ---------- workspaces & members ----------

async function listWorkspaces(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at",
  )
    .bind(userId)
    .all<{ id: string; name: string; role: Role }>();
  return results;
}

async function workspaceRole(env: Env, wsId: string, userId: string): Promise<Role | null> {
  const r = await env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(wsId, userId).first<{ role: Role }>();
  return r?.role ?? null;
}

async function requireWorkspace(c: AppContext, wsId: string, need: Role) {
  const u = requireUser(c);
  const role = await workspaceRole(c.env, wsId, u.id);
  if (!role) throw new HttpError(404, "Workspace not found");
  if (ROLE_RANK[role] < ROLE_RANK[need]) throw new HttpError(403, "You do not have permission to do that");
  return { user: u, role };
}

app.get("/api/workspaces", async c => c.json(await listWorkspaces(c.env, requireUser(c).id)));

app.post("/api/workspaces", async c => {
  const u = requireUser(c);
  const b = await body<{ name: string }>(c);
  return c.json({ id: await createWorkspace(c.env, u.id, String(b.name ?? "").trim() || "Workspace") });
});

app.patch("/api/workspaces/:ws", async c => {
  await requireWorkspace(c, c.req.param("ws"), "owner");
  const b = await body<{ name: string }>(c);
  await c.env.DB.prepare("UPDATE workspaces SET name = ? WHERE id = ?").bind(String(b.name ?? "").trim() || "Workspace", c.req.param("ws")).run();
  return c.json({ ok: true });
});

app.delete("/api/workspaces/:ws", async c => {
  const wsId = c.req.param("ws");
  await requireWorkspace(c, wsId, "owner");
  await hosting().beforeWorkspaceDeleted?.(c.env, wsId);
  const { results } = await c.env.DB.prepare("SELECT id FROM bases WHERE workspace_id = ?").bind(wsId).all<{ id: string }>();
  for (const b of results) await destroyBase(c.env, b.id);
  await c.env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(wsId).run();
  return c.json({ ok: true });
});

app.get("/api/workspaces/:ws/members", async c => {
  await requireWorkspace(c, c.req.param("ws"), "viewer");
  return c.json(await workspaceMembers(c.env, c.req.param("ws")));
});

app.patch("/api/workspaces/:ws/members/:user", async c => {
  const wsId = c.req.param("ws");
  await requireWorkspace(c, wsId, "owner");
  const b = await body<{ role: Role }>(c);
  if (!(b.role in ROLE_RANK)) throw new HttpError(400, "Invalid role");
  if (b.role !== "owner") {
    const owners = await c.env.DB.prepare("SELECT count(*) n FROM members WHERE workspace_id = ? AND role = 'owner' AND user_id <> ?").bind(wsId, c.req.param("user")).first<{ n: number }>();
    if (!owners?.n) throw new HttpError(400, "A workspace needs at least one owner");
  }
  await c.env.DB.prepare("UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?").bind(b.role, wsId, c.req.param("user")).run();
  await syncMembers(c.env, wsId);
  return c.json({ ok: true });
});

app.delete("/api/workspaces/:ws/members/:user", async c => {
  const wsId = c.req.param("ws");
  const { user } = await requireWorkspace(c, wsId, user0(c) === c.req.param("user") ? "viewer" : "owner");
  const owners = await c.env.DB.prepare("SELECT count(*) n FROM members WHERE workspace_id = ? AND role = 'owner' AND user_id <> ?").bind(wsId, c.req.param("user")).first<{ n: number }>();
  if (!owners?.n) throw new HttpError(400, "A workspace needs at least one owner");
  await c.env.DB.prepare("DELETE FROM members WHERE workspace_id = ? AND user_id = ?").bind(wsId, c.req.param("user")).run();
  await syncMembers(c.env, wsId);
  return c.json({ ok: true, self: user.id === c.req.param("user") });
});

function user0(c: AppContext) {
  return c.get("user")?.id;
}

app.post("/api/workspaces/:ws/invites", async c => {
  const wsId = c.req.param("ws");
  const { user } = await requireWorkspace(c, wsId, "owner");
  const b = await body<{ role?: Role }>(c);
  const role: Role = b.role && b.role in ROLE_RANK ? b.role : "editor";
  const inviteId = randomToken(18);
  await c.env.DB.prepare("INSERT INTO invites (id, workspace_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(inviteId, wsId, role, user.id, Date.now(), Date.now() + 7 * 86400000)
    .run();
  return c.json({ id: inviteId, url: `${new URL(c.req.url).origin}/invite/${inviteId}` });
});

app.get("/api/invites/:id", async c => {
  const inv = await c.env.DB.prepare("SELECT i.role, i.expires_at, w.name FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = ?")
    .bind(c.req.param("id"))
    .first<{ role: Role; expires_at: number; name: string }>();
  if (!inv || inv.expires_at < Date.now()) throw new HttpError(404, "This invite link is invalid or expired");
  return c.json({ workspace: inv.name, role: inv.role });
});

app.post("/api/invites/:id/accept", async c => {
  const u = requireUser(c);
  return c.json({ workspaceId: await acceptInvite(c.env, c.req.param("id"), u.id) });
});

// ---------- bases ----------

async function createBase(env: Env, wsId: string, name: string, template: string, user: User): Promise<string> {
  const baseId = id("app");
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  await env.DB.prepare("INSERT INTO bases (id, workspace_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)").bind(baseId, wsId, name, color, Date.now()).run();
  await stubFor(env, baseId).init(baseId, { template, members: await workspaceMembers(env, wsId), actor: { userId: user.id, name: user.name } });
  return baseId;
}

async function destroyBase(env: Env, baseId: string) {
  await stubFor(env, baseId).destroy();
  let cursor: string | undefined;
  do {
    const list = await env.FILES.list({ prefix: baseId + "/", cursor });
    if (list.objects.length) await env.FILES.delete(list.objects.map(o => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await env.DB.prepare("DELETE FROM bases WHERE id = ?").bind(baseId).run();
}

app.get("/api/workspaces/:ws/bases", async c => {
  await requireWorkspace(c, c.req.param("ws"), "viewer");
  const { results } = await c.env.DB.prepare("SELECT id, name, color, created_at FROM bases WHERE workspace_id = ? ORDER BY created_at").bind(c.req.param("ws")).all();
  return c.json(results);
});

/** Refuses a new base when the workspace's plan has no room for it. */
async function checkBaseLimit(env: Env, wsId: string) {
  const plan = await planFor(env, wsId);
  const max = plan.limits.bases;
  if (max === undefined) return;
  const n = (await env.DB.prepare("SELECT count(*) n FROM bases WHERE workspace_id = ?").bind(wsId).first<{ n: number }>())?.n ?? 0;
  if (n >= max) throw new LimitError(`This plan allows ${max.toLocaleString("en-US")} ${max === 1 ? "base" : "bases"} per workspace`, { key: "bases", limit: max, upgradeUrl: plan.upgradeUrl });
}

app.post("/api/workspaces/:ws/bases", async c => {
  const wsId = c.req.param("ws");
  const { user } = await requireWorkspace(c, wsId, "editor");
  await checkBaseLimit(c.env, wsId);
  const b = await body<{ name?: string; template?: string }>(c);
  const template = TEMPLATES.some(t => t.slug === b.template) ? b.template! : "blank";
  const name = String(b.name ?? "").trim() || TEMPLATES.find(t => t.slug === template)?.name || "Untitled base";
  return c.json({ id: await createBase(c.env, wsId, name, template, user) });
});

// ---------- plan, usage and billing ----------

app.get("/api/workspaces/:ws/usage", async c => {
  const wsId = c.req.param("ws");
  await requireWorkspace(c, wsId, "viewer");
  return c.json(await workspaceUsage(c.env, wsId));
});

app.get("/api/workspaces/:ws/billing", async c => {
  const wsId = c.req.param("ws");
  const { user } = await requireWorkspace(c, wsId, "viewer");
  const billing = hosting().billing;
  if (!billing) throw new HttpError(404, "Not found");
  return c.json(await billing(c.env, wsId, user.id));
});

app.get("/api/bases/:base", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const members = await workspaceMembers(c.env, a.base.workspace_id);
  await a.stub.setMembers(members);
  return c.json({ base: a.base, role: a.role, writable: a.writable, schema: await a.stub.schema(), members, me: a.user });
});

app.patch("/api/bases/:base", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<{ name?: string; color?: string }>(c);
  await c.env.DB.prepare("UPDATE bases SET name = coalesce(?, name), color = coalesce(?, color) WHERE id = ?").bind(b.name?.trim() || null, b.color ?? null, a.base.id).run();
  return c.json({ ok: true });
});

app.delete("/api/bases/:base", async c => {
  const a = await baseAccess(c, c.req.param("base"), "admin");
  await destroyBase(c.env, a.base.id);
  return c.json({ ok: true });
});

app.post("/api/bases/:base/rows/check", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<{ count?: number }>(c);
  unwrap(await a.stub.checkRoom(Number(b.count) || 0));
  return c.json({ ok: true });
});

app.post("/api/bases/:base/query", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const b = await body<{ tableId: string } & import("./base/store").QueryInput>(c);
  return c.json(unwrap(await a.stub.query(b.tableId, b)));
});

app.post("/api/bases/:base/aggregate", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const b = await body<{ tableId: string } & import("./base/aggregate").AggregateInput>(c);
  return c.json(unwrap(await a.stub.aggregate(b.tableId, b)));
});

app.post("/api/bases/:base/aggregate/records", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const b = await body<{ tableId: string; key: import("./base/aggregate").GroupKey[] } & import("./base/aggregate").AggregateInput>(c);
  return c.json(unwrap(await a.stub.aggregateRecords(b.tableId, b, b.key)));
});


app.post("/api/bases/:base/rows/get", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const b = await body<{ tableId: string; ids: number[] }>(c);
  if (!Array.isArray(b.ids) || b.ids.length > 2000) throw new HttpError(400, "Pass up to 2,000 ids");
  return c.json(unwrap(await a.stub.rows(b.tableId, b.ids)));
});

app.post("/api/bases/:base/rows", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<RowOp & { clientId?: string }>(c);
  return c.json(unwrap(await a.stub.rowOp(a.actor, b, b.clientId)));
});

app.post("/api/bases/:base/schema", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<SchemaOp & { clientId?: string }>(c);
  const res = unwrap(await a.stub.schemaOp(a.actor, b, b.clientId));
  return c.json({ schema: res.schema, id: res.id });
});

app.get("/api/bases/:base/ws", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  if (c.req.header("Upgrade") !== "websocket") throw new HttpError(426, "Expected WebSocket");
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-user-id", a.user.id);
  headers.set("x-user-name", a.user.name);
  return a.stub.fetch(new Request(c.req.url, { headers }));
});

app.get("/api/bases/:base/export.csv", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const tableId = c.req.query("tableId") ?? "";
  const csv = unwrap(await a.stub.exportCsv(tableId, c.req.query("viewId") || undefined));
  const name = (c.req.query("name") ?? "export").replace(/[^\w\- ]+/g, "_");
  return new Response("﻿" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
});

app.post("/api/bases/:base/import/airtable", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<{ token: string; airtableBaseId: string }>(c);
  return c.json(unwrap(await a.stub.startAirtableImport(a.actor, b)));
});

// ---------- attachments ----------

const MAX_UPLOAD = 100 * 1024 * 1024;

async function storeUpload(c: AppContext, baseId: string, workspaceId: string, opts: { form?: boolean } = {}) {
  const name = (c.req.query("name") ?? "file").slice(0, 200);
  const type = c.req.header("Content-Type") ?? "application/octet-stream";
  const size = Number(c.req.header("Content-Length") ?? "0");
  if (size > MAX_UPLOAD) throw new HttpError(413, "Files are limited to 100 MB");
  if (!c.req.raw.body) throw new HttpError(400, "Empty upload");
  const plan = await planFor(c.env, workspaceId);
  const max = plan.limits.attachmentBytes;
  const used = max === undefined ? 0 : await storageUsed(c.env, workspaceId);
  const over = (n: number) =>
    new LimitError(`This plan allows ${fmtBytes(max!)} of attachments; ${fmtBytes(Math.max(0, max! - used))} ${max! - used === 1 ? "is" : "are"} left`, { key: "attachments", limit: max!, upgradeUrl: plan.upgradeUrl });
  if (max !== undefined && used + size > max) throw over(size);
  const attId = newAttachmentId();
  // Form uploads live under a distinct prefix so submissions cannot reference arbitrary files.
  const key = `${baseId}/${opts.form ? "form-" : ""}${attId}/${name.replace(/[^\w.\- ]+/g, "_")}`;
  const obj = await c.env.FILES.put(key, c.req.raw.body, { httpMetadata: { contentType: type } });
  const stored = obj?.size ?? size;
  // Without a Content-Length the size is known only now.
  if (max !== undefined && used + stored > max) {
    await c.env.FILES.delete(key);
    throw over(stored);
  }
  await addUpload(c.env, workspaceId, stored);
  await stubFor(c.env, baseId).noteFile(key, stored);
  return { id: attId, name, size: stored, type, key };
}

/** Bytes as people read them, in the same decimal units as the app: "1,000 bytes" below 10 KB, else "500 KB", "100 MB", "20 GB". */
function fmtBytes(n: number): string {
  const units: [number, string][] = [[1e9, "GB"], [1e6, "MB"], [1e3, "KB"]];
  for (const [u, label] of units) if (n >= u * 10 || (n >= u && u > 1e3)) return `${(n / u).toLocaleString("en-US", { maximumFractionDigits: 1 })} ${label}`;
  return `${n.toLocaleString("en-US")} bytes`;
}

app.post("/api/bases/:base/attachments", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  return c.json(await storeUpload(c, a.base.id, a.base.workspace_id));
});

app.get("/api/files/*", async c => {
  const key = decodeURIComponent(c.req.path.slice("/api/files/".length));
  const baseId = key.split("/")[0];
  // Files of a base are visible to its members, and to anyone holding a form link for uploads they just made.
  await baseAccess(c, baseId, "read");
  const obj = await c.env.FILES.get(key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
  if (!obj) throw new HttpError(404, "File not found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  const inline = /^(image|video|audio)\/|^application\/pdf$/.test(obj.httpMetadata?.contentType ?? "");
  headers.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${key.split("/").pop()}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { headers, status: c.req.header("Range") && obj.range ? 206 : 200 });
});

// ---------- public forms ----------

app.post("/api/bases/:base/forms", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<{ viewId: string }>(c);
  const schema = await a.stub.schema();
  const view = schema.views.find(v => v.id === b.viewId && v.type === "form");
  if (!view) throw new HttpError(404, "Form view not found");
  let shareId = view.config.form?.shareId;
  if (!shareId) {
    shareId = randomToken(16);
    await c.env.DB.prepare("INSERT INTO shares (id, base_id, table_id, view_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(shareId, a.base.id, view.tableId, view.id, Date.now()).run();
    unwrap(await a.stub.schemaOp(a.actor, { op: "updateView", viewId: view.id, patch: { config: { form: { ...view.config.form, shareId } } } }));
  }
  return c.json({ shareId, url: `${new URL(c.req.url).origin}/form/${shareId}` });
});

app.delete("/api/bases/:base/forms/:share", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const share = await c.env.DB.prepare("SELECT view_id FROM shares WHERE id = ? AND base_id = ?").bind(c.req.param("share"), a.base.id).first<{ view_id: string }>();
  if (!share) throw new HttpError(404, "Not found");
  await c.env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(c.req.param("share")).run();
  const schema = await a.stub.schema();
  const view = schema.views.find(v => v.id === share.view_id);
  if (view) unwrap(await a.stub.schemaOp(a.actor, { op: "updateView", viewId: view.id, patch: { config: { form: { ...view.config.form, shareId: undefined } } } }));
  return c.json({ ok: true });
});

async function loadShare(env: Env, shareId: string) {
  const share = await env.DB.prepare("SELECT s.base_id, s.table_id, s.view_id, b.workspace_id FROM shares s JOIN bases b ON b.id = s.base_id WHERE s.id = ?")
    .bind(shareId)
    .first<{ base_id: string; table_id: string; view_id: string; workspace_id: string }>();
  if (!share) throw new HttpError(404, "This form is no longer available");
  const stub = stubFor(env, share.base_id);
  const schema = await stub.schema();
  const view = schema.views.find(v => v.id === share.view_id);
  if (!view || view.type !== "form") throw new HttpError(404, "This form is no longer available");
  const fields = (view.config.form?.fields ?? [])
    .map(ff => ({ ff, f: schema.fields.find(x => x.id === ff.fieldId && x.tableId === share.table_id) }))
    .filter((x): x is { ff: typeof x.ff; f: NonNullable<typeof x.f> } => !!x.f && !COMPUTED_TYPES.has(x.f.type));
  return { share, stub, schema, view, fields };
}

app.get("/api/forms/:share", async c => {
  const { view, fields, schema, share } = await loadShare(c.env, c.req.param("share"));
  const linkOptions: Record<string, { id: number; t: string }[]> = {};
  const stub = stubFor(c.env, share.base_id);
  for (const { f } of fields) {
    if (f.type !== "link" || !f.options.linkedTableId) continue;
    const q = unwrap(await stub.query(f.options.linkedTableId, { limit: 500 }));
    const primary = schema.tables.find(t => t.id === f.options.linkedTableId)?.primaryFieldId ?? "";
    linkOptions[f.id] = q.rows.map(r => ({ id: r.id, t: String(r.cells[primary] ?? "") }));
  }
  return c.json({
    title: view.config.form?.title ?? view.name,
    description: view.config.form?.description ?? "",
    submitText: view.config.form?.submitText ?? "Submit",
    successText: view.config.form?.successText ?? "Thanks, your response was recorded.",
    fields: fields.map(({ ff, f }) => ({ id: f.id, name: ff.label || f.name, help: ff.help ?? f.description ?? "", required: !!ff.required, type: f.type, options: f.options })),
    linkOptions,
  });
});

app.post("/api/forms/:share", async c => {
  const { share, stub, fields } = await loadShare(c.env, c.req.param("share"));
  const b = await body<{ cells: Record<string, unknown> }>(c);
  const cells: Record<string, unknown> = {};
  for (const { ff, f } of fields) {
    const v = b.cells?.[f.id];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (ff.required && empty) throw new HttpError(400, `${ff.label || f.name} is required`);
    if (f.type === "attachment" && Array.isArray(v)) {
      // Only accept files uploaded through this form's upload endpoint.
      cells[f.id] = v.filter(x => typeof x?.key === "string" && x.key.startsWith(`${share.base_id}/form-`));
    } else if (!empty) cells[f.id] = v;
  }
  unwrap(await stub.rowOp({ userId: "", name: "Form" }, { op: "create", tableId: share.table_id, rows: [{ cells }], typecast: false }));
  return c.json({ ok: true });
});

app.post("/api/forms/:share/attachments", async c => {
  const { share } = await loadShare(c.env, c.req.param("share"));
  return c.json(await storeUpload(c, share.base_id, share.workspace_id, { form: true }));
});

// ---------- personal access tokens ----------

app.get("/api/tokens", async c => {
  const u = requireUser(c);
  const { results } = await c.env.DB.prepare("SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC").bind(u.id).all();
  return c.json(results);
});

app.post("/api/tokens", async c => {
  const u = requireUser(c);
  if (c.get("via") !== "session") throw new HttpError(403, "Tokens can only be created from the app");
  const b = await body<{ name?: string }>(c);
  const token = "rf_" + randomToken(24);
  const tokenId = id("tok");
  await c.env.DB.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(tokenId, u.id, String(b.name ?? "").trim() || "API token", await sha256(token), Date.now())
    .run();
  return c.json({ id: tokenId, token });
});

app.delete("/api/tokens/:id", async c => {
  const u = requireUser(c);
  await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").bind(c.req.param("id"), u.id).run();
  return c.json({ ok: true });
});

app.route("/api", aiRoutes);
app.route("/api", automationRoutes);
app.route("/api/v1", apiV1);
app.route("/api/_bench", benchRoutes);
app.route("/mcp", mcpRoutes);

// A not-found handler, not a catch-all route, so routes a hosting adds later still match.
app.notFound(c => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.text("Not found", 404)));

/** Registers a hosting extension and its routes; a hosted edition calls this once at module load. */
devHostingRoutes(app);

export function extendApp(h: Hosting) {
  setHosting(h);
  h.routes?.(app);
}

// ---------- scheduled cleanup ----------

async function cleanup(env: Env) {
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare("DELETE FROM invites WHERE expires_at < ?").bind(Date.now()).run();
  await recountStorage(env, Date.now());
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env));
    const extra = hosting().scheduled;
    if (extra) ctx.waitUntil(extra(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;

export { cleanup, createBase };
