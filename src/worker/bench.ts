// Performance regression harness that reproduces the 2026-10-12 Durable Object load test on the real engine.
// Enabled only when BENCH_TOKEN is set. Timing happens here in the Worker around stub calls, minus a
// no-op baseline, because clocks inside a Durable Object do not advance during synchronous SQL.
import type { AiQueue } from "./ai/queue";
import { Hono } from "hono";
import type { Env } from "./env";
import type { BaseStore, Actor } from "./base/store";
import { defaultChoices } from "./base/store";
import type { LinkValue } from "../shared/types";
import type { AggregateInput } from "./base/aggregate";
import { NO_QUOTA, type AutomationRepo } from "./auto/repo";
import type { AutomationEngine } from "./auto/engine";

const ACTOR: Actor = { userId: "bench", name: "Bench" };
const STATUSES = ["Todo", "In progress", "Blocked", "Review", "Done", "Archived"];
const TAGS = Array.from({ length: 20 }, (_, i) => "tag" + i);
const WORDS = ("alpha beta gamma delta epsilon zeta theta iota kappa lambda omicron sigma tau upsilon phi chi psi omega " +
  "invoice client vendor shipment review budget launch design sprint backlog meeting report contract renewal " +
  "marketing sales support onboarding migration audit roadmap feedback hiring payroll quarterly forecast").split(" ");

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BenchIds {
  tasks: string;
  projects: string;
  f: Record<string, string>;
}

function ids(store: BaseStore): BenchIds {
  const raw = store.meta("bench");
  if (!raw) throw new Error("Bench base not set up");
  return JSON.parse(raw);
}

function setup(store: BaseStore, nprojects: number): BenchIds {
  if (store.meta("bench")) return ids(store);
  store.init("bench");
  const projects = store.createTable(ACTOR, { name: "Projects", fields: [{ name: "Name", type: "text" }, { name: "Owner", type: "text" }] }).tableId;
  const tasks = store.createTable(ACTOR, {
    name: "Tasks",
    fields: [
      { name: "Name", type: "text" },
      { name: "Status", type: "singleSelect", options: { choices: defaultChoices(STATUSES) } },
      { name: "Priority", type: "number" },
      { name: "Amount", type: "number", options: { precision: 2 } },
      { name: "Due", type: "date" },
      { name: "Tags", type: "multiSelect", options: { choices: defaultChoices(TAGS) } },
      { name: "Owner", type: "text" },
      { name: "Description", type: "longText" },
      { name: "Done", type: "checkbox" },
      { name: "Email", type: "email" },
      { name: "Score", type: "number" },
      { name: "Started", type: "date", options: { includeTime: true } },
    ],
  }).tableId;
  const link = store.createField(tasks, { name: "Project", type: "link", options: { linkedTableId: projects } }).fieldId;
  const byName = (t: string) => Object.fromEntries(store.fieldsOf(t).map(f => [f.name, f.id]));
  const pf = byName(projects);
  const rows = Array.from({ length: nprojects }, (_, i) => {
    const r = rng(i + 1);
    return { cells: { [pf.Name]: `Project ${i + 1} ${sentence(r, 2)}`, [pf.Owner]: "user" + Math.floor(r() * 50) } };
  });
  for (let i = 0; i < rows.length; i += 1000) store.createRows(ACTOR, projects, rows.slice(i, i + 1000));
  const out: BenchIds = { tasks, projects, f: { ...byName(tasks), Project: link, PName: pf.Name } };
  store.setMeta("bench", JSON.stringify(out));
  return out;
}

