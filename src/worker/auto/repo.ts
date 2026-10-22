// Automation definitions and runs, kept in the base's SQLite next to its tables.
import { generateKeyBetween } from "fractional-indexing";
import { UserError, type Actor, type BaseStore } from "../base/store";
import { LIMITS, RECORD_TRIGGERS, triggerTableId, validateAutomation, type Automation, type AutomationConfig, type AutomationOp, type AutomationRun, type ButtonInfo, type RunStatus, type StepLog, type StepOutput, type TriggerInfo } from "../../shared/automations";
import { templateProblem } from "../../shared/template";
import { newAutomationId, newWebhookToken } from "../../shared/ids";

interface AutoRow {
  id: string;
  name: string;
  ord: string;
  enabled: number;
  config: string;
  created_by: string | null;
  updated_by: string | null;
  updated_at: number | null;
  fail_streak: number;
  disabled_reason: string | null;
}

interface RunRow {
  id: number;
  automation_id: string;
  status: string;
  test: number;
  snapshot: string;
  trigger_info: string;
  chain: string;
  steps: string;
  error: string | null;
  attempt: number;
  next_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  resume: string | null;
}

export interface RunRecord extends AutomationRun {
  /** The definition when the run was queued; later edits do not change it. */
  snapshot: { name: string; config: AutomationConfig };
  /** Whole outputs of finished steps whose logged output was cut, so a resumed run sees them complete. */
  resume?: Record<string, StepOutput>;
}

export interface NewRun {
  automation: Automation;
  status: "queued" | "running" | "skipped";
  test?: boolean;
  trigger: TriggerInfo;
  chain: string[];
  error?: string;
  now: number;
}

export interface RunPatch {
  status?: RunStatus;
  steps?: StepLog[];
  error?: string | null;
  attempt?: number;
  nextAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  /** A new definition for the run (run again after the automation was fixed). */
  snapshot?: { name: string; config: AutomationConfig };
  resume?: Record<string, StepOutput> | null;
  trigger?: TriggerInfo;
}

/** next_at of an enabled timer with nothing ahead (a date trigger without future dates). */
export const NEVER = 8.64e15;
/** A run still marked running this long after it started was cut off (the object was evicted). */
export const STALE_MARGIN = 30_000;
/** The longest a run may take plus the margin (runs with an AI step); runs without one are cut off sooner. */
export const STALE_AFTER = LIMITS.aiRunTimeout + STALE_MARGIN;
const DAY = 86_400_000;
const FINISHED = "('succeeded', 'failed', 'skipped')";
/** Whether another run fits this month (an error message when not), and counting one that does. */
export interface RunQuota {
  check(now: number): string | null;
  take(now: number): void;
}

export const NO_QUOTA: RunQuota = { check: () => null, take: () => undefined };

/** The base's own monthly counter; n 0 means no limit. */
export function baseQuota(repo: AutomationRepo, n: number): RunQuota {
  return {
    check: now => (n > 0 && repo.usage(now) >= n ? `This base used its ${n.toLocaleString("en-US")} automation runs for this month` : null),
    take: () => undefined,
  };
}

const monthKey = (now: number) => "autoUsage:" + new Date(now).toISOString().slice(0, 7);
const cleanName = (name: unknown, fallback = "Automation") => String(name ?? "").trim().slice(0, 100) || fallback;

/** A run without its definition snapshot, for API answers. */
export function toPublic(run: RunRecord): AutomationRun {
  const { snapshot: _, resume: _r, ...rest } = run;
  return rest;
}

export class AutomationRepo {
  private list?: Automation[];
  /** Called after a definition changes or is switched on or off, to reset its timer. */
  onChange?: (id: string, now: number) => void;

  constructor(private store: BaseStore) {
    const sql = store.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS _automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord TEXT NOT NULL, enabled INTEGER NOT NULL, config TEXT NOT NULL, created_by TEXT, updated_by TEXT, updated_at INTEGER, fail_streak INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT, next_at INTEGER, watermark INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS _auto_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, automation_id TEXT NOT NULL, status TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL, trigger_info TEXT NOT NULL, chain TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', error TEXT, attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS _auto_runs_due ON _auto_runs (status, next_at)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS _auto_runs_by ON _auto_runs (automation_id, id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS _auto_runs_age ON _auto_runs (automation_id, status, created_at)`);
    if (!store.all<{ name: string }>("PRAGMA table_info(_auto_runs)").some(c => c.name === "resume")) sql.exec("ALTER TABLE _auto_runs ADD COLUMN resume TEXT");
  }

  // ---------- definitions ----------

