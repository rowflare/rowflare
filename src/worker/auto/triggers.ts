// Finds the record triggers a write fires and queues their runs, inside the write's transaction.
import type { BaseStore, WriteInfo, WrittenRow } from "../base/store";
import { LIMITS, type Automation } from "../../shared/automations";
import type { AutomationRepo, RunQuota } from "./repo";

/** Record ids of `rows` that fire this automation's trigger. */
function firing(store: BaseStore, a: Automation, rows: WrittenRow[]): number[] {
  const t = a.config.trigger;
  if (t.type === "recordCreated") return store.matchRows(t.tableId, t.conditions, rows.filter(r => r.isNew).map(r => r.id));
  if (t.type === "recordUpdated") {
    const watch = t.fieldIds?.length ? new Set(t.fieldIds) : null;
    const ids = rows.filter(r => !r.isNew && (watch ? [...r.changed].some(f => watch.has(f)) : r.changed.size > 0)).map(r => r.id);
    return store.matchRows(t.tableId, t.conditions, ids);
  }
  if (t.type === "recordMatches") {
    const now = store.matchRows(t.tableId, t.conditions, rows.map(r => r.id));
    const nowSet = new Set(now);
    const earlier = rows.filter(r => r.before && nowSet.has(r.id)).map(r => ({ id: r.id, ...r.before! }));
    const before = new Set(store.matchSnapshots(t.tableId, t.conditions, earlier));
    return now.filter(id => !before.has(id));
  }
  return [];
}

/** Queues a run per fired trigger and record. A broken automation is skipped, never the write. */
export function detectTriggers(store: BaseStore, repo: AutomationRepo, w: WriteInfo, now: number, quota: RunQuota): number {
  let queued = 0;
  const byTable = new Map<string, WrittenRow[]>();
  for (const r of w.rows) byTable.set(r.tableId, [...(byTable.get(r.tableId) ?? []), r]);
  for (const [tableId, rows] of byTable) {
    for (const a of repo.recordTriggers(tableId)) {
      if (w.chain.length >= LIMITS.chain || w.chain.includes(a.id)) continue;
      let ids: number[];
      try {
        ids = firing(store, a, rows);
      } catch (e) {
        console.error("automation trigger check failed", a.id, e);
        continue;
      }
      for (const id of ids) {
        repo.enqueue(a, { type: a.config.trigger.type, tableId, recordId: id, at: now, by: w.actor.userId }, [...w.chain, a.id], now, quota, false);
        queued++;
      }
      // Pruning scans the automation's run history, so a paste of many rows prunes once, not once per run.
      if (ids.length) repo.prune(a.id, now);
    }
  }
  return queued;
}