const pick = <T>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)];
const sentence = (r: () => number, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(" ");

function seed(store: BaseStore, n: number, offset: number, nprojects: number) {
  const b = setup(store, nprojects);
  const r = rng(1000 + offset);
  const projectIds = store.query(b.projects, { limit: 0 }).ids;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const k = offset + i;
    const amount = Math.round(r() * 1000000) / 100;
    rows.push({
      cells: {
        [b.f.Name]: "Task " + k + " " + sentence(r, 4),
        [b.f.Status]: pick(r, STATUSES),
        [b.f.Priority]: 1 + Math.floor(r() * 5),
        [b.f.Amount]: amount,
        [b.f.Due]: new Date(Date.UTC(2025, 0, 1) + Math.floor(r() * 730) * 86400000).toISOString().slice(0, 10),
        [b.f.Tags]: Array.from({ length: Math.floor(r() * 4) }, () => pick(r, TAGS)),
        [b.f.Owner]: "user" + Math.floor(r() * 50),
        [b.f.Description]: sentence(r, 55),
        [b.f.Done]: r() < 0.3,
        [b.f.Email]: "person" + k + "@example.com",
        [b.f.Score]: Math.round(r() * 4000) / 10,
        [b.f.Started]: new Date(Date.UTC(2024, 0, 1) + Math.floor(r() * 600) * 86400000).toISOString(),
        [b.f.Project]: [projectIds[Math.floor(r() * projectIds.length)]],
      },
    });
  }
  for (let i = 0; i < rows.length; i += 1000) store.createRows(ACTOR, b.tasks, rows.slice(i, i + 1000), { typecast: true });
  return { tasks: store.rowCount(b.tasks) };
}

/** Adds the computed fields used by the load test: lookup of project name, rollups, and a formula. */
function finalize(store: BaseStore) {
  const b = ids(store);
  if (b.f.Lookup) return stats(store);
  b.f.Lookup = store.createField(b.tasks, { name: "Project name", type: "lookup", options: { linkFieldId: b.f.Project, targetFieldId: b.f.PName } }).fieldId;
  b.f.Formula = store.createField(b.tasks, { name: "Weighted", type: "formula", options: { formula: `ROUND({Amount} * {Priority}, 2)` } }).fieldId;
  const inverse = store.field(b.f.Project).options.inverseFieldId!;
  const amount = b.f.Amount;
  b.f.Sum = store.createField(b.projects, { name: "Total amount", type: "rollup", options: { linkFieldId: inverse, targetFieldId: amount, fn: "sum" } }).fieldId;
  b.f.Count = store.createField(b.projects, { name: "Task count", type: "rollup", options: { linkFieldId: inverse, targetFieldId: b.f.Name, fn: "countall" } }).fieldId;
  store.setMeta("bench", JSON.stringify(b));
  drain(store);
  return stats(store);
}

function drain(store: BaseStore) {
  let guard = 0;
  while (store.hasJobs() && guard++ < 100000) store.runJobStep();
}

function stats(store: BaseStore) {
  const b = ids(store);
  const t = store.table(b.tasks);
  return {
    tasks: store.rowCount(b.tasks),
    projects: store.rowCount(b.projects),
    avg_row_bytes: Math.round(store.one<{ a: number }>(`SELECT avg(length(data)) a FROM ${t.phys}`)!.a),
    db_bytes: store.storage.sql.databaseSize,
    pending_jobs: store.jobs().length,
  };
}

export interface BenchAutomations {
  repo: AutomationRepo;
  engine: AutomationEngine;
  ai?: AiQueue;
}

const AI_NAMES = ["bench ai summary", "bench ai label"];

/** Two auto-updating AI fields on Tasks (queueing cost); their service does not exist, so nothing is called. */
function aiOn(store: BaseStore): number {
  const b = ids(store);
  if (store.fieldsOf(b.tasks).some(x => x.name === AI_NAMES[0])) return 0;
  store.createField(b.tasks, { name: AI_NAMES[0], type: "longText", options: { ai: { serviceId: "bench", prompt: `Summarize {${b.f.Name}}`, autoUpdate: true } } });
  store.createField(b.tasks, { name: AI_NAMES[1], type: "text", options: { ai: { serviceId: "bench", prompt: `Label for {${b.f.Name}} with amount {${b.f.Amount}}`, autoUpdate: true } } });
  return 2;
}

