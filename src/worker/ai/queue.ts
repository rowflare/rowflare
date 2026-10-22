// The AI cell queue and cell states, in the base's SQLite next to its tables.
// Writes queue cells inside their own transaction; the engine takes due entries from here.
import { UserError, type BaseStore, type WriteInfo } from "../base/store";
import { isSafeId } from "../../shared/ids";
import { AI_ACTOR, AI_LIMITS, aiDeps, type AiCellState, type AiCellStateName, type AiProgress } from "../../shared/ai";

export interface QueueEntry {
  tableId: string;
  fieldId: string;
  rowId: number;
  dueAt: number;
  tries: number;
  seq: number;
  manual: boolean;
}

interface EntryRow {
  table_id: string;
  field_id: string;
  row_id: number;
  due_at: number;
  tries: number;
  seq: number;
  manual: number;
}

const toEntry = (r: EntryRow): QueueEntry => ({ tableId: r.table_id, fieldId: r.field_id, rowId: r.row_id, dueAt: r.due_at, tries: r.tries, seq: r.seq, manual: !!r.manual });

export class AiQueue {
  private seq: number;
  /** Rows whose state changed since the engine last published them, by table. */
  readonly touched = new Map<string, Set<number>>();
  /** Tables whose clients should reload instead of receiving every row (whole-column requests). */
  readonly reload = new Set<string>();

  constructor(private store: BaseStore) {
    const sql = store.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS _ai_cells (table_id TEXT NOT NULL, field_id TEXT NOT NULL, row_id INTEGER NOT NULL, state TEXT NOT NULL, error TEXT, input_hash TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (table_id, field_id, row_id))");
    sql.exec("CREATE TABLE IF NOT EXISTS _ai_queue (table_id TEXT NOT NULL, field_id TEXT NOT NULL, row_id INTEGER NOT NULL, due_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, manual INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (table_id, field_id, row_id))");
    sql.exec("CREATE INDEX IF NOT EXISTS _ai_queue_due ON _ai_queue (due_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS _ai_queue_field ON _ai_queue (field_id, seq)");
    sql.exec("CREATE TABLE IF NOT EXISTS _ai_batches (field_id TEXT PRIMARY KEY, table_id TEXT NOT NULL, total INTEGER NOT NULL, done INTEGER NOT NULL)");
    this.seq = store.one<{ s: number | null }>("SELECT max(seq) s FROM _ai_queue")?.s ?? 0;
  }

  private touch(tableId: string, rowId: number) {
    let s = this.touched.get(tableId);
    if (!s) this.touched.set(tableId, (s = new Set()));
    s.add(rowId);
  }

  /** Called by the store inside each write's transaction. */
  onWrite(w: WriteInfo, now: number) {
    const { store } = this;
    for (const d of w.deleted) this.forgetRows(d.tableId, d.ids);
    if (w.bulk) return;
    const byAi = w.actor.userId === AI_ACTOR.userId;
    const byTable = new Map<string, typeof w.rows>();
    for (const r of w.rows) byTable.set(r.tableId, [...(byTable.get(r.tableId) ?? []), r]);
    for (const [tableId, rows] of byTable) {
      const fields = store.aiFields(tableId);
      if (!fields.length) continue;
      for (const f of fields) {
        const deps = aiDeps(f);
        const auto = f.options.ai!.autoUpdate !== false && !store.aiBroken(f);
        const queue: number[] = [];
        for (const r of rows) {
          if (r.changed.has(f.id) && !byAi) {
            this.markEdited(tableId, f.id, r.id, now);
            continue;
          }
          if (!auto) continue;
          if (!(r.isNew || deps.some(d => r.changed.has(d)))) continue;
          if (this.state(tableId, f.id, r.id)?.state === "edited") continue;
          queue.push(r.id);
        }
        if (queue.length) this.enqueue(tableId, f.id, queue, now + AI_LIMITS.debounce, false);
      }
    }
  }