  private toAutomation(r: AutoRow): Automation {
    return {
      id: r.id,
      name: r.name,
      ord: r.ord,
      enabled: !!r.enabled,
      config: JSON.parse(r.config),
      createdBy: r.created_by,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      failStreak: r.fail_streak,
      disabledReason: r.disabled_reason === "failures" ? "failures" : null,
    };
  }

  all(): Automation[] {
    if (!this.list) this.list = this.store.all<AutoRow>("SELECT id, name, ord, enabled, config, created_by, updated_by, updated_at, fail_streak, disabled_reason FROM _automations ORDER BY ord").map(r => this.toAutomation(r));
    return this.list;
  }

  get(id: string): Automation {
    const a = this.all().find(x => x.id === id);
    if (!a) throw new UserError("Automation not found");
    return a;
  }

  byToken(token: string): Automation | undefined {
    return this.all().find(a => a.config.trigger.type === "webhook" && a.config.trigger.token === token);
  }

  /** Enabled automations whose trigger watches records of this table. */
  anyEnabled(): boolean {
    return !!this.store.one("SELECT 1 x FROM _automations WHERE enabled = 1 LIMIT 1");
  }

  recordTriggers(tableId: string): Automation[] {
    return this.all().filter(a => a.enabled && RECORD_TRIGGERS.has(a.config.trigger.type) && triggerTableId(a.config.trigger) === tableId);
  }

  withLastRun(): Automation[] {
    const rows = this.store.all<{ automation_id: string; id: number; status: string; at: number }>(
      "SELECT automation_id, id, status, coalesce(finished_at, started_at, created_at) at FROM _auto_runs WHERE id IN (SELECT max(id) FROM _auto_runs WHERE test = 0 GROUP BY automation_id)",
    );
    const last = new Map(rows.map(r => [r.automation_id, r]));
    return this.all().map(a => {
      const r = last.get(a.id);
      return { ...a, lastRun: r ? { id: r.id, status: r.status as RunStatus, at: r.at } : null };
    });
  }

  buttons(): ButtonInfo[] {
    return this.all().flatMap(a => (a.config.trigger.type === "button" ? [{ id: a.id, name: a.name, tableId: a.config.trigger.tableId, viewerCanRun: a.config.trigger.viewerCanRun, enabled: a.enabled }] : []));
  }

  private checked(cfg: AutomationConfig): AutomationConfig {
    const s = this.store.schemaLike();
    const err = validateAutomation(cfg, s) ?? templateProblem(cfg, s);
    if (err) throw new UserError(err);
    return cfg;
  }

  /** Webhook tokens come from the server: a new one for a new webhook, the old one across edits. */
  private withToken(cfg: AutomationConfig, previous?: AutomationConfig): AutomationConfig {
    if (cfg?.trigger?.type !== "webhook") return cfg;
    const token = previous?.trigger.type === "webhook" ? previous.trigger.token : newWebhookToken();
    return { ...cfg, trigger: { type: "webhook", token } };
  }

  private changed(id: string, now: number) {
    this.list = undefined;
    this.onChange?.(id, now);
  }