function aiOff(store: BaseStore, queue?: AiQueue): number {
  const b = ids(store);
  let n = 0;
  for (const f of store.fieldsOf(b.tasks).filter(x => AI_NAMES.includes(x.name))) {
    store.deleteField(f.id);
    n++;
  }
  queue?.prune();
  return n;
}

const AUTO_NAMES = ["bench updated", "bench matches", "bench created", "bench drain"];

/** Three record triggers on Tasks (detection cost) and a button automation for timing execution. */
function autoOn(store: BaseStore, auto: BenchAutomations): number {
  const b = ids(store);
  const f = b.f;
  if (auto.repo.all().some(a => a.name === AUTO_NAMES[0])) return 0;
  const done = store.field(f.Status).options.choices!.find(c => c.name === "Done")!.id;
  const make = (name: string, config: import("../shared/automations").AutomationConfig) => auto.repo.apply(ACTOR, { op: "create", name, config, enabled: true }, Date.now());
  make(AUTO_NAMES[0], { trigger: { type: "recordUpdated", tableId: b.tasks, fieldIds: [f.Amount], conditions: { conjunction: "and", conditions: [{ fieldId: f.Score, op: "gt", value: 50 }] } }, steps: [] });
  make(AUTO_NAMES[1], { trigger: { type: "recordMatches", tableId: b.tasks, conditions: { conjunction: "and", conditions: [{ fieldId: f.Status, op: "eq", value: done }] } }, steps: [] });
  make(AUTO_NAMES[2], { trigger: { type: "recordCreated", tableId: b.tasks }, steps: [] });
  make(AUTO_NAMES[3], { trigger: { type: "button", tableId: b.tasks, viewerCanRun: false }, steps: [{ id: "s1", type: "updateRecords", target: "trigger", tableId: b.tasks, values: { [f.Score]: `{{trigger.record.${f.Priority}}}` } }] });
  return 4;
}

function autoOff(auto: BenchAutomations): number {
  let n = 0;
  for (const a of auto.repo.all().filter(a => AUTO_NAMES.includes(a.name))) {
    auto.repo.apply(ACTOR, { op: "delete", id: a.id }, Date.now());
    n++;
  }
  return n;
}

export async function benchCommand(store: BaseStore, cmd: string, args: Record<string, number>, auto?: BenchAutomations): Promise<unknown> {
  switch (cmd) {
    case "seed":
      return seed(store, args.n, args.offset, args.nprojects);
    case "finalize":
      return finalize(store);
    case "stats":
      return stats(store);
    case "auto_on":
      return autoOn(store, auto!);
    case "auto_off":
      return autoOff(auto!);
    case "ai_on":
      return aiOn(store);
    case "ai_off":
      return aiOff(store, auto?.ai);
    case "op": {
      let out: unknown;
      for (let i = 0; i < Math.max(1, args.reps); i++) out = await op(store, args.name as unknown as string, (args.salt ?? 0) + i, auto);
      return out;
    }
  }
  throw new Error("unknown bench command");
}

