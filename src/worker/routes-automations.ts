// Automation routes: definitions and runs for editors, webhooks, and workspace mail settings.
import { failure, type LimitInfo } from "./hosting";
import { Hono } from "hono";
import { baseAccess, HttpError, requireUser, ROLE_RANK, stubFor, type AppContext, type Vars } from "./access";
import type { Env } from "./env";
import { LIMITS, type AutomationOp, type MailProvider } from "../shared/automations";
import { encryptSecret } from "./secrets";
import { sendWorkspaceMail } from "./auto/mail";

export const automationRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

async function body<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string; status?: number; limit?: LimitInfo }): T {
  if (!r.ok) throw failure(r, 400);
  return r.value;
}

const origin = (c: AppContext) => c.env.APP_URL || new URL(c.req.url).origin;

/** Editors and owners may read definitions and runs. */
async function editorAccess(c: AppContext, baseId: string) {
  const a = await baseAccess(c, baseId, "read");
  if (ROLE_RANK[a.role] < ROLE_RANK.editor) throw new HttpError(403, "Only editors can see automations");
  return a;
}

automationRoutes.get("/bases/:base/automations", async c => {
  const a = await editorAccess(c, c.req.param("base"));
  return c.json(await a.stub.automationList(origin(c)));
});

automationRoutes.post("/bases/:base/automations", async c => {
  const b = await body<AutomationOp>(c);
  // Switching off and deleting needs only read access, so a paused workspace can still stop its automations.
  const stopping = b?.op === "delete" || (b?.op === "setEnabled" && b.enabled === false);
  const a = stopping ? await editorAccess(c, c.req.param("base")) : await baseAccess(c, c.req.param("base"), "write");
  return c.json(unwrap(await a.stub.automationOp(a.actor, b, origin(c))));
});

automationRoutes.get("/bases/:base/automations/:id/runs", async c => {
  const a = await editorAccess(c, c.req.param("base"));
  const q = c.req.query();
  return c.json(unwrap(await a.stub.automationRuns(c.req.param("id"), { status: q.status || undefined, before: q.before ? Number(q.before) : undefined, limit: Math.min(100, Math.max(1, Number(q.limit) || 50)) })));
});

const EMAIL_RE = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;

automationRoutes.post("/bases/:base/automations/:id/run", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const b = await body<{ recordId: number; tableId?: string }>(c);
  const canEdit = ROLE_RANK[a.role] >= ROLE_RANK.editor && a.writable;
  return c.json(unwrap(await a.stub.runButton(a.actor, c.req.param("id"), Number(b.recordId), canEdit, typeof b.tableId === "string" ? b.tableId : undefined)));
});

automationRoutes.post("/bases/:base/automations/:id/test", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<{ recordId?: number; body?: unknown }>(c);
  return c.json(unwrap(await a.stub.testRun(a.actor, c.req.param("id"), b)));
});

automationRoutes.post("/bases/:base/runs/:runId/retry", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  return c.json(unwrap(await a.stub.retryRun(Number(c.req.param("runId")))));
});

/** The body up to `max` bytes, or null when it is longer; reading stops there, also without a Content-Length header. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function hookBody(type: string, text: string): unknown {
  if (!text.trim()) return {};
  if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "The body is not valid JSON");
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(text));
  return { text };
}

/** Incoming webhooks: the token in the URL is the credential. */
automationRoutes.post("/hooks/:baseId/:token", async c => {
  const tooLarge = () => new HttpError(413, `The body is larger than ${LIMITS.webhookBytes / 1024} KB`);
  if (Number(c.req.header("Content-Length") ?? "0") > LIMITS.webhookBytes) throw tooLarge();
  const raw = await readCapped(c.req.raw.body, LIMITS.webhookBytes);
  if (!raw) throw tooLarge();
  const payload = hookBody(c.req.header("Content-Type") ?? "", new TextDecoder().decode(raw));
  const base = await c.env.DB.prepare("SELECT id FROM bases WHERE id = ?").bind(c.req.param("baseId")).first<{ id: string }>();
  if (!base) throw new HttpError(404, "Webhook not found");
  const res = await stubFor(c.env, base.id).webhook(c.req.param("token"), payload);
  return c.json(res.body, res.status as 202);
});

async function requireOwner(c: AppContext, wsId: string) {
  const u = requireUser(c);
  const m = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(wsId, u.id).first<{ role: string }>();
  if (!m) throw new HttpError(404, "Workspace not found");
  if (m.role !== "owner") throw new HttpError(403, "Only workspace owners can do that");
  return u;
}