  apply(actor: Actor, op: AutomationOp, now: number): { id?: string } {
    const sql = this.store.sql;
    switch (op?.op) {
      case "create": {
        if (this.all().length >= LIMITS.automations) throw new UserError(`A base holds at most ${LIMITS.automations} automations`);
        const config = this.checked(this.withToken(op.config));
        const id = newAutomationId();
        const ord = generateKeyBetween(this.all().at(-1)?.ord ?? null, null);
        sql.exec("INSERT INTO _automations (id, name, ord, enabled, config, created_by, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, cleanName(op.name), ord, op.enabled ? 1 : 0, JSON.stringify(config), actor.userId, actor.userId, now);
        this.changed(id, now);
        return { id };
      }
      case "update": {
        const a = this.get(op.id);
        const config = op.config ? this.checked(this.withToken(op.config, a.config)) : a.config;
        const name = op.name !== undefined ? cleanName(op.name, a.name) : a.name;
        const ord = op.ord !== undefined ? String(op.ord) : a.ord;
        sql.exec("UPDATE _automations SET name = ?, ord = ?, config = ?, updated_by = ?, updated_at = ? WHERE id = ?", name, ord, JSON.stringify(config), actor.userId, now, a.id);
        this.changed(a.id, now);
        return { id: a.id };
      }
      case "delete":
        this.get(op.id);
        sql.exec("DELETE FROM _automations WHERE id = ?", op.id);
        sql.exec("DELETE FROM _auto_runs WHERE automation_id = ?", op.id);
        this.list = undefined;
        return {};
      case "setEnabled": {
        const a = this.get(op.id);
        // The schema may have changed since the automation was saved.
        if (op.enabled) this.checked(a.config);
        const on = op.enabled ? 1 : 0;
        sql.exec(
          "UPDATE _automations SET enabled = ?, fail_streak = CASE WHEN ? = 1 THEN 0 ELSE fail_streak END, disabled_reason = CASE WHEN ? = 1 THEN NULL ELSE disabled_reason END, updated_by = ?, updated_at = ? WHERE id = ?",
          on, on, on, actor.userId, now, a.id,
        );
        this.changed(a.id, now);
        return { id: a.id };
      }
      case "regenerateWebhook": {
        const a = this.get(op.id);
        if (a.config.trigger.type !== "webhook") throw new UserError("This automation has no webhook");
        const config: AutomationConfig = { ...a.config, trigger: { type: "webhook", token: newWebhookToken() } };
        sql.exec("UPDATE _automations SET config = ?, updated_by = ?, updated_at = ? WHERE id = ?", JSON.stringify(config), actor.userId, now, a.id);
        this.list = undefined;
        return { id: a.id };
      }
      default:
        throw new UserError("Unknown automation operation");
    }
  }

  /** Counts failed runs in a row and switches the automation off at the limit. Returns true when it was switched off now. */
  recordOutcome(id: string, failed: boolean): boolean {
    const a = this.all().find(x => x.id === id);
    if (!a) return false;
    const streak = failed ? a.failStreak + 1 : 0;
    const disable = failed && a.enabled && streak >= LIMITS.failures;
    if (streak === a.failStreak && !disable) return false;
    this.store.sql.exec(
      "UPDATE _automations SET fail_streak = ?, enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END, disabled_reason = CASE WHEN ? = 1 THEN 'failures' ELSE disabled_reason END WHERE id = ?",
      streak, disable ? 1 : 0, disable ? 1 : 0, id,
    );
    this.list = undefined;
    return disable;
  }

  // ---------- timers (schedules and date triggers) ----------

  timers(): { automation: Automation; nextAt: number | null; watermark: number | null }[] {
    const rows = new Map(this.store.all<{ id: string; next_at: number | null; watermark: number | null }>("SELECT id, next_at, watermark FROM _automations WHERE enabled = 1").map(r => [r.id, r]));
    return this.all()
      .filter(a => a.enabled && rows.has(a.id) && (a.config.trigger.type === "schedule" || a.config.trigger.type === "dateReached"))
      .map(a => ({ automation: a, nextAt: rows.get(a.id)!.next_at, watermark: rows.get(a.id)!.watermark }));
  }

  setTimer(id: string, nextAt: number | null, watermark?: number | null) {
    if (watermark === undefined) this.store.sql.exec("UPDATE _automations SET next_at = ? WHERE id = ?", nextAt, id);
    else this.store.sql.exec("UPDATE _automations SET next_at = ?, watermark = ? WHERE id = ?", nextAt, watermark, id);
  }

  /** Earliest timer of an enabled schedule or date trigger; 0 when one has not been computed yet. */
  earliestTimer(): number | null {
    const r = this.store.one<{ t: number | null }>(
      "SELECT min(coalesce(next_at, 0)) t FROM _automations WHERE enabled = 1 AND json_extract(config, '$.trigger.type') IN ('schedule', 'dateReached') AND coalesce(next_at, 0) < ?",
      NEVER,
    );
    return r?.t ?? null;
  }

  // ---------- runs ----------

  private toRun(r: RunRow): RunRecord {
    return {
      id: r.id,
      automationId: r.automation_id,
      status: r.status as RunStatus,
      test: !!r.test,
      trigger: JSON.parse(r.trigger_info),
      chain: JSON.parse(r.chain),
      steps: JSON.parse(r.steps),
      error: r.error,
      attempt: r.attempt,
      nextAt: r.next_at,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      snapshot: JSON.parse(r.snapshot),
      resume: r.resume ? JSON.parse(r.resume) : undefined,
    };
  }

  /** Records a run; `prune` false leaves pruning to the caller (a write that queues many runs prunes once). */
  insertRun(r: NewRun, prune = true): number {
    const id = this.store.one<{ id: number }>(
      "INSERT INTO _auto_runs (automation_id, status, test, snapshot, trigger_info, chain, error, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      r.automation.id, r.status, r.test ? 1 : 0, JSON.stringify({ name: r.automation.name, config: r.automation.config }), JSON.stringify(r.trigger), JSON.stringify(r.chain),
      r.error ?? null, r.now, r.status === "running" ? r.now : null, r.status === "skipped" ? r.now : null,
    )!.id;
    if (prune) this.prune(r.automation.id, r.now);
    return id;
  }

  /** Queues a run, or records a skipped one when the quota says the month's runs are used up. The base counts every queued run. */
  enqueue(a: Automation, trigger: TriggerInfo, chain: string[], now: number, quota: RunQuota, prune = true): number {
    const error = quota.check(now);
    if (error) return this.insertRun({ automation: a, status: "skipped", trigger, chain, error, now }, prune);
    this.store.setMeta(monthKey(now), String(this.usage(now) + 1));
    quota.take(now);
    return this.insertRun({ automation: a, status: "queued", trigger, chain, now }, prune);
  }

  /** Finished runs older than 30 days or past the newest 1,000 of an automation are deleted; pending runs stay. */
  prune(automationId: string, now: number) {
    this.store.sql.exec(`DELETE FROM _auto_runs WHERE automation_id = ? AND status IN ${FINISHED} AND created_at < ?`, automationId, now - LIMITS.runDays * DAY);
    const cut = this.store.one<{ id: number }>(`SELECT id FROM _auto_runs WHERE automation_id = ? AND status IN ${FINISHED} ORDER BY id DESC LIMIT 1 OFFSET ?`, automationId, LIMITS.runsKept);
    if (cut) this.store.sql.exec(`DELETE FROM _auto_runs WHERE automation_id = ? AND status IN ${FINISHED} AND id <= ?`, automationId, cut.id);
  }

  getRun(id: number): RunRecord | undefined {
    const r = this.store.one<RunRow>("SELECT * FROM _auto_runs WHERE id = ?", id);
    return r ? this.toRun(r) : undefined;
  }

  runs(automationId: string, q: { status?: string; before?: number; limit: number }): AutomationRun[] {
    const where = ["automation_id = ?"];
    const params: unknown[] = [automationId];
    if (q.status) { where.push("status = ?"); params.push(q.status); }
    if (q.before) { where.push("id < ?"); params.push(q.before); }
    return this.store.all<RunRow>(`SELECT * FROM _auto_runs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...params, q.limit).map(r => toPublic(this.toRun(r)));
  }

  saveRun(id: number, p: RunPatch) {
    const cols: [string, unknown][] = [];
    if (p.status !== undefined) cols.push(["status", p.status]);
    if (p.steps !== undefined) cols.push(["steps", JSON.stringify(p.steps)]);
    if (p.error !== undefined) cols.push(["error", p.error]);
    if (p.attempt !== undefined) cols.push(["attempt", p.attempt]);
    if (p.nextAt !== undefined) cols.push(["next_at", p.nextAt]);
    if (p.startedAt !== undefined) cols.push(["started_at", p.startedAt]);
    if (p.finishedAt !== undefined) cols.push(["finished_at", p.finishedAt]);
    if (p.snapshot !== undefined) cols.push(["snapshot", JSON.stringify(p.snapshot)]);
    if (p.trigger !== undefined) cols.push(["trigger_info", JSON.stringify(p.trigger)]);
    if (p.resume !== undefined) cols.push(["resume", p.resume && Object.keys(p.resume).length ? JSON.stringify(p.resume) : null]);
    if (!cols.length) return;
    this.store.sql.exec(`UPDATE _auto_runs SET ${cols.map(([c]) => c + " = ?").join(", ")} WHERE id = ?`, ...(cols.map(([, v]) => v) as SqlStorageValue[]), id);
  }

  dueRuns(now: number, limit: number): number[] {
    return this.store.all<{ id: number }>("SELECT id FROM _auto_runs WHERE status = 'queued' OR (status = 'waiting_retry' AND next_at <= ?) ORDER BY id LIMIT ?", now, limit).map(r => r.id);
  }

  /** Runs marked running since before `before` (cut off by an eviction). Test runs answer a request and are not resumed. */
  stale(before: number): number[] {
    return this.store.all<{ id: number }>("SELECT id FROM _auto_runs WHERE status = 'running' AND test = 0 AND started_at < ?", before).map(r => r.id);
  }

  /** Test runs answer a request, so one cut off by an eviction is closed as failed instead of resumed. */
  closeStaleTests(before: number, now: number) {
    this.store.sql.exec("UPDATE _auto_runs SET status = 'failed', error = 'The test run was cut off before it finished', finished_at = ? WHERE status = 'running' AND test = 1 AND started_at < ?", now, before);
  }

  /** When pending runs need the alarm: now for queued ones, their retry time, or when a running one counts as cut off. */
  nextRunAt(): number | null {
    const r = this.store.one<{ t: number | null }>(
      "SELECT min(CASE status WHEN 'queued' THEN 0 WHEN 'waiting_retry' THEN next_at ELSE started_at + ? END) t FROM _auto_runs WHERE status IN ('queued', 'waiting_retry') OR (status = 'running' AND test = 0)",
      STALE_AFTER,
    );
    return r?.t ?? null;
  }

  usage(now: number): number {
    return Number(this.store.meta(monthKey(now)) ?? "0");
  }
}