function op(store: BaseStore, name: string, i: number, auto?: BenchAutomations): unknown {
  if (name === "noop") return 0;
  const b = ids(store);
  const f = b.f;
  const done = store.field(f.Status).options.choices!.find(c => c.name === "Done")!.id;
  const open = store.field(f.Status).options.choices!.filter(c => c.name === "Todo" || c.name === "In progress").map(c => c.id);
  const page = (q: Parameters<BaseStore["query"]>[1]) => {
    const r = store.query(b.tasks, { ...q, limit: 100 });
    return { count: r.ids.length, page: r.rows.length };
  };
  switch (name) {
    case "first_page": {
      const r = store.query(b.tasks, { limit: 100, idsLimit: 300 });
      return { total: r.total, page: r.rows.length };
    }
    case "all_ids":
      return page({});
    case "filter":
      return page({ filters: { conjunction: "and", conditions: [{ fieldId: f.Status, op: "eq", value: done }, { fieldId: f.Amount, op: "gt", value: 5000 }] } });
    case "sort":
      return page({ sorts: [{ fieldId: f.Score, dir: "desc" }] });
    case "filter_sort":
      return page({
        filters: { conjunction: "and", conditions: [{ fieldId: f.Status, op: "anyOf", value: open }, { fieldId: f.Done, op: "eq", value: false }] },
        sorts: [{ fieldId: f.Score, dir: "desc" }],
      });
    case "search":
      return page({ search: "quarterly forecast" });
    case "group":
      return store.query(b.tasks, { groupFieldId: f.Status, limit: 0 }).groups!.length;
    case "aggregate":
      // Measure computing the groups, not the result cache.
      store.clearAggCache();
      return store.aggregate(b.tasks, { groupBy: [{ fieldId: f.Status }], metrics: [{ fn: "count", as: "n" }, { fn: "sum", fieldId: f.Amount, as: "s" }] }).groups.length;
    case "calendar_month":
      return store.query(b.tasks, { range: { startFieldId: f.Due, from: "2025-06-30", to: "2025-08-10" }, limit: 2000 }).ids.length;
    case "group_two_sum": {
      const levels = [{ fieldId: f.Status, dir: "asc" as const }, { fieldId: f.Done, dir: "asc" as const }];
      store.clearAggCache();
      const q = store.query(b.tasks, { groupLevels: levels, limit: 0 });
      const metrics = [{ fn: "sum" as const, fieldId: f.Amount, as: "s" }];
      const s1 = store.aggregate(b.tasks, { groupBy: [{ fieldId: f.Status }], fanOut: false, metrics });
      const s2 = store.aggregate(b.tasks, { groupBy: [{ fieldId: f.Status }, { fieldId: f.Done }], fanOut: false, metrics });
      return q.ids.length + s1.groups.length + s2.groups.length;
    }
    case "dashboard_8":
    case "dashboard_8_cached": {
      // Eight widgets of a typical dashboard; the first variant starts with an empty cache.
      if (name === "dashboard_8") store.clearAggCache();
      const count = [{ fn: "count" as const, as: "v" }];
      const sum = [{ fn: "sum" as const, fieldId: f.Amount, as: "v" }];
      const qs: AggregateInput[] = [
        { metrics: count },
        { metrics: sum },
        { metrics: count, filters: { conjunction: "and", conditions: [{ fieldId: f.Status, op: "eq", value: done }] } },
        { metrics: sum, groupBy: [{ fieldId: f.Status }] },
        { metrics: count, groupBy: [{ fieldId: f.Due, bucket: "month" }], sort: "key" },
        { metrics: sum, groupBy: [{ fieldId: f.Status }, { fieldId: f.Done }], sort: "key" },
        { metrics: count, groupBy: [{ fieldId: f.Status }], limit: 3, other: true },
        { metrics: [{ fn: "avg", fieldId: f.Amount, as: "v" }], range: { fieldId: f.Due, from: "2025-01-01", to: "2025-12-31" } },
      ];
      return qs.reduce((n, q) => n + store.aggregate(b.tasks, q).groups.length, 0);
    }
    case "edit_cell_rollup": {
      const t = store.table(b.tasks);
      const n = store.rowCount(b.tasks);
      const id = store.one<{ id: number }>(`SELECT id FROM ${t.phys} LIMIT 1 OFFSET ?`, (i * 7919) % n)!.id;
      const row = store.getRow(b.tasks, id)!;
      const res = store.updateRows(ACTOR, b.tasks, [{ id, cells: { [f.Amount]: Math.round(((row.cells[f.Amount] as number) + 1) * 100) / 100 } }]);
      return res.changes.reduce((n, c) => n + c.rows.length, 0);
    }
    case "rename_project_lookup": {
      const t = store.table(b.projects);
      const pid = store.one<{ id: number }>(`SELECT id FROM ${t.phys} LIMIT 1 OFFSET ?`, (i * 104729) % store.rowCount(b.projects))!.id;
      const res = store.updateRows(ACTOR, b.projects, [{ id: pid, cells: { [f.PName]: `Project ${pid} renamed ${i}` } }]);
      return res.changes.reduce((n, c) => n + c.rows.length, 0);
    }
    case "rollup_full":
      store.enqueueJob("recompute", "bench", { tableId: b.projects, fieldIds: [f.Sum, f.Count], cursor: 0 }, store.rowCount(b.projects));
      drain(store);
      return store.rowCount(b.projects);
    case "formula_full":
      store.enqueueJob("recompute", "bench", { tableId: b.tasks, fieldIds: [f.Formula], cursor: 0 }, store.rowCount(b.tasks));
      drain(store);
      return store.rowCount(b.tasks);
    case "formula_batch":
      // One alarm-sized slice of a column recompute: what other users wait behind.
      store.enqueueJob("recompute", "bench", { tableId: b.tasks, fieldIds: [f.Formula], cursor: (i * 500) % store.rowCount(b.tasks) }, 500);
      store.runJobStep();
      store.sql.exec("DELETE FROM _jobs WHERE label = 'bench'");
      return 500;
    case "link_titles": {
      const row = store.getRows(b.tasks, store.query(b.tasks, { limit: 1 }).ids)[0];
      return (row.cells[f.Project] as LinkValue[])?.[0]?.t ?? null;
    }
    case "paste_1000": {
      // A 1,000-row paste and its removal; with record triggers on, it queues 1,000 runs.
      const res = store.createRows(ACTOR, b.tasks, Array.from({ length: 1000 }, (_, k) => ({ cells: { [f.Name]: `paste ${i} ${k}` } })));
      store.deleteRows(ACTOR, b.tasks, res.created!);
      return res.created!.length;
    }
    case "drain_100":
      return (async () => {
        // 100 button runs that each read and update their record.
        const a = auto!.repo.all().find(x => x.name === "bench drain")!;
        const t = store.table(b.tasks);
        const n = store.rowCount(b.tasks);
        const runIds: number[] = [];
        for (let k = 0; k < 100; k++) {
          const id = store.one<{ id: number }>(`SELECT id FROM ${t.phys} LIMIT 1 OFFSET ?`, (i * 100 + k) * 7919 % n)!.id;
          runIds.push(auto!.repo.enqueue(a, { type: "button", tableId: b.tasks, recordId: id, at: Date.now() }, [a.id], Date.now(), NO_QUOTA));
        }
        for (const id of runIds) await auto!.engine.execute(id);
        return runIds.length;
      })();
  }
  throw new Error("unknown op " + name);
}