  private markEdited(tableId: string, fieldId: string, rowId: number, now: number) {
    const had = this.store.one("SELECT 1 x FROM _ai_queue WHERE table_id = ? AND field_id = ? AND row_id = ?", tableId, fieldId, rowId);
    this.store.sql.exec("DELETE FROM _ai_queue WHERE table_id = ? AND field_id = ? AND row_id = ?", tableId, fieldId, rowId);
    if (had) this.retire(fieldId, 1);
    this.store.sql.exec("INSERT INTO _ai_cells (table_id, field_id, row_id, state, error, input_hash, updated_at) VALUES (?, ?, ?, 'edited', NULL, NULL, ?) ON CONFLICT(table_id, field_id, row_id) DO UPDATE SET state = 'edited', error = NULL, updated_at = excluded.updated_at", tableId, fieldId, rowId, now);
    this.touch(tableId, rowId);
  }

  /** Queues cells (or moves their due time); returns how many were not queued before. */
  enqueue(tableId: string, fieldId: string, rowIds: number[], due: number, manual: boolean): number {
    const sql = this.store.sql;
    let added = 0;
    for (const id of rowIds) {
      const had = this.store.one("SELECT 1 x FROM _ai_queue WHERE table_id = ? AND field_id = ? AND row_id = ?", tableId, fieldId, id);
      sql.exec(
        "INSERT INTO _ai_queue (table_id, field_id, row_id, due_at, tries, seq, manual) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(table_id, field_id, row_id) DO UPDATE SET due_at = excluded.due_at, tries = 0, seq = excluded.seq, manual = max(manual, excluded.manual)",
        tableId, fieldId, id, due, ++this.seq, manual ? 1 : 0,
      );
      sql.exec("INSERT INTO _ai_cells (table_id, field_id, row_id, state, error, input_hash, updated_at) VALUES (?, ?, ?, 'queued', NULL, NULL, ?) ON CONFLICT(table_id, field_id, row_id) DO UPDATE SET state = 'queued', error = NULL, updated_at = excluded.updated_at", tableId, fieldId, id, Date.now());
      if (!had) added++;
      this.touch(tableId, id);
    }
    if (added) this.grow(tableId, fieldId, added);
    return added;
  }

  private grow(tableId: string, fieldId: string, n: number) {
    this.store.sql.exec("INSERT INTO _ai_batches (field_id, table_id, total, done) VALUES (?, ?, ?, 0) ON CONFLICT(field_id) DO UPDATE SET total = total + excluded.total", fieldId, tableId, n);
  }

  /** The whole column, or the rows never generated and still empty; one statement, so 100,000 rows take well under a second. */
  enqueueColumn(tableId: string, fieldId: string, missingOnly: boolean, now: number): number {
    if (!isSafeId(fieldId)) throw new UserError("Field not found");
    const t = this.store.table(tableId);
    const sql = this.store.sql;
    const before = this.store.one<{ n: number }>("SELECT count(*) n FROM _ai_queue WHERE field_id = ?", fieldId)!.n;
    const where = missingOnly ? `WHERE json_extract(data, '$.${fieldId}') IS NULL AND id NOT IN (SELECT row_id FROM _ai_cells WHERE table_id = ? AND field_id = ?)` : "WHERE ? IS NOT NULL AND ? IS NOT NULL";
    const seq0 = this.seq;
    sql.exec(
      `INSERT INTO _ai_queue (table_id, field_id, row_id, due_at, tries, seq, manual) SELECT ?, ?, id, ?, 0, ? + id, 1 FROM ${t.phys} ${where} ON CONFLICT(table_id, field_id, row_id) DO UPDATE SET due_at = excluded.due_at, tries = 0, seq = excluded.seq, manual = 1`,
      tableId, fieldId, now, seq0, tableId, fieldId,
    );
    this.seq = this.store.one<{ s: number | null }>("SELECT max(seq) s FROM _ai_queue")?.s ?? this.seq;
    sql.exec(
      "INSERT INTO _ai_cells (table_id, field_id, row_id, state, error, input_hash, updated_at) SELECT table_id, field_id, row_id, 'queued', NULL, NULL, ? FROM _ai_queue WHERE field_id = ? AND seq > ? ON CONFLICT(table_id, field_id, row_id) DO UPDATE SET state = 'queued', error = NULL, updated_at = excluded.updated_at",
      now, fieldId, seq0,
    );
    this.reload.add(tableId);
    const after = this.store.one<{ n: number }>("SELECT count(*) n FROM _ai_queue WHERE field_id = ?", fieldId)!.n;
    const queued = this.store.one<{ n: number }>("SELECT count(*) n FROM _ai_queue WHERE field_id = ? AND seq > ?", fieldId, seq0)!.n;
    if (after > before) this.grow(tableId, fieldId, after - before);
    this.store.sql.exec("UPDATE _ai_batches SET total = max(total, ?) WHERE field_id = ?", after, fieldId);
    return queued;
  }

