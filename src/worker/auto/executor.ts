// Executes one automation run: steps in order with templates filled from the trigger and earlier steps,
// record steps through the store, network steps through an injected Net. A run resumes after its last finished step.
import type { BaseStore, MutationResult } from "../base/store";
import type { Cells, FilterSpec } from "../../shared/types";
import { LIMITS, runLimit, type BranchOp, type Step, type StepLog, type StepOutput } from "../../shared/automations";
import { renderText, renderValue, type TemplateContext, type TemplateEnv } from "../../shared/template";
import type { RunRecord } from "./repo";
import { StepError, type Net } from "./types";

export interface RunOutcome {
  status: "succeeded" | "failed" | "waiting_retry";
  steps: StepLog[];
  error: string | null;
  nextAt: number | null;
  /** Row changes made by the run, for realtime clients. */
  results: MutationResult[];
  /** Whole outputs of steps whose log entry was cut, kept for a retry or a run again. */
  resume: Record<string, StepOutput>;
}

export interface ExecutorDeps {
  store: BaseStore;
  net: Net;
  /** Origin plus /base/<id>. */
  baseUrl: string;
  now: () => number;
  /** Called after every step with the log so far, so a run cut off by an eviction resumes after its last finished step. */
  onStep?: (steps: StepLog[], resume: Record<string, StepOutput>) => void;
}

const SECRET_HEADER = /authorization|cookie|key|token|secret/i;
const EMAIL = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Inputs are logged up to the output limit. */
function fit(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  return s.length <= LIMITS.outputBytes ? v : { truncated: true, preview: s.slice(0, LIMITS.outputBytes) };
}

/** HTTP bodies are logged up to 4 KB; the full body stays available to later steps of the same attempt. */
function logOutput(o: StepOutput): StepOutput {
  if (o.text !== undefined) return o.text.length <= LIMITS.httpBodyLog ? o : { ...o, text: o.text.slice(0, LIMITS.httpBodyLog) };
  if (o.body === undefined) return o;
  const s = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  return s.length <= LIMITS.httpBodyLog ? o : { ...o, body: s.slice(0, LIMITS.httpBodyLog) };
}

export function templateEnv(store: BaseStore): TemplateEnv {
  return {
    field: id => store.maybeField(id),
    table: id => store.maybeTable(id),
    rows: (tableId, ids) => (store.maybeTable(tableId) ? store.getRows(tableId, ids) : []),
    userName: id => store.memberName(id),
  };
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
}

/** Branch tests: text tests ignore case; order tests compare numbers when both sides are numbers, text otherwise. */
export function compareValues(op: BranchOp, left: { text: string; value?: unknown }, right: { text: string; value?: unknown }): boolean {
  const a = left.text.trim(), b = right.text.trim();
  const la = a.toLowerCase(), lb = b.toLowerCase();
  switch (op) {
    case "empty":
      return a === "";
    case "notempty":
      return a !== "";
    case "eq":
      return la === lb;
    case "neq":
      return la !== lb;
    case "contains":
      return la.includes(lb);
    case "ncontains":
      return !la.includes(lb);
    default: {
      const x = Number.isFinite(asNumber(left.value)) ? asNumber(left.value) : asNumber(a);
      const y = Number.isFinite(asNumber(right.value)) ? asNumber(right.value) : asNumber(b);
      const c = Number.isFinite(x) && Number.isFinite(y) ? x - y : a < b ? -1 : a > b ? 1 : 0;
      return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
    }
  }
}