export const benchRoutes = new Hono<{ Bindings: Env }>();

benchRoutes.use("*", async (c, next) => {
  if (!c.env.BENCH_TOKEN || c.req.header("x-bench-token") !== c.env.BENCH_TOKEN) return c.json({ error: "Not found" }, 404);
  await next();
});

benchRoutes.get("/:cmd", async c => {
  const base = c.req.query("base") ?? "bench50k";
  const stub = c.env.BASE.get(c.env.BASE.idFromName("bench:" + base)) as unknown as { bench(cmd: string, args: Record<string, unknown>): Promise<unknown> };
  const q = c.req.query();
  const num = (k: string, d: number) => (q[k] !== undefined ? Number(q[k]) : d);
  if (c.req.param("cmd") === "time") {
    const name = q.name ?? "noop", reps = num("reps", 1), trials = num("trials", 7), salt = num("salt", 0);
    const noop: number[] = [], opMs: number[] = [];
    let out: unknown = null;
    for (let t = 0; t < trials; t++) {
      let t0 = Date.now();
      await stub.bench("op", { name: "noop", reps: 1 });
      noop.push(Date.now() - t0);
      t0 = Date.now();
      out = await stub.bench("op", { name, reps, salt: salt + t * reps });
      opMs.push(Date.now() - t0);
    }
    return c.json({ name, reps, trials, noop_ms: noop, op_ms: opMs, out, colo: (c.req.raw as { cf?: { colo?: string } }).cf?.colo });
  }
  return c.json(await stub.bench(c.req.param("cmd"), { n: num("n", 5000), offset: num("offset", 0), nprojects: num("nprojects", 2000) }));
});
