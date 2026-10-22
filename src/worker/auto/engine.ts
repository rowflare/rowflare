// Runs automations from the base's alarm: due schedules and date triggers become runs,
// queued runs and retries execute within a time budget, and runs cut off by an eviction resume.
import type { BaseStore, MutationResult, WrittenRow } from "../base/store";
import { LIMITS, runLimit, type DateTrigger } from "../../shared/automations";
import { dateDue, dueDayWindow, nextScheduleTime } from "../../shared/schedule";
import { NEVER, STALE_AFTER, STALE_MARGIN, type AutomationRepo, type RunQuota, type RunRecord } from "./repo";
import { executeRun } from "./executor";
import type { Net } from "./types";

const DATE_PAGE = 1000;
/** Up to 125,000 rows per check, the most a base is meant to hold. */
const MAX_DATE_PAGES = 125;

export interface EngineHost {
  store: BaseStore;
  repo: AutomationRepo;
  net(): Net;
  baseUrl(): string;
  quota(): RunQuota;
  /** Row changes made by runs, for realtime clients. */
  publish(results: MutationResult[]): void;
  /** An automation was switched off after repeated failures. */
  automationsChanged(): void;
  /** False while the workspace is paused; runs are skipped then. */
  canRun(): Promise<boolean>;
}

export class AutomationEngine {
  constructor(private h: EngineHost) {}

  /** Recomputes an automation's timer after it was created, edited, or switched on or off. */
  resetTimer(id: string, now: number) {
    const a = this.h.repo.all().find(x => x.id === id);
    const t = a?.config.trigger;
    if (!a || !a.enabled || !t || (t.type !== "schedule" && t.type !== "dateReached")) return this.h.repo.setTimer(id, null, null);
    if (t.type === "schedule") return this.h.repo.setTimer(id, nextScheduleTime(t, now), null);
    this.h.repo.setTimer(id, this.nextDue(t, now) ?? NEVER, now);
  }

  /** A write changed date cells: bring the next check forward when one of them falls due sooner. */
  touchDates(tableId: string, rows: WrittenRow[]) {
    for (const { automation: a, nextAt, watermark } of this.h.repo.timers()) {
      const t = a.config.trigger;
      if (t.type !== "dateReached" || t.tableId !== tableId) continue;
      const ids = rows.filter(r => r.isNew || r.changed.has(t.fieldId)).map(r => r.id);
      if (!ids.length) continue;
      const current = nextAt ?? NEVER;
      let best = current;
      for (const r of this.h.store.getRows(tableId, ids)) {
        const due = dateDue(r.cells[t.fieldId], t);
        if (due !== null && due > (watermark ?? 0) && due < best) best = due;
      }
      if (best !== current) this.h.repo.setTimer(a.id, best);
    }
  }

  /** Rows of a date trigger's field in a day window, page by page in cell order. */
  private *dates(t: DateTrigger, from: string, to: string | null): Generator<{ id: number; value: string }> {
    let last: { value: string; id: number } | undefined;
    for (let page = 0; page < MAX_DATE_PAGES; page++) {
      const rows = this.h.store.dateValues(t.tableId, t.fieldId, from, to, DATE_PAGE, last);
      yield* rows;
      if (rows.length < DATE_PAGE) return;
      last = rows[rows.length - 1];
    }
  }

  private nextDue(t: DateTrigger, after: number): number | null {
    if (!this.h.store.maybeField(t.fieldId)) return null;
    const [from] = dueDayWindow(after, after, t.offsetMinutes);
    let best: number | null = null;
    // Cells come in date order, so the search stops a few days past the first future one; dates that already passed are skipped.
    let stopDay: string | null = null;
    for (const v of this.dates(t, from, null)) {
      if (stopDay !== null && v.value.slice(0, 10) > stopDay) break;
      const due = dateDue(v.value, t);
      if (due !== null && due > after && (best === null || due < best)) {
        best = due;
        stopDay = dueDayWindow(due, due, t.offsetMinutes)[1];
      }
    }
    return best;
  }

