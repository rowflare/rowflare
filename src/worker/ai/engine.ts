// Works through the AI queue from the base's alarm: at most 6 calls at once, about 25 seconds per alarm.
// An answer is written only if its queue entry was not replaced meanwhile, so edits made during a call win.
import type { BaseStore, MutationResult } from "../base/store";
import type { Attachment, Field, Row } from "../../shared/types";
import { AI_ACTOR, AI_LIMITS, aiDeps, expandPrompt, inputHash, parseAnswer, promptRefIds, systemInstruction } from "../../shared/ai";
import type { AiQueue, QueueEntry } from "./queue";
import { AiError, type ModelImage, type ModelRequest, type ModelService } from "./providers";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface AiHost {
  store: BaseStore;
  queue: AiQueue;
  service(id: string): Promise<(ModelService & { keyRejected: boolean }) | null>;
  call(s: ModelService, r: ModelRequest): Promise<string>;
  images(files: { key: string; type: string }[]): Promise<ModelImage[]>;
  canRun(): Promise<boolean>;
  workersLeft(): Promise<number>;
  /** Calls counted but not yet written; checked right before a call is counted, with no await between. */
  workersPending(): number;
  /** Counts one call; the DO writes the counts to D1 after the batch. */
  usage(serviceId: string): void;
  rejected(serviceId: string): Promise<void>;
  publish(results: MutationResult[]): void;
  /** Rows whose AI state changed (queue.touched) and the progress per field. */
  publishStates(): void;
}

export class AiEngine {
  private recovered = false;
  constructor(private h: AiHost) {}

  nextWake(): number | null {
    return this.h.queue.nextDue();
  }

  /** The request for one cell: system instruction, expanded prompt and images. */
  async request(f: Field, row: Row): Promise<{ req: ModelRequest; cut: boolean; hash: string }> {
    const ai = f.options.ai!;
    const { store } = this.h;
    const { text, cut } = expandPrompt(ai.prompt, id => (store.maybeField(id) ? store.displayText(f.tableId, row, id) : null));
    const files: { key: string; type: string }[] = [];
    for (const id of ai.imageFieldIds ?? []) for (const a of (row.cells[id] as Attachment[] | undefined) ?? []) if (IMAGE_TYPES.has(a.type) && a.size <= AI_LIMITS.imageBytes && files.length < AI_LIMITS.images) files.push({ key: a.key, type: a.type });
    const req: ModelRequest = { system: systemInstruction(f), prompt: text, images: [], model: ai.model };
    const hash = await inputHash({ system: req.system, prompt: text, model: ai.model ?? "", service: ai.serviceId, images: files.map(x => x.key) });
    req.images = files.length ? await this.h.images(files) : [];
    return { req, cut, hash };
  }

  /** True when the prompt names fields and all of them are empty, and there are no images. */
  private emptyInputs(f: Field, row: Row): boolean {
    const ai = f.options.ai!;
    const refs = promptRefIds(ai.prompt);
    if (!refs.length) return false;
    if ((ai.imageFieldIds ?? []).some(id => ((row.cells[id] as unknown[] | undefined) ?? []).length)) return false;
    return refs.every(id => !this.h.store.displayText(f.tableId, row, id).trim());
  }

  async drain(now: () => number = Date.now) {
    const { queue, store } = this.h;
    const start = now();
    if (!this.recovered) {
      // Calls cut off by an eviction count as a try.
      this.recovered = true;
      for (const r of store.all<{ table_id: string; field_id: string; row_id: number }>("SELECT table_id, field_id, row_id FROM _ai_cells WHERE state = 'running'")) {
        const e = queue.get(r.table_id, r.field_id, r.row_id);
        if (e && e.tries >= AI_LIMITS.retryDelays.length) {
          queue.setState(r.table_id, r.field_id, r.row_id, "error", `The call was cut off before it finished, ${e.tries + 1} times`);
          queue.drop(e);
          continue;
        }
        if (e) queue.postpone([e], start, x => x.tries + 1);
        queue.setState(r.table_id, r.field_id, r.row_id, e ? "queued" : "done");
      }
    }
    if (queue.nextDue() === null) return;
    if (!(await this.h.canRun())) {
      queue.postpone(queue.due(start, 100_000), start + AI_LIMITS.pause);
      return this.h.publishStates();
    }
    const busy = new Set<string>();
    const results: MutationResult[] = [];
    const running: Promise<void>[] = [];
    const key = (e: QueueEntry) => `${e.tableId}:${e.fieldId}:${e.rowId}`;
    while (now() - start < AI_LIMITS.alarmBudget) {
      const free = AI_LIMITS.concurrency - running.length;
      const next = free > 0 ? queue.due(now(), free + busy.size).filter(e => !busy.has(key(e))).slice(0, free) : [];
      if (!next.length && !running.length) break;
      for (const e of next) {
        busy.add(key(e));
        const p: Promise<void> = this.one(e, now, results).finally(() => {
          busy.delete(key(e));
          running.splice(running.indexOf(p), 1);
        });
        running.push(p);
      }
      if (running.length) await Promise.race(running);
      if (results.length) this.h.publish(results.splice(0));
      this.h.publishStates();
    }
    await Promise.all(running);
    if (results.length) this.h.publish(results);
    this.h.publishStates();
  }

