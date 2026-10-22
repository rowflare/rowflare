// AI routes: workspace services (owners), the service list for a base, and per-field generation controls.
import { failure, type LimitInfo } from "./hosting";
import { Hono } from "hono";
import { baseAccess, HttpError, requireUser, stubFor, type AppContext, type Vars } from "./access";
import type { Env } from "./env";
import { encryptSecret } from "./secrets";
import { newAiServiceId } from "../shared/ids";
import { AI_LIMITS, WORKERS_SERVICE_ID, type AiServiceKind } from "../shared/ai";
import { callDeps, listServices, loadService } from "./ai/services";
import { callModel, type ModelService } from "./ai/providers";
import type { FieldOptions, FieldType } from "../shared/types";

const KEY_AGAIN = "Enter the API key again when you change the address or kind";

export const aiRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

async function body<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

async function member(c: AppContext, ws: string): Promise<{ role: string }> {
  const u = requireUser(c);
  const m = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(ws, u.id).first<{ role: string }>();
  if (!m) throw new HttpError(404, "Workspace not found");
  return m;
}

async function owner(c: AppContext, ws: string) {
  if ((await member(c, ws)).role !== "owner") throw new HttpError(403, "Only workspace owners can do that");
}

interface ServiceInput {
  name?: string;
  kind?: string;
  baseUrl?: string;
  model?: string;
  key?: string;
}

/** Checks a service form; returns the clean values. */
function checked(c: AppContext, b: ServiceInput, hasStoredKey: boolean) {
  const name = String(b.name ?? "").trim().slice(0, 60);
  if (!name) throw new HttpError(400, "Enter a name");
  const kind = b.kind as AiServiceKind;
  if (kind !== "anthropic" && kind !== "openai") throw new HttpError(400, "Choose Anthropic or an OpenAI-compatible service");
  let baseUrl: string | null = null;
  if (kind === "openai") {
    baseUrl = String(b.baseUrl ?? "").trim().replace(/\/+$/, "");
    const ok = /^https:\/\/[^\s/]+/.test(baseUrl) || (c.env.AUTOMATION_ALLOW_PRIVATE === "true" && /^http:\/\/[^\s/]+/.test(baseUrl));
    if (!ok) throw new HttpError(400, "The service address must start with https://");
  }
  const model = String(b.model ?? "").trim().slice(0, 200);
  if (!model) throw new HttpError(400, "Enter a model name");
  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!key && !hasStoredKey) throw new HttpError(400, "Enter the API key");
  if (key.length > 500) throw new HttpError(400, "The key is too long");
  return { name, kind, baseUrl, model, key };
}

aiRoutes.get("/workspaces/:ws/ai-services", async c => {
  const ws = c.req.param("ws");
  const m = await member(c, ws);
  const services = await listServices(c.env, ws, Date.now());
  const shown = m.role === "owner" ? services : services.map(({ baseUrl: _b, last4: _l, ...s }) => s);
  return c.json({ services: shown, secretKey: !!c.env.SECRET_KEY, workers: !!c.env.AI });
});