  /** Schedules and date triggers that are due become queued runs. */
  enqueueDue(now: number) {
    const { repo, store } = this.h;
    const limit = this.h.quota();
    for (const { automation: a, nextAt, watermark } of repo.timers()) {
      const t = a.config.trigger;
      if (t.type !== "schedule" && t.type !== "dateReached") continue;
      if (nextAt === null) {
        this.resetTimer(a.id, now);
        continue;
      }
      if (nextAt > now) continue;
      if (t.type === "schedule") {
        // A missed time (the object was not running) runs once, not once per missed slot.
        repo.enqueue(a, { type: "schedule", at: now }, [a.id], now, limit);
        repo.setTimer(a.id, nextScheduleTime(t, now), null);
        continue;
      }
      const from = watermark ?? now;
      if (store.maybeField(t.fieldId)) {
        const [lo, hi] = dueDayWindow(from, now, t.offsetMinutes);
        const due: number[] = [];
        for (const v of this.dates(t, lo, hi)) {
          const at = dateDue(v.value, t);
          if (at !== null && at > from && at <= now) due.push(v.id);
        }
        for (const id of store.matchRows(t.tableId, t.conditions, due)) repo.enqueue(a, { type: "dateReached", tableId: t.tableId, recordId: id, at: now }, [a.id], now, limit);
      }
      repo.setTimer(a.id, this.nextDue(t, now) ?? NEVER, now);
    }
  }

  /** When the alarm must next fire for automations, or null. */
  nextWake(): number | null {
    const times = [this.h.repo.nextRunAt(), this.h.repo.earliestTimer()].filter((x): x is number => x !== null);
    return times.length ? Math.min(...times) : null;
  }

  /** Executes due runs for about LIMITS.alarmBudget ms; the rest wait for the next alarm. */
  async drain(now: () => number = Date.now) {
    const start = now();
    // Each run is cut off after its own limit (longer with an AI step), plus a margin.
    for (const id of this.h.repo.stale(start - LIMITS.runTimeout - STALE_MARGIN)) {
      const run = this.h.repo.getRun(id);
      if (run && run.startedAt !== null && run.startedAt < start - runLimit(run.snapshot.config) - STALE_MARGIN) this.resumeCutOff(id, start);
    }
    this.h.repo.closeStaleTests(start - STALE_AFTER, start);
    while (now() - start < LIMITS.alarmBudget) {
      const [id] = this.h.repo.dueRuns(now(), 1);
      if (id === undefined) break;
      await this.execute(id, now);
    }
  }

  /** A run cut off by an eviction counts as a try, so a step that always brings the object down cannot retry forever. */
  private resumeCutOff(id: number, now: number) {
    const { repo } = this.h;
    const run = repo.getRun(id);
    if (!run) return;
    if (run.attempt < LIMITS.retryDelays.length) return repo.saveRun(id, { status: "waiting_retry", attempt: run.attempt + 1, nextAt: now });
    repo.saveRun(id, { status: "failed", error: `The run was cut off before it finished, ${run.attempt + 1} times`, finishedAt: now });
    if (repo.recordOutcome(run.automationId, true)) this.h.automationsChanged();
  }

  /** Runs one run to its end or its next retry and records the outcome. */
  async execute(id: number, now: () => number = Date.now): Promise<RunRecord> {
    const { repo } = this.h;
    const run = repo.getRun(id)!;
    // Taken by another drain meanwhile (a button run and the alarm can reach the same run).
    if (!run.test && run.status !== "queued" && run.status !== "waiting_retry") return run;
    if (!run.test && !repo.all().find(a => a.id === run.automationId)?.enabled) {
      repo.saveRun(id, { status: "skipped", error: "The automation was turned off", finishedAt: now() });
      return repo.getRun(id)!;
    }
    // Claimed before the pause check awaits, so another drain running at the same time skips this run.
    repo.saveRun(id, { status: "running", startedAt: now() });
    if (!run.test && !(await this.h.canRun())) {
      repo.saveRun(id, { status: "skipped", error: "Automations are paused for this workspace", finishedAt: now() });
      return repo.getRun(id)!;
    }
    const out = await executeRun(run, { store: this.h.store, net: this.h.net(), baseUrl: this.h.baseUrl(), now, onStep: (steps, resume) => repo.saveRun(id, { steps, resume }) });
    const retry = out.status === "waiting_retry";
    // Failed runs keep whole outputs too, for "Run again".
    repo.saveRun(id, { status: out.status, steps: out.steps, error: out.error, nextAt: out.nextAt, attempt: retry ? run.attempt + 1 : run.attempt, finishedAt: retry ? null : now(), resume: out.status === "succeeded" ? null : out.resume });
    // A webhook body is kept whole while the run may still need it; a succeeded run keeps a short copy, so history stays small.
    const body = run.trigger.body;
    if (out.status === "succeeded" && body !== undefined) {
      const text = JSON.stringify(body);
      if (text.length > LIMITS.outputBytes) repo.saveRun(id, { trigger: { ...run.trigger, body: { truncated: true, preview: text.slice(0, LIMITS.outputBytes) } } });
    }
    if (out.results.length) this.h.publish(out.results);
    if (!run.test && !retry && repo.recordOutcome(run.automationId, out.status === "failed")) this.h.automationsChanged();
    return repo.getRun(id)!;
  }
}