  private async one(e: QueueEntry, now: () => number, results: MutationResult[]) {
    const { queue, store } = this.h;
    const f = store.maybeField(e.fieldId);
    if (!f?.options.ai || f.tableId !== e.tableId) return void queue.drop(e);
    if (store.aiBroken(f)) return queue.postpone([e], now() + AI_LIMITS.pause);
    const row = store.maybeTable(e.tableId) ? store.getRows(e.tableId, [e.rowId])[0] : undefined;
    if (!row) return void queue.drop(e);
    // Wait for AI cells this prompt reads, as long as they will take: a field that cannot run makes this one wait as long.
    let wait = 0;
    for (const id of promptRefIds(f.options.ai.prompt)) {
      if (!store.maybeField(id)?.options.ai || !["queued", "running"].includes(queue.state(e.tableId, id, e.rowId)?.state ?? "")) continue;
      const dep = queue.get(e.tableId, id, e.rowId);
      wait = Math.max(wait, now() + AI_LIMITS.debounce, dep ? dep.dueAt + AI_LIMITS.debounce : 0);
    }
    if (wait) return queue.postpone([e], wait);
    // Nothing to work from: a new blank record, or inputs that were cleared.
    if (this.emptyInputs(f, row)) {
      if (row.cells[f.id] !== undefined) results.push(store.updateRows(AI_ACTOR, e.tableId, [{ id: e.rowId, cells: { [f.id]: null } }]));
      queue.setState(e.tableId, e.fieldId, e.rowId, "done");
      return void queue.drop(e);
    }
    // Every await below lets other requests run: an edit, a stop or a new queue entry for this cell wins over this attempt.
    const current = () => queue.get(e.tableId, e.fieldId, e.rowId)?.seq === e.seq;
    const svc = await this.h.service(f.options.ai.serviceId);
    if (!current()) return;
    if (!svc || svc.keyRejected) return queue.postpone([e], now() + AI_LIMITS.pause);
    let built: { req: ModelRequest; cut: boolean; hash: string };
    try {
      built = await this.request(f, row);
    } catch (err) {
      if (!current()) return;
      queue.setState(e.tableId, e.fieldId, e.rowId, "error", `Could not read the images: ${err instanceof Error ? err.message : String(err)}`);
      return void queue.drop(e);
    }
    if (!current()) return;
    const prev = queue.state(e.tableId, e.fieldId, e.rowId);
    if (!e.manual && prev?.hash === built.hash && row.cells[f.id] !== undefined) {
      queue.setState(e.tableId, e.fieldId, e.rowId, "done");
      return void queue.drop(e);
    }
    if (svc.kind === "workers" && (await this.h.workersLeft()) - this.h.workersPending() <= 0) {
      if (!current()) return;
      queue.setState(e.tableId, e.fieldId, e.rowId, "error", "This month's Workers AI quota is used up");
      return void queue.drop(e);
    }
    if (!current()) return;
    queue.setState(e.tableId, e.fieldId, e.rowId, "running");
    this.h.publishStates();
    let answer: string;
    try {
      this.h.usage(svc.id);
      answer = await this.h.call(svc, built.req);
    } catch (err) {
      const ae = err instanceof AiError ? err : new AiError(err instanceof Error ? err.message : String(err), "retry");
      if (!queue.get(e.tableId, e.fieldId, e.rowId) || queue.get(e.tableId, e.fieldId, e.rowId)!.seq !== e.seq) return;
      if (ae.kind === "auth") {
        await this.h.rejected(svc.id);
        queue.setState(e.tableId, e.fieldId, e.rowId, "error", ae.message);
        queue.drop(e);
        const sameService = store.allFields().filter(x => x.options.ai?.serviceId === svc.id).map(x => x.id);
        queue.postpone(queue.due(Number.MAX_SAFE_INTEGER, 100_000).filter(x => sameService.includes(x.fieldId)), now() + AI_LIMITS.pause);
        return;
      }
      if (ae.kind === "retry" && e.tries < AI_LIMITS.retryDelays.length) {
        queue.setState(e.tableId, e.fieldId, e.rowId, "queued");
        return queue.postpone([e], now() + Math.max(AI_LIMITS.retryDelays[e.tries], ae.retryAfter ?? 0), x => x.tries + 1);
      }
      queue.setState(e.tableId, e.fieldId, e.rowId, "error", ae.message);
      return void queue.drop(e);
    }
    // The cell may have been edited, re-queued, stopped or deleted while the model was thinking.
    if (!current() || !store.maybeField(f.id)) return;
    const parsed = parseAnswer(f, answer);
    if (!parsed.ok) {
      queue.setState(e.tableId, e.fieldId, e.rowId, "error", parsed.error);
      return void queue.drop(e);
    }
    queue.drop(e);
    results.push(store.updateRows(AI_ACTOR, e.tableId, [{ id: e.rowId, cells: { [f.id]: parsed.value } }]));
    // A cut prompt still counts as done; the preview reports the cut.
    queue.setState(e.tableId, e.fieldId, e.rowId, "done", null, built.hash);
  }
}
