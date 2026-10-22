// Usage counted in D1 for plan limits (attachment bytes and monthly counters per workspace), and a workspace's usage against its plan.
import type { Env } from "./env";
import { stubFor } from "./access";
import { planFor, type LimitKey } from "./hosting";

export async function storageUsed(env: Env, workspaceId: string): Promise<number> {
  return (await env.DB.prepare("SELECT bytes FROM workspace_storage WHERE workspace_id = ?").bind(workspaceId).first<{ bytes: number }>())?.bytes ?? 0;
}

/** Counts an upload; uploaded_since keeps uploads made while a recount runs. */
export async function addUpload(env: Env, workspaceId: string, size: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO workspace_storage (workspace_id, bytes, uploaded_since) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET bytes = bytes + excluded.bytes, uploaded_since = uploaded_since + excluded.uploaded_since",
  )
    .bind(workspaceId, size, size)
    .run();
}

/**
 * Sets each workspace's bytes from its bases' files (see BaseStore.storageScan), so deleted files free space, and deletes
 * files from R2 that no cell has used for a week. Takes the workspaces not counted in the last 50 minutes, longest ago
 * first, `batch` at a time until none are left. A workspace that fails is logged and tried again next hour, after the others.
 * `afterCount` is a test seam.
 */
export async function recountStorage(env: Env, now: number, batch = 200, afterCount?: () => Promise<void>): Promise<void> {
  const done = new Set<string>();
  for (;;) {
    const { results } = await env.DB.prepare(
      "SELECT w.id, coalesce(s.uploaded_since, 0) since FROM workspaces w LEFT JOIN workspace_storage s ON s.workspace_id = w.id WHERE EXISTS (SELECT 1 FROM bases b WHERE b.workspace_id = w.id) AND coalesce(s.counted_at, 0) < ? ORDER BY coalesce(s.counted_at, 0) LIMIT ?",
    )
      .bind(now - 50 * 60_000, batch)
      .all<{ id: string; since: number }>();
    const todo = results.filter(ws => !done.has(ws.id));
    if (!todo.length) return;
    for (const ws of todo) {
      done.add(ws.id);
      try {
        await recountWorkspace(env, ws, now, afterCount);
      } catch (e) {
        console.error("storage recount failed", ws.id, e);
        // Counted as tried, so this workspace goes to the back of the queue instead of blocking it.
        await env.DB.prepare("INSERT INTO workspace_storage (workspace_id, counted_at) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET counted_at = excluded.counted_at")
          .bind(ws.id, now)
          .run()
          .catch(() => undefined);
      }
    }
  }
}

async function recountWorkspace(env: Env, ws: { id: string; since: number }, now: number, afterCount?: () => Promise<void>) {
  const { results: bases } = await env.DB.prepare("SELECT id FROM bases WHERE workspace_id = ?").bind(ws.id).all<{ id: string }>();
  let counted = 0;
  for (const b of bases) {
    const stub = stubFor(env, b.id);
    const scan = await stub.storageScan(now);
    counted += scan.bytes;
    if (scan.sweep.length) {
      await env.FILES.delete(scan.sweep);
      await stub.filesSwept(scan.sweep);
    }
  }
  await afterCount?.();
  // Uploads that arrived after `since` was read are not in `counted`; keep them.
  await env.DB.prepare(
    "INSERT INTO workspace_storage (workspace_id, bytes, uploaded_since, counted_at) VALUES (?, ?, 0, ?) ON CONFLICT(workspace_id) DO UPDATE SET bytes = max(0, ? + (uploaded_since - ?)), uploaded_since = uploaded_since - ?, counted_at = ?",
  )
    .bind(ws.id, counted, now, counted, ws.since, ws.since, now)
    .run();
}

export type UsageKind = "automationRuns";

export async function monthlyUsage(env: Env, workspaceId: string, kind: UsageKind, month: string): Promise<number> {
  return (await env.DB.prepare("SELECT n FROM workspace_usage WHERE workspace_id = ? AND kind = ? AND month = ?").bind(workspaceId, kind, month).first<{ n: number }>())?.n ?? 0;
}

/** Adds to a monthly counter and returns its new total. */
export async function addMonthlyUsage(env: Env, workspaceId: string, kind: UsageKind, month: string, n: number): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO workspace_usage (workspace_id, kind, month, n) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, kind, month) DO UPDATE SET n = n + excluded.n RETURNING n",
  )
    .bind(workspaceId, kind, month, n)
    .first<{ n: number }>();
  return row?.n ?? n;
}

export interface UsageItem {
  key: LimitKey;
  label: string;
  used: number;
  limit: number | null;
}

/** The workspace's plan and its usage against each limit, for the usage page, notices and a hosting's billing view. */
export async function workspaceUsage(env: Env, wsId: string): Promise<{ plan: { name: string; paid: boolean; upgradeUrl?: string }; usage: UsageItem[] }> {
  const plan = await planFor(env, wsId);
  const { limits } = plan;
  const now = Date.now();
  const month = new Date(now).toISOString().slice(0, 7);
  const { results: bases } = await env.DB.prepare("SELECT id FROM bases WHERE workspace_id = ?").bind(wsId).all<{ id: string }>();
  const summaries = await Promise.all(bases.map(b => stubFor(env, b.id).usageSummary()));
  const runs = limits.automationRuns;
  const perWorkspace = runs?.per === "workspace";
  const runsUsed = perWorkspace ? (await monthlyUsage(env, wsId, "automationRuns", month)) + summaries.reduce((n, s) => n + s.pendingRuns, 0) : Math.max(0, ...summaries.map(s => s.runs));
  const ai = await env.DB.prepare("SELECT n FROM ai_usage WHERE workspace_id = ? AND service_id = 'workers' AND month = ?").bind(wsId, month).first<{ n: number }>();
  const aiLimit = limits.workersAiCalls ?? (Number(env.AI_WORKERS_MONTHLY_CALLS || 0) || undefined);
  const lim = (n: number | undefined) => (n === undefined || n <= 0 ? null : n);
  return {
    plan: { name: plan.name, paid: plan.paid, ...(plan.upgradeUrl ? { upgradeUrl: plan.upgradeUrl } : {}) },
    usage: [
      { key: "bases", label: "Bases", used: bases.length, limit: lim(limits.bases) },
      { key: "records", label: "Records in the largest base", used: Math.max(0, ...summaries.map(s => s.records)), limit: lim(limits.recordsPerBase) },
      { key: "attachments", label: "Attachment storage", used: await storageUsed(env, wsId), limit: lim(limits.attachmentBytes) },
      { key: "automationRuns", label: perWorkspace ? "Automation runs this month" : "Automation runs this month in the busiest base", used: runsUsed, limit: lim(runs?.n) },
      { key: "workersAiCalls", label: "Workers AI calls this month", used: ai?.n ?? 0, limit: lim(aiLimit) },
    ],
  };
}
