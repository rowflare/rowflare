// Workspace AI services and usage in D1. Keys are decrypted only inside the Worker, right before a call.
import type { Env } from "../env";
import { decryptSecret } from "../secrets";
import { AI_LIMITS, WORKERS_SERVICE_ID, WORKERS_TEXT_MODEL, type AiServiceInfo, type AiServiceKind } from "../../shared/ai";
import type { AiDeps, ModelService } from "./providers";

interface Row {
  id: string;
  name: string;
  kind: AiServiceKind;
  base_url: string | null;
  model: string;
  secret_enc: string | null;
  last4: string | null;
  key_rejected_at: number | null;
}

export const monthKey = (now: number) => new Date(now).toISOString().slice(0, 7);

async function usage(env: Env, ws: string, now: number): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare("SELECT service_id, n FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(ws, monthKey(now)).all<{ service_id: string; n: number }>();
  return new Map(results.map(r => [r.service_id, r.n]));
}

export async function listServices(env: Env, ws: string, now: number): Promise<AiServiceInfo[]> {
  const { results } = await env.DB.prepare("SELECT id, name, kind, base_url, model, last4, key_rejected_at FROM workspace_ai WHERE workspace_id = ? ORDER BY name").bind(ws).all<Row>();
  const used = await usage(env, ws, now);
  const out: AiServiceInfo[] = env.AI ? [{ id: WORKERS_SERVICE_ID, name: "Workers AI", kind: "workers", model: WORKERS_TEXT_MODEL, keyRejected: false, calls: used.get(WORKERS_SERVICE_ID) ?? 0 }] : [];
  for (const r of results) out.push({ id: r.id, name: r.name, kind: r.kind, model: r.model, baseUrl: r.base_url, last4: r.last4, keyRejected: !!r.key_rejected_at, calls: used.get(r.id) ?? 0 });
  return out;
}

export async function loadService(env: Env, ws: string, id: string): Promise<(ModelService & { keyRejected: boolean }) | null> {
  if (id === WORKERS_SERVICE_ID) return env.AI ? { id, kind: "workers", model: WORKERS_TEXT_MODEL, keyRejected: false } : null;
  const r = await env.DB.prepare("SELECT id, name, kind, base_url, model, secret_enc, last4, key_rejected_at FROM workspace_ai WHERE workspace_id = ? AND id = ?").bind(ws, id).first<Row>();
  if (!r) return null;
  const key = r.secret_enc && env.SECRET_KEY ? await decryptSecret(env.SECRET_KEY, r.secret_enc) : undefined;
  return { id: r.id, kind: r.kind, baseUrl: r.base_url, model: r.model, key, keyRejected: !!r.key_rejected_at };
}

export async function addUsage(env: Env, ws: string, counts: Map<string, number>, now: number): Promise<void> {
  const month = monthKey(now);
  const stmts = [...counts].filter(([, n]) => n > 0).map(([id, n]) => env.DB.prepare("INSERT INTO ai_usage (workspace_id, service_id, month, n) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, service_id, month) DO UPDATE SET n = n + excluded.n").bind(ws, id, month, n));
  if (stmts.length) await env.DB.batch(stmts);
}

/** Workers AI calls left this month: `limit` comes from the plan, otherwise from AI_WORKERS_MONTHLY_CALLS; none or 0 means no limit. */
export async function workersLeft(env: Env, ws: string, now: number, limit = Number(env.AI_WORKERS_MONTHLY_CALLS || 0)): Promise<number> {
  if (!Number.isFinite(limit) || limit <= 0) return Infinity;
  const used = (await usage(env, ws, now)).get(WORKERS_SERVICE_ID) ?? 0;
  return Math.max(0, limit - used);
}

export async function markRejected(env: Env, ws: string, id: string): Promise<void> {
  await env.DB.prepare("UPDATE workspace_ai SET key_rejected_at = ? WHERE workspace_id = ? AND id = ?").bind(Date.now(), ws, id).run();
}

export function callDeps(env: Env, timeoutMs: number = AI_LIMITS.callTimeout): AiDeps {
  return { ai: env.AI, allowPrivate: env.AUTOMATION_ALLOW_PRIVATE === "true", timeoutMs };
}