aiRoutes.post("/workspaces/:ws/ai-services", async c => {
  const ws = c.req.param("ws");
  await owner(c, ws);
  if (!c.env.SECRET_KEY) throw new HttpError(400, "Set the SECRET_KEY environment variable to store AI keys");
  const v = checked(c, await body<ServiceInput>(c), false);
  const n = await c.env.DB.prepare("SELECT count(*) n FROM workspace_ai WHERE workspace_id = ?").bind(ws).first<{ n: number }>();
  if ((n?.n ?? 0) >= AI_LIMITS.services) throw new HttpError(400, "A workspace can have at most 10 AI services");
  const id = newAiServiceId();
  await c.env.DB.prepare("INSERT INTO workspace_ai (id, workspace_id, name, kind, base_url, model, secret_enc, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ws, v.name, v.kind, v.baseUrl, v.model, await encryptSecret(c.env.SECRET_KEY, v.key), v.key.slice(-4), Date.now())
    .run();
  return c.json({ id });
});

aiRoutes.put("/workspaces/:ws/ai-services/:id", async c => {
  const ws = c.req.param("ws"), id = c.req.param("id");
  await owner(c, ws);
  if (!c.env.SECRET_KEY) throw new HttpError(400, "Set the SECRET_KEY environment variable to store AI keys");
  const existing = await c.env.DB.prepare("SELECT secret_enc, last4, kind, base_url FROM workspace_ai WHERE workspace_id = ? AND id = ?").bind(ws, id).first<{ secret_enc: string; last4: string; kind: string; base_url: string | null }>();
  if (!existing) throw new HttpError(404, "AI service not found");
  const v = checked(c, await body<ServiceInput>(c), true);
  if (!v.key && (v.kind !== existing.kind || (v.baseUrl ?? null) !== existing.base_url)) throw new HttpError(400, KEY_AGAIN);
  const enc = v.key ? await encryptSecret(c.env.SECRET_KEY, v.key) : existing.secret_enc;
  await c.env.DB.prepare("UPDATE workspace_ai SET name = ?, kind = ?, base_url = ?, model = ?, secret_enc = ?, last4 = ?, key_rejected_at = NULL, updated_at = ? WHERE id = ?")
    .bind(v.name, v.kind, v.baseUrl, v.model, enc, v.key ? v.key.slice(-4) : existing.last4, Date.now(), id)
    .run();
  // Bases of the workspace may hold entries waiting for this service.
  const { results } = await c.env.DB.prepare("SELECT id FROM bases WHERE workspace_id = ?").bind(ws).all<{ id: string }>();
  c.executionCtx.waitUntil(Promise.all(results.map(b => stubFor(c.env, b.id).aiWake().catch(() => undefined))));
  return c.json({ ok: true });
});

aiRoutes.delete("/workspaces/:ws/ai-services/:id", async c => {
  const ws = c.req.param("ws");
  await owner(c, ws);
  await c.env.DB.prepare("DELETE FROM workspace_ai WHERE workspace_id = ? AND id = ?").bind(ws, c.req.param("id")).run();
  // Bases cache services for a minute; they forget the deleted one now.
  const { results } = await c.env.DB.prepare("SELECT id FROM bases WHERE workspace_id = ?").bind(ws).all<{ id: string }>();
  c.executionCtx.waitUntil(Promise.all(results.map(b => stubFor(c.env, b.id).aiWake().catch(() => undefined))));
  return c.json({ ok: true });
});

aiRoutes.post("/workspaces/:ws/ai-services/test", async c => {
  const ws = c.req.param("ws");
  await owner(c, ws);
  const b = await body<ServiceInput & { id?: string }>(c);
  let svc: ModelService | null = null;
  if (b.id === WORKERS_SERVICE_ID) svc = await loadService(c.env, ws, WORKERS_SERVICE_ID);
  else {
    const saved = b.id ? await loadService(c.env, ws, b.id) : null;
    if (b.id && !saved) throw new HttpError(404, "AI service not found");
    const v = checked(c, { name: b.name ?? "Test", kind: b.kind ?? saved?.kind, baseUrl: b.baseUrl ?? saved?.baseUrl ?? undefined, model: b.model ?? saved?.model, key: b.key }, !!saved?.key);
    // A saved key only goes to the address it was saved for.
    if (saved && !v.key && (v.kind !== saved.kind || (v.baseUrl ?? null) !== (saved.baseUrl ?? null))) throw new HttpError(400, KEY_AGAIN);
    svc = { id: b.id ?? "test", kind: v.kind, baseUrl: v.baseUrl, model: v.model, key: v.key || saved?.key };
  }
  if (!svc) throw new HttpError(400, "Workers AI is not available on this server");
  try {
    const answer = await callModel(svc, { system: "Answer briefly.", prompt: "Reply with the word OK.", images: [] }, callDeps(c.env, 30_000));
    return c.json({ answer: answer.trim().slice(0, 200) });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});

aiRoutes.get("/bases/:base/ai-services", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const services = await listServices(c.env, a.base.workspace_id, Date.now());
  return c.json({ services: services.map(({ baseUrl: _b, last4: _l, ...s }) => s) });
});

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string; status?: number; limit?: LimitInfo }): T {
  if (!r.ok) throw failure(r, 400);
  return r.value;
}

aiRoutes.get("/bases/:base/tables/:table/ai/:field", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  return c.json(unwrap(await a.stub.aiStatus(c.req.param("table"), c.req.param("field"))));
});

aiRoutes.post("/bases/:base/tables/:table/ai/:field/generate", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<{ rowIds?: number[]; missingOnly?: boolean }>(c);
  return c.json(unwrap(await a.stub.aiGenerate(c.req.param("table"), c.req.param("field"), { rowIds: Array.isArray(b?.rowIds) ? b.rowIds : undefined, missingOnly: !!b?.missingOnly })));
});

aiRoutes.post("/bases/:base/tables/:table/ai/:field/stop", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  return c.json(unwrap(await a.stub.aiStop(c.req.param("field"))));
});

aiRoutes.post("/bases/:base/ai/preview", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<{ tableId: string; rowId: number; field: { type: FieldType; options: FieldOptions } }>(c);
  if (!b?.field || typeof b.tableId !== "string" || !Number.isInteger(b.rowId)) throw new HttpError(400, "Invalid request");
  return c.json(unwrap(await a.stub.aiPreview(b.tableId, b.rowId, b.field)));
});