  stop(fieldId: string) {
    const sql = this.store.sql;
    for (const r of this.store.all<{ table_id: string }>("SELECT DISTINCT table_id FROM _ai_queue WHERE field_id = ?", fieldId)) this.reload.add(r.table_id);
    sql.exec("DELETE FROM _ai_queue WHERE field_id = ?", fieldId);
    sql.exec("UPDATE _ai_cells SET state = 'done' WHERE field_id = ? AND state IN ('queued', 'running') AND input_hash IS NOT NULL", fieldId);
    sql.exec("DELETE FROM _ai_cells WHERE field_id = ? AND state IN ('queued', 'running')", fieldId);
    sql.exec("DELETE FROM _ai_batches WHERE field_id = ?", fieldId);
  }

  /** Makes a field's waiting entries due now (not its retries, which keep their tries and back off again if they fail). */
  resume(fieldId: string, now: number) {
    this.store.sql.exec("UPDATE _ai_queue SET due_at = ? WHERE field_id = ? AND due_at > ? AND tries = 0", now, fieldId, now + AI_LIMITS.debounce);
  }

  due(now: number, limit: number): QueueEntry[] {
    return this.store.all<EntryRow>("SELECT * FROM _ai_queue WHERE due_at <= ? ORDER BY due_at, seq LIMIT ?", now, limit).map(toEntry);
  }

  nextDue(): number | null {
    return this.store.one<{ t: number | null }>("SELECT min(due_at) t FROM _ai_queue")?.t ?? null;
  }

  get(tableId: string, fieldId: string, rowId: number): QueueEntry | undefined {
    const r = this.store.one<EntryRow>("SELECT * FROM _ai_queue WHERE table_id = ? AND field_id = ? AND row_id = ?", tableId, fieldId, rowId);
    return r && toEntry(r);
  }

  postpone(entries: QueueEntry[], until: number, tries?: (e: QueueEntry) => number) {
    for (const e of entries) this.store.sql.exec("UPDATE _ai_queue SET due_at = ?, tries = ? WHERE table_id = ? AND field_id = ? AND row_id = ? AND seq = ?", until, tries ? tries(e) : e.tries, e.tableId, e.fieldId, e.rowId, e.seq);
  }

  /** Removes an entry if it was not replaced since it was read, and counts it as done for the field's progress. */
  drop(e: QueueEntry) {
    const sql = this.store.sql;
    const gone = this.store.one<{ n: number }>("SELECT count(*) n FROM _ai_queue WHERE table_id = ? AND field_id = ? AND row_id = ? AND seq = ?", e.tableId, e.fieldId, e.rowId, e.seq)!.n;
    if (!gone) return;
    sql.exec("DELETE FROM _ai_queue WHERE table_id = ? AND field_id = ? AND row_id = ?", e.tableId, e.fieldId, e.rowId);
    sql.exec("UPDATE _ai_batches SET done = done + 1 WHERE field_id = ?", e.fieldId);
    if (!this.store.one("SELECT 1 x FROM _ai_queue WHERE field_id = ? LIMIT 1", e.fieldId)) sql.exec("DELETE FROM _ai_batches WHERE field_id = ?", e.fieldId);
  }

  setState(tableId: string, fieldId: string, rowId: number, state: AiCellStateName | "done", error: string | null = null, hash?: string) {
    this.store.sql.exec(
      "INSERT INTO _ai_cells (table_id, field_id, row_id, state, error, input_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(table_id, field_id, row_id) DO UPDATE SET state = excluded.state, error = excluded.error, input_hash = coalesce(excluded.input_hash, input_hash), updated_at = excluded.updated_at",
      tableId, fieldId, rowId, state, error, hash ?? null, Date.now(),
    );
    this.touch(tableId, rowId);
  }

  state(tableId: string, fieldId: string, rowId: number): { state: string; hash: string | null } | undefined {
    const r = this.store.one<{ state: string; input_hash: string | null }>("SELECT state, input_hash FROM _ai_cells WHERE table_id = ? AND field_id = ? AND row_id = ?", tableId, fieldId, rowId);
    return r && { state: r.state, hash: r.input_hash };
  }