automationRoutes.get("/workspaces/:ws/mail", async c => {
  const ws = c.req.param("ws");
  await requireOwner(c, ws);
  const { results } = await c.env.DB.prepare("SELECT provider, from_address, from_name, settings, last4, updated_at FROM workspace_mail WHERE workspace_id = ? ORDER BY provider")
    .bind(ws)
    .all<{ provider: string; from_address: string; from_name: string | null; settings: string; last4: string; updated_at: number }>();
  return c.json({
    system: { available: !!(c.env.EMAIL && c.env.EMAIL_FROM), from: c.env.EMAIL_FROM ?? null },
    secretKey: !!c.env.SECRET_KEY,
    providers: results.map(r => ({ provider: r.provider, fromAddress: r.from_address, fromName: r.from_name, settings: JSON.parse(r.settings), last4: r.last4, updatedAt: r.updated_at })),
  });
});

automationRoutes.put("/workspaces/:ws/mail", async c => {
  const ws = c.req.param("ws");
  await requireOwner(c, ws);
  const b = await body<{ provider: string; fromAddress?: string; fromName?: string; settings?: Record<string, unknown>; secret?: string; remove?: boolean }>(c);
  if (b.provider !== "resend" && b.provider !== "smtp") throw new HttpError(400, "Choose Resend or SMTP");
  if (b.remove) {
    await c.env.DB.prepare("DELETE FROM workspace_mail WHERE workspace_id = ? AND provider = ?").bind(ws, b.provider).run();
    return c.json({ ok: true });
  }
  if (!c.env.SECRET_KEY) throw new HttpError(400, "Set the SECRET_KEY environment variable to store mail credentials");
  const from = String(b.fromAddress ?? "").trim();
  if (!EMAIL_RE.test(from)) throw new HttpError(400, "Enter the address emails are sent from");
  let settings: Record<string, unknown> = {};
  if (b.provider === "smtp") {
    const s = b.settings ?? {};
    const host = String(s.host ?? "").trim();
    const port = Number(s.port);
    if (!host || /[\s/]/.test(host)) throw new HttpError(400, "Enter the SMTP host");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Enter the SMTP port");
    if (!["tls", "starttls", "none"].includes(String(s.security))) throw new HttpError(400, "Choose TLS, STARTTLS or none");
    settings = { host, port, security: s.security, username: String(s.username ?? "").trim() };
  }
  const existing = await c.env.DB.prepare("SELECT secret_enc, last4 FROM workspace_mail WHERE workspace_id = ? AND provider = ?").bind(ws, b.provider).first<{ secret_enc: string; last4: string }>();
  const secret = typeof b.secret === "string" ? b.secret.trim() : "";
  if (!secret && !existing) throw new HttpError(400, b.provider === "resend" ? "Enter the Resend API key" : "Enter the SMTP password");
  if (secret.length > 500) throw new HttpError(400, "The secret is too long");
  const enc = secret ? await encryptSecret(c.env.SECRET_KEY, secret) : existing!.secret_enc;
  const last4 = secret ? secret.slice(-4) : existing!.last4;
  await c.env.DB.prepare(
    "INSERT INTO workspace_mail (workspace_id, provider, from_address, from_name, settings, secret_enc, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, provider) DO UPDATE SET from_address = excluded.from_address, from_name = excluded.from_name, settings = excluded.settings, secret_enc = excluded.secret_enc, last4 = excluded.last4, updated_at = excluded.updated_at",
  )
    .bind(ws, b.provider, from, String(b.fromName ?? "").trim() || null, JSON.stringify(settings), enc, last4, Date.now())
    .run();
  return c.json({ ok: true });
});

automationRoutes.post("/workspaces/:ws/mail/test", async c => {
  const ws = c.req.param("ws");
  const u = await requireOwner(c, ws);
  const b = await body<{ provider: MailProvider; to?: string }>(c);
  const to = String(b.to ?? u.email).trim();
  if (!EMAIL_RE.test(to)) throw new HttpError(400, "Enter a valid address");
  try {
    await sendWorkspaceMail({ env: c.env }, ws, b.provider, { to: [to], cc: [], subject: "Rowflare test email", body: "Email sending works. Automations in this workspace can now send email.", format: "text" }, 15_000);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  return c.json({ ok: true, to });
});