export async function executeRun(run: RunRecord, d: ExecutorDeps): Promise<RunOutcome> {
  const { store } = d;
  const { name, config } = run.snapshot;
  const limit = runLimit(config);
  const deadline = d.now() + limit;
  const done = new Map(run.steps.filter(l => l.status === "ok").map(l => [l.id, l]));
  const outputs: Record<string, StepOutput> = {};
  const resume: Record<string, StepOutput> = {};
  for (const l of done.values()) {
    const whole = run.resume?.[l.id];
    if (whole) resume[l.id] = whole;
    if (whole ?? l.output) outputs[l.id] = (whole ?? l.output)!;
  }
  let resumeBytes = JSON.stringify(resume).length;
  const logs: StepLog[] = [];
  const results: MutationResult[] = [];
  const env = templateEnv(store);
  const actor = { userId: `auto:${run.automationId}`, name: `Automation: ${name}` };
  const writeCtx = { chain: run.chain, silent: run.test };
  const tr = run.trigger;

  const ctx = (): TemplateContext => {
    const row = tr.tableId && tr.recordId !== undefined && store.maybeTable(tr.tableId) ? store.getRows(tr.tableId, [tr.recordId])[0] : undefined;
    return { trigger: { record: row ? { tableId: tr.tableId!, row } : undefined, body: tr.body }, steps: outputs, now: d.now(), automationName: name, baseUrl: d.baseUrl };
  };
  const timeout = () => Math.max(1, Math.min(LIMITS.stepTimeout, deadline - d.now()));
  const aiTimeout = () => Math.max(1, Math.min(LIMITS.aiStepTimeout, deadline - d.now()));
  const write = (fn: () => MutationResult): MutationResult => {
    const r = store.withWriteContext(writeCtx, fn);
    results.push(r);
    return r;
  };
  const needTable = (id: string) => {
    if (!store.maybeTable(id)) throw new StepError("The table no longer exists");
  };
  const cellsFor = (tableId: string, values: Record<string, string>, c: TemplateContext) => {
    const cells: Cells = {};
    const shown: Record<string, unknown> = {};
    for (const [fid, tpl] of Object.entries(values)) {
      const f = store.maybeField(fid);
      if (!f || f.tableId !== tableId) throw new StepError(`The field ${fid} no longer exists`);
      const v = renderValue(tpl, c, env);
      cells[fid] = v === undefined || v === "" ? null : v;
      shown[f.name] = v ?? null;
    }
    return { cells, shown };
  };

  async function step(st: Step, setInput: (i: unknown) => void): Promise<StepOutput> {
    const c = ctx();
    switch (st.type) {
      case "createRecord": {
        needTable(st.tableId);
        const { cells, shown } = cellsFor(st.tableId, st.values, c);
        setInput({ values: shown });
        const r = write(() => store.createRows(actor, st.tableId, [{ cells }], { typecast: true }));
        return { records: { tableId: st.tableId, ids: r.created ?? [] }, count: r.created?.length ?? 0 };
      }
      case "updateRecords": {
        needTable(st.tableId);
        const src = st.target === "trigger" ? (tr.tableId === st.tableId && tr.recordId !== undefined ? [tr.recordId] : []) : outputs[st.target]?.records?.tableId === st.tableId ? outputs[st.target]!.records!.ids : [];
        const { cells, shown } = cellsFor(st.tableId, st.values, c);
        setInput({ records: src, values: shown });
        const ids = src.length ? store.getRows(st.tableId, src).map(r => r.id) : [];
        if (ids.length) write(() => store.updateRows(actor, st.tableId, ids.map(id => ({ id, cells })), { typecast: true }));
        return { records: { tableId: st.tableId, ids }, count: ids.length };
      }
      case "findRecords": {
        needTable(st.tableId);
        let blank = false;
        const conditions: FilterSpec | undefined = st.conditions && {
          ...st.conditions,
          conditions: st.conditions.conditions.map(cond => {
            if (typeof cond.value !== "string" || !cond.value.includes("{{")) return cond;
            const value = renderText(cond.value, c, env);
            if (!value.trim() && cond.op !== "empty" && cond.op !== "notempty") blank = true;
            return { ...cond, value };
          }),
        };
        setInput({ conditions: conditions?.conditions ?? [], limit: st.limit });
        // A condition whose template came out empty would be ignored by the filter and match every record.
        const ids = blank ? [] : store.query(st.tableId, { filters: conditions, sorts: st.sort, limit: 0 }).ids.slice(0, st.limit);
        return { records: { tableId: st.tableId, ids }, count: ids.length };
      }
      case "http": {
        const plain = { plainNumbers: true };
        const url = renderText(st.url, c, env, undefined, { ...plain, url: true }).trim();
        const headers = (st.headers ?? []).map(([k, v]) => [k.trim(), renderText(v, c, env, undefined, plain)] as [string, string]).filter(([k]) => k);
        // A JSON body gets its inserted text escaped, so a value with quotes cannot break or change the JSON.
        const json = st.body !== undefined && /^\s*[[{]/.test(st.body);
        const body = st.body !== undefined && st.method !== "GET" ? renderText(st.body, c, env, undefined, { ...plain, json }) : undefined;
        setInput({ method: st.method, url, headers: headers.map(([k, v]) => [k, SECRET_HEADER.test(k) ? "***" : v]), body: body?.slice(0, LIMITS.httpBodyLog) });
        const res = await d.net.http({ method: st.method, url, headers, body }, timeout());
        if (res.status >= 400) throw new StepError(`The server answered ${res.status}`, res.status >= 500 || res.status === 429, { status: res.status, body: res.body.slice(0, LIMITS.httpBodyLog) });
        let parsed: unknown = res.body;
        try {
          parsed = JSON.parse(res.body);
        } catch {
          // Plain text answers stay text.
        }
        return { status: res.status, body: parsed };
      }
      case "email": {
        const list = (tpl?: string) => (tpl ? renderText(tpl, c, env) : "").split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
        const to = list(st.to), cc = list(st.cc);
        const subject = renderText(st.subject, c, env).replace(/[\r\n]+/g, " ").slice(0, 300);
        const body = renderText(st.body, c, env, st.format === "html" ? escapeHtml : undefined);
        setInput({ provider: st.provider, to, cc, subject, body: body.slice(0, LIMITS.httpBodyLog) });
        if (!to.length) throw new StepError("The email has no recipients");
        if (to.length + cc.length > LIMITS.recipients) throw new StepError(`An email can have at most ${LIMITS.recipients} recipients`);
        const bad = [...to, ...cc].find(a => !EMAIL.test(a));
        if (bad) throw new StepError(`Invalid email address ${bad}`);
        const r = await d.net.email({ provider: st.provider, to, cc, subject, body, format: st.format }, timeout());
        return { messageId: r.messageId };
      }
      case "branch": {
        const side = (tpl: string) => ({ text: renderText(tpl, c, env), value: renderValue(tpl, c, env) });
        const checks = st.conditions.map(cond => {
          const l = side(cond.left), r = side(cond.right ?? "");
          return { left: l.text, op: cond.op, right: r.text, ok: compareValues(cond.op, l, r) };
        });
        setInput({ match: st.match, conditions: checks });
        return { matched: st.match === "all" ? checks.every(x => x.ok) : checks.some(x => x.ok) };
      }
      case "ai": {
        const prompt = renderText(st.prompt, c, env);
        const system = st.output === "json" ? "Answer with one JSON object only, without explanation." : "Answer with the result only, without preamble.";
        setInput({ serviceId: st.serviceId, model: st.model, prompt: prompt.slice(0, LIMITS.httpBodyLog) });
        const { text } = await d.net.ai({ serviceId: st.serviceId, model: st.model, system, prompt }, aiTimeout());
        if (st.output === "text") return { text: text.trim() };
        const m = /\{[\s\S]*\}/.exec(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        let json: unknown;
        try {
          json = m ? JSON.parse(m[0]) : undefined;
        } catch {
          json = undefined;
        }
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new StepError("The answer is not a JSON object", false, { text: text.slice(0, LIMITS.httpBodyLog) });
        return { json };
      }
      default:
        throw new StepError("Unknown step type");
    }
  }

  async function runAll(steps: Step[]): Promise<StepError | null> {
    for (const st of steps) {
      const prev = done.get(st.id);
      let out = prev?.output;
      if (prev) logs.push(prev);
      else {
        if (d.now() > deadline) return new StepError(`The run took longer than ${limit / 1000} seconds`);
        const t0 = d.now();
        let input: unknown;
        try {
          out = await step(st, i => (input = i));
          outputs[st.id] = out;
          if (logOutput(out) !== out) {
            const size = JSON.stringify(out).length;
            if (resumeBytes + size <= LIMITS.httpReadBytes) {
              resume[st.id] = out;
              resumeBytes += size;
            }
          }
          logs.push({ id: st.id, type: st.type, status: "ok", input: fit(input), output: logOutput(out), ms: d.now() - t0 });
        } catch (e) {
          const err = e instanceof StepError ? e : new StepError(e instanceof Error ? e.message : String(e));
          logs.push({ id: st.id, type: st.type, status: "error", input: fit(input), output: err.output, error: err.message, ms: d.now() - t0 });
          d.onStep?.(logs, resume);
          return err;
        }
        d.onStep?.(logs, resume);
      }
      if (st.type === "branch") {
        const e = await runAll(out?.matched ? st.then : st.else);
        if (e) return e;
      }
    }
    return null;
  }

  const err = await runAll(config.steps);
  if (!err) return { status: "succeeded", steps: logs, error: null, nextAt: null, results, resume };
  if (err.retry && !run.test && run.attempt < LIMITS.retryDelays.length) return { status: "waiting_retry", steps: logs, error: err.message, nextAt: d.now() + LIMITS.retryDelays[run.attempt], results, resume };
  return { status: "failed", steps: logs, error: err.message, nextAt: null, results, resume };
}