  states(tableId: string, ids: number[]): Map<number, Record<string, AiCellState>> {
    const out = new Map<number, Record<string, AiCellState>>();
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const rows = this.store.all<{ row_id: number; field_id: string; state: string; error: string | null }>(
        `SELECT row_id, field_id, state, error FROM _ai_cells WHERE table_id = ? AND state <> 'done' AND row_id IN (${chunk.map(() => "?").join(",")})`,
        tableId, ...chunk,
      );
      for (const r of rows) {
        const m = out.get(r.row_id) ?? {};
        m[r.field_id] = r.error ? { s: r.state as AiCellStateName, e: r.error } : { s: r.state as AiCellStateName };
        out.set(r.row_id, m);
      }
    }
    return out;
  }

  progress(): AiProgress[] {
    return this.store
      .all<{ field_id: string; table_id: string; total: number; done: number; queued: number }>("SELECT b.field_id, b.table_id, b.total, b.done, (SELECT count(*) FROM _ai_queue q WHERE q.field_id = b.field_id) queued FROM _ai_batches b ORDER BY b.field_id")
      .map(r => ({ tableId: r.table_id, fieldId: r.field_id, queued: r.queued, done: r.done, total: r.total }));
  }

  status(tableId: string, fieldId: string) {
    if (!isSafeId(fieldId)) throw new UserError("Field not found");
    const p = this.progress().find(x => x.fieldId === fieldId);
    const errors = this.store.all<{ row_id: number; error: string }>("SELECT row_id, error FROM _ai_cells WHERE table_id = ? AND field_id = ? AND state = 'error' ORDER BY row_id LIMIT 100", tableId, fieldId).map(r => ({ rowId: r.row_id, error: r.error }));
    const t = this.store.table(tableId);
    const missing = this.store.one<{ n: number }>(`SELECT count(*) n FROM ${t.phys} WHERE json_extract(data, '$.${fieldId}') IS NULL AND id NOT IN (SELECT row_id FROM _ai_cells WHERE table_id = ? AND field_id = ?)`, tableId, fieldId)!.n;
    return { queued: p?.queued ?? 0, done: p?.done ?? 0, total: p?.total ?? 0, errors, missing };
  }

  /** Entries that left the queue without an answer still end the field's progress. */
  private retire(fieldId: string, n: number) {
    this.store.sql.exec("UPDATE _ai_batches SET done = done + ? WHERE field_id = ?", n, fieldId);
    if (!this.store.one("SELECT 1 x FROM _ai_queue WHERE field_id = ? LIMIT 1", fieldId)) this.store.sql.exec("DELETE FROM _ai_batches WHERE field_id = ?", fieldId);
  }

  private forgetRows(tableId: string, ids: number[]) {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const q = chunk.map(() => "?").join(",");
      for (const r of this.store.all<{ field_id: string; n: number }>(`SELECT field_id, count(*) n FROM _ai_queue WHERE table_id = ? AND row_id IN (${q}) GROUP BY field_id`, tableId, ...chunk)) {
        this.store.sql.exec(`DELETE FROM _ai_queue WHERE table_id = ? AND field_id = ? AND row_id IN (${q})`, tableId, r.field_id, ...chunk);
        this.retire(r.field_id, r.n);
      }
      this.store.sql.exec(`DELETE FROM _ai_queue WHERE table_id = ? AND row_id IN (${q})`, tableId, ...chunk);
      this.store.sql.exec(`DELETE FROM _ai_cells WHERE table_id = ? AND row_id IN (${q})`, tableId, ...chunk);
    }
  }

  /** Drops state of fields that are gone or no longer AI fields (after schema changes). */
  prune() {
    const live = new Set(this.store.allFields().filter(f => f.options.ai).map(f => f.id));
    for (const { field_id } of this.store.all<{ field_id: string }>("SELECT DISTINCT field_id FROM _ai_cells UNION SELECT DISTINCT field_id FROM _ai_queue")) {
      if (live.has(field_id)) continue;
      this.store.sql.exec("DELETE FROM _ai_queue WHERE field_id = ?", field_id);
      this.store.sql.exec("DELETE FROM _ai_cells WHERE field_id = ?", field_id);
      this.store.sql.exec("DELETE FROM _ai_batches WHERE field_id = ?", field_id);
    }
  }
}
