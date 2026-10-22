import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { BaseStore } from "../../src/worker/base/store";
import type { BaseStub } from "../../src/worker/access";
import type { LinkValue } from "../../src/shared/types";

const actor = { userId: "u1", name: "Tester" };

async function withStore<R>(name: string, fn: (s: BaseStore, d: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (instance: BaseDO) => {
    if (!instance.store.initialized) {
      instance.store.init(name);
    }
    return fn(instance.store, instance);
  });
}

function setupProjects(s: BaseStore) {
  const projects = s.createTable(actor, { name: "Projects", fields: [{ name: "Name", type: "text" }, { name: "Owner", type: "text" }] }).tableId;
  const tasks = s.createTable(actor, {
    name: "Tasks",
    fields: [
      { name: "Name", type: "text" },
      { name: "Hours", type: "number" },
      { name: "Status", type: "singleSelect", options: { choices: [{ id: "selTodo00000", name: "Todo", color: "#eee" }, { id: "selDone00000", name: "Done", color: "#eee" }] } },
    ],
  }).tableId;
  const link = s.createField(tasks, { name: "Project", type: "link", options: { linkedTableId: projects } }).fieldId;
  const inverse = s.field(link).options.inverseFieldId!;
  const f = (t: string, n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
  const pname = f(projects, "Name");
  const res = s.createRows(actor, projects, [{ cells: { [pname]: "Apollo" } }, { cells: { [pname]: "Gemini" } }]);
  const [apollo, gemini] = res.changes.find(c => c.tableId === projects)!.rows.map(r => r.id);
  return { projects, tasks, link, inverse, pname, apollo, gemini, f };
}

describe("base store", () => {
  it("creates a blank table with defaults", async () => {
    await withStore("blank", s => {
      const { tableId } = s.createTable(actor, { name: "Things" });
      expect(s.fieldsOf(tableId).map(f => f.name)).toEqual(["Name", "Notes", "Status"]);
      expect(s.rowCount(tableId)).toBe(3);
      expect(s.schema().views.filter(v => v.tableId === tableId)).toHaveLength(1);
    });
  });

  it("keeps links symmetric and maintains lookup, rollup and formula", async () => {
    await withStore("links", s => {
      const p = setupProjects(s);
      const hours = p.f(p.tasks, "Hours");
      const owner = p.f(p.projects, "Owner");
      const tname = p.f(p.tasks, "Name");
      const total = s.createField(p.projects, { name: "Total", type: "rollup", options: { linkFieldId: p.inverse, targetFieldId: hours, fn: "sum" } }).fieldId;
      const lookup = s.createField(p.tasks, { name: "Owner", type: "lookup", options: { linkFieldId: p.link, targetFieldId: owner } }).fieldId;
      const formula = s.createField(p.tasks, { name: "Label", type: "formula", options: { formula: '{Name} & " (" & {Project} & ")"' } }).fieldId;

      const created = s.createRows(actor, p.tasks, [
        { cells: { [tname]: "Design", [hours]: 3, [p.link]: [p.apollo] } },
        { cells: { [tname]: "Build", [hours]: 5, [p.link]: [p.apollo] } },
      ]);
      const [t1, t2] = created.changes.find(c => c.tableId === p.tasks)!.rows;
      expect(t1.cells[p.link]).toEqual([{ id: p.apollo, t: "Apollo" }]);
      expect(t1.cells[formula]).toBe("Design (Apollo)");

      let apollo = s.getRow(p.projects, p.apollo)!;
      expect((apollo.cells[p.inverse] as LinkValue[]).map(v => v.id).sort()).toEqual([t1.id, t2.id].sort());
      expect(apollo.cells[total]).toBe(8);

      // Owner change flows into the lookup.
      s.updateRows(actor, p.projects, [{ id: p.apollo, cells: { [owner]: "Ava" } }]);
      expect(s.getRow(p.tasks, t1.id)!.cells[lookup]).toEqual(["Ava"]);

      // Renaming the project updates link titles and the formula that reads them.
      s.updateRows(actor, p.projects, [{ id: p.apollo, cells: { [p.pname]: "Apollo 11" } }]);
      const t1b = s.getRow(p.tasks, t1.id)!;
      expect(t1b.cells[p.link]).toEqual([{ id: p.apollo, t: "Apollo 11" }]);
      expect(t1b.cells[formula]).toBe("Design (Apollo 11)");

      // Editing hours updates the rollup incrementally.
      s.updateRows(actor, p.tasks, [{ id: t2.id, cells: { [hours]: 10 } }]);
      expect(s.getRow(p.projects, p.apollo)!.cells[total]).toBe(13);

      // Moving a task to another project updates both sides.
      s.updateRows(actor, p.tasks, [{ id: t2.id, cells: { [p.link]: [p.gemini] } }]);
      apollo = s.getRow(p.projects, p.apollo)!;
      const gemini = s.getRow(p.projects, p.gemini)!;
      expect(apollo.cells[total]).toBe(3);
      expect(gemini.cells[total]).toBe(10);
      expect((gemini.cells[p.inverse] as LinkValue[]).map(v => v.id)).toEqual([t2.id]);

      // Deleting a task removes it from the inverse link and the rollup.
      s.deleteRows(actor, p.tasks, [t1.id]);
      apollo = s.getRow(p.projects, p.apollo)!;
      expect(apollo.cells[p.inverse]).toBeUndefined();
      expect(apollo.cells[total]).toBe(0);
    });
  });

  it("filters, sorts and searches", async () => {
    await withStore("query", s => {
      const p = setupProjects(s);
      const hours = p.f(p.tasks, "Hours"), status = p.f(p.tasks, "Status"), name = p.f(p.tasks, "Name");
      s.createRows(actor, p.tasks, [
        { cells: { [name]: "alpha", [hours]: 1, [status]: "Todo" } },
        { cells: { [name]: "beta", [hours]: 7, [status]: "Done" } },
        { cells: { [name]: "gamma", [hours]: 4, [status]: "Done" } },
        { cells: { [name]: "delta" } },
      ]);
      const q = (input: Parameters<BaseStore["query"]>[1]) => s.getRows(p.tasks, s.query(p.tasks, input).ids).map(r => r.cells[name]);
      expect(q({ filters: { conjunction: "and", conditions: [{ fieldId: status, op: "eq", value: "selDone00000" }] } })).toEqual(["beta", "gamma"]);
      expect(q({ filters: { conjunction: "and", conditions: [{ fieldId: hours, op: "gt", value: 2 }] }, sorts: [{ fieldId: hours, dir: "desc" }] })).toEqual(["beta", "gamma"]);
      expect(q({ sorts: [{ fieldId: hours, dir: "asc" }] })).toEqual(["alpha", "gamma", "beta", "delta"]);
      expect(q({ filters: { conjunction: "and", conditions: [{ fieldId: hours, op: "empty" }] } })).toEqual(["delta"]);
      expect(q({ search: "done" })).toEqual(["beta", "gamma"]);
      expect(q({ search: "GAM" })).toEqual(["gamma"]);
      expect(q({ sorts: [{ fieldId: status, dir: "desc" }] }).slice(0, 2)).toEqual(["beta", "gamma"]);
      const grouped = s.query(p.tasks, { groupFieldId: status });
      expect(grouped.groups).toEqual(["selTodo00000", "selDone00000", "selDone00000", null]);
    });
  });

  it("typecasts paste values and creates select options", async () => {
    await withStore("typecast", s => {
      const p = setupProjects(s);
      const status = p.f(p.tasks, "Status"), hours = p.f(p.tasks, "Hours");
      const res = s.createRows(actor, p.tasks, [{ cells: { [status]: "Blocked", [hours]: "1,234.5", [p.link]: "Gemini, Mercury" } }], { typecast: true });
      const row = res.changes.find(c => c.tableId === p.tasks)!.rows[0];
      expect(row.cells[hours]).toBe(1234.5);
      const choice = s.field(status).options.choices!.find(c => c.name === "Blocked");
      expect(row.cells[status]).toBe(choice!.id);
      expect((row.cells[p.link] as LinkValue[]).map(v => v.t)).toEqual(["Gemini", "Mercury"]);
      expect(s.rowCount(p.projects)).toBe(3);
      expect(res.schema).toBeDefined();
    });
  });

  it("converts field types and keeps values", async () => {
    await withStore("convert", s => {
      const p = setupProjects(s);
      const hours = p.f(p.tasks, "Hours"), name = p.f(p.tasks, "Name"), status = p.f(p.tasks, "Status");
      const r = s.createRows(actor, p.tasks, [{ cells: { [name]: "42", [hours]: 3.5, [status]: "Done" } }]).changes[0].rows[0];
      s.updateField(hours, { type: "text" });
      expect(s.getRow(p.tasks, r.id)!.cells[hours]).toBe("3.5");
      s.updateField(hours, { type: "number" });
      expect(s.getRow(p.tasks, r.id)!.cells[hours]).toBe(3.5);
      s.updateField(status, { type: "text" });
      expect(s.getRow(p.tasks, r.id)!.cells[status]).toBe("Done");
      s.updateField(status, { type: "multiSelect" });
      const ms = s.field(status);
      expect(s.getRow(p.tasks, r.id)!.cells[status]).toEqual([ms.options.choices![0].id]);
      // Text to link matches records by primary field.
      const label = s.createField(p.tasks, { name: "Proj", type: "text" }).fieldId;
      s.updateRows(actor, p.tasks, [{ id: r.id, cells: { [label]: "Apollo" } }]);
      s.updateField(label, { type: "link", options: { linkedTableId: p.projects } });
      expect(s.getRow(p.tasks, r.id)!.cells[label]).toEqual([{ id: p.apollo, t: "Apollo" }]);
    });
  });

  it("rejects formula cycles and bad syntax", async () => {
    await withStore("formula", s => {
      const p = setupProjects(s);
      const a = s.createField(p.tasks, { name: "A", type: "formula", options: { formula: "{Hours} * 2" } }).fieldId;
      s.createField(p.tasks, { name: "B", type: "formula", options: { formula: "{A} + 1" } });
      expect(() => s.updateField(a, { options: { formula: "{B} + 1" } })).toThrow(/itself/);
      expect(() => s.createField(p.tasks, { name: "C", type: "formula", options: { formula: "IF(" } })).toThrow();
      expect(() => s.createField(p.tasks, { name: "D", type: "formula", options: { formula: "{Nope}" } })).toThrow();
    });
  });

  it("runs large column recomputes in batches", async () => {
    await withStore("jobs", s => {
      const p = setupProjects(s);
      const hours = p.f(p.tasks, "Hours");
      const rows = Array.from({ length: 2600 }, (_, i) => ({ cells: { [hours]: i } }));
      for (let i = 0; i < rows.length; i += 1000) s.createRows(actor, p.tasks, rows.slice(i, i + 1000));
      const fid = s.createField(p.tasks, { name: "Double", type: "formula", options: { formula: "{Hours} * 2" } }).fieldId;
      expect(s.jobs()).toHaveLength(1);
      let steps = 0;
      while (s.hasJobs()) { s.runJobStep(); steps++; }
      expect(steps).toBe(6);
      const last = s.getRows(p.tasks, s.query(p.tasks, { limit: 0 }).ids.slice(-1))[0];
      expect(last.cells[fid]).toBe(2599 * 2);
    });
  });

  it("orders rows with fractional keys", async () => {
    await withStore("order", s => {
      const { tableId } = s.createTable(actor, { name: "T", fields: [{ name: "Name", type: "text" }] });
      const name = s.fieldsOf(tableId)[0].id;
      const ids = s.createRows(actor, tableId, ["a", "b", "c"].map(v => ({ cells: { [name]: v } }))).changes[0].rows.map(r => r.id);
      s.moveRow(actor, tableId, ids[2], null, ids[0]);
      s.createRows(actor, tableId, [{ cells: { [name]: "x" } }], { afterId: ids[0] });
      const order = s.getRows(tableId, s.query(tableId, {}).ids).map(r => r.cells[name]);
      expect(order).toEqual(["c", "a", "x", "b"]);
    });
  });

  it("applies every template", async () => {
    for (const slug of ["project-tracker", "crm", "content-calendar", "bug-tracker", "inventory"]) {
      const stub = env.BASE.get(env.BASE.idFromName("tpl-" + slug));
      const schema = await (stub as unknown as BaseStub).init("tpl-" + slug, { template: slug });
      expect(schema.tables.length).toBeGreaterThan(0);
      await runInDurableObject(stub, (d: BaseDO) => {
        while (d.store.hasJobs()) d.store.runJobStep();
        for (const t of d.store.schema().tables) {
          for (const f of d.store.fieldsOf(t.id).filter(f => f.type === "formula")) {
            const rows = d.store.query(t.id, { limit: 50 }).rows;
            const errors = rows.filter(r => r.cells[f.id] === "#ERROR!");
            expect(errors.length, `${slug}.${t.name}.${f.name}`).toBe(0);
          }
        }
      });
    }
    await runInDurableObject(env.BASE.get(env.BASE.idFromName("tpl-project-tracker")), (d: BaseDO) => {
      const s = d.store;
      const projects = s.findTable("Projects")!;
      const p = s.query(projects.id, { limit: 1 }).rows[0];
      const total = s.fieldsOf(projects.id).find(f => f.name === "Total tasks")!;
      expect(p.cells[total.id]).toBe(30);
      const progress = s.fieldsOf(projects.id).find(f => f.name === "Progress")!;
      expect(String(p.cells[progress.id])).toMatch(/^\d+%$/);
    });
  });
  function seedAggregate(s: BaseStore) {
    const p = setupProjects(s);
    const hours = p.f(p.tasks, "Hours");
    const status = p.f(p.tasks, "Status");
    const tname = p.f(p.tasks, "Name");
    const tags = s.createField(p.tasks, { name: "Tags", type: "multiSelect", options: { choices: [{ id: "selA0000000", name: "A", color: "#eee" }, { id: "selB0000000", name: "B", color: "#eee" }] } }).fieldId;
    const due = s.createField(p.tasks, { name: "Due", type: "date" }).fieldId;
    const double = s.createField(p.tasks, { name: "Double", type: "formula", options: { formula: "{Hours} * 2" } }).fieldId;
    s.createRows(actor, p.tasks, [
      { cells: { [tname]: "t1", [hours]: 3, [status]: "selTodo00000", [p.link]: [p.apollo], [tags]: ["selA0000000", "selB0000000"], [due]: "2026-01-05" } },
      { cells: { [tname]: "t2", [hours]: 5, [status]: "selDone00000", [p.link]: [p.apollo], [tags]: ["selA0000000"], [due]: "2026-01-20" } },
      { cells: { [tname]: "t3", [hours]: 2, [status]: "selDone00000", [p.link]: [p.gemini], [due]: "2026-02-01" } },
      { cells: { [tname]: "t4" } },
    ]);
    return { ...p, hours, status, tname, tags, due, double };
  }

  it("aggregates without grouping", async () => {
    await withStore("agg-total", s => {
      const p = seedAggregate(s);
      const r = s.aggregate(p.tasks, { metrics: [{ fn: "count", as: "n" }, { fn: "sum", fieldId: p.hours, as: "hours" }, { fn: "avg", fieldId: p.hours, as: "avg" }, { fn: "sum", fieldId: p.double, as: "double" }, { fn: "countUnique", fieldId: p.status, as: "statuses" }, { fn: "countEmpty", fieldId: p.status, as: "noStatus" }] });
      expect(r.total).toBe(4);
      expect(r.groups).toEqual([{ key: [], values: { n: 4, hours: 10, avg: 10 / 3, double: 20, statuses: 2, noStatus: 1 } }]);
    });
  });

  it("returns one zero group for no rows", async () => {
    await withStore("agg-empty", s => {
      const p = seedAggregate(s);
      const r = s.aggregate(p.tasks, { filters: { conjunction: "and", conditions: [{ fieldId: p.tname, op: "eq", value: "nope" }] }, metrics: [{ fn: "count", as: "n" }, { fn: "avg", fieldId: p.hours, as: "avg" }] });
      expect(r).toEqual({ groups: [{ key: [], values: { n: 0, avg: null } }], total: 0 });
    });
  });

  it("groups by select, multi select fan-out and links", async () => {
    await withStore("agg-groups", s => {
      const p = seedAggregate(s);
      const count = [{ fn: "count" as const, as: "n" }, { fn: "sum" as const, fieldId: p.hours, as: "h" }];
      expect(s.aggregate(p.tasks, { groupBy: [{ fieldId: p.status }], metrics: count }).groups).toEqual([
        { key: ["Done"], values: { n: 2, h: 7 } },
        { key: ["Todo"], values: { n: 1, h: 3 } },
        { key: [null], values: { n: 1, h: 0 } },
      ]);
      expect(s.aggregate(p.tasks, { groupBy: [{ fieldId: p.tags }], metrics: [{ fn: "count", as: "n" }] }).groups.map(g => [g.key[0], g.values.n])).toEqual([["A", 2], [null, 2], ["B", 1]]);
      expect(s.aggregate(p.tasks, { groupBy: [{ fieldId: p.link }], metrics: [{ fn: "count", as: "n" }] }).groups.map(g => [g.key[0], g.values.n])).toEqual([["Apollo", 2], ["Gemini", 1], [null, 1]]);
      const two = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.status }, { fieldId: p.tags }], metrics: [{ fn: "count", as: "n" }] });
      expect(two.groups).toHaveLength(5);
      expect(two.total).toBe(4);
    });
  });

  it("buckets dates and takes date min and max", async () => {
    await withStore("agg-dates", s => {
      const p = seedAggregate(s);
      const months = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.due, bucket: "month" }], metrics: [{ fn: "count", as: "n" }] });
      expect(months.groups.map(g => [g.key[0], g.values.n])).toEqual([["2026-01", 2], ["2026-02", 1], [null, 1]]);
      const weeks = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.due, bucket: "week" }], metrics: [{ fn: "count", as: "n" }] });
      expect(weeks.groups.map(g => g.key[0])).toContain("2026-01-05");
      expect(weeks.groups.map(g => g.key[0])).toContain("2026-01-19");
      const range = s.aggregate(p.tasks, { metrics: [{ fn: "min", fieldId: p.due, as: "first" }, { fn: "max", fieldId: p.due, as: "last" }] });
      expect(range.groups[0].values).toEqual({ first: "2026-01-05", last: "2026-02-01" });
    });
  });

  it("aggregates a rollup and applies filters", async () => {
    await withStore("agg-rollup", s => {
      const p = seedAggregate(s);
      const total = s.createField(p.projects, { name: "Total", type: "rollup", options: { linkFieldId: p.inverse, targetFieldId: p.hours, fn: "sum" } }).fieldId;
      expect(s.aggregate(p.projects, { metrics: [{ fn: "sum", fieldId: total, as: "t" }] }).groups[0].values.t).toBe(10);
      const done = s.aggregate(p.tasks, { filters: { conjunction: "and", conditions: [{ fieldId: p.status, op: "eq", value: "selDone00000" }] }, metrics: [{ fn: "count", as: "n" }] });
      expect(done.total).toBe(2);
    });
  });

  it("extraFilters narrows a view filter", async () => {
    await withStore("agg-view", s => {
      const p = seedAggregate(s);
      const viewId = s.createView(p.tasks, { name: "Done", type: "grid", config: { filters: { conjunction: "and", conditions: [{ fieldId: p.status, op: "eq", value: "selDone00000" }] } } }).viewId;
      const q = s.query(p.tasks, { viewId, extraFilters: { conjunction: "and", conditions: [{ fieldId: p.hours, op: "gt", value: 4 }] }, limit: 0 });
      expect(q.total).toBe(1);
      const r = s.aggregate(p.tasks, { viewId, filters: { conjunction: "and", conditions: [{ fieldId: p.hours, op: "gt", value: 4 }] }, metrics: [{ fn: "count", as: "n" }] });
      expect(r.total).toBe(1);
    });
  });

  it("rejects bad metrics and caps groups", async () => {
    await withStore("agg-errors", s => {
      const p = seedAggregate(s);
      expect(() => s.aggregate(p.tasks, { metrics: [{ fn: "sum", fieldId: p.tname, as: "x" }] })).toThrow(/needs a number field/);
      expect(() => s.aggregate(p.tasks, { metrics: [] })).toThrow(/1 to 10 metrics/);
      expect(() => s.aggregate(p.tasks, { groupBy: [{ fieldId: p.status }, { fieldId: p.tags }, { fieldId: p.due }], metrics: [{ fn: "count", as: "n" }] })).toThrow(/at most 2/);
      s.createRows(actor, p.tasks, Array.from({ length: 1005 }, (_, i) => ({ cells: { [p.tname]: `bulk ${i}` } })));
      const r = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.tname }], metrics: [{ fn: "count", as: "n" }] });
      expect(r.groups).toHaveLength(1000);
      expect(r.truncated).toBe(true);
      expect(r.total).toBe(1009);
    });
  });
  function seedDates(s: BaseStore) {
    const t = s.createTable(actor, {
      name: "Events",
      fields: [
        { name: "Name", type: "text" },
        { name: "Start", type: "date" },
        { name: "End", type: "date" },
        { name: "Days", type: "number" },
        { name: "At", type: "date", options: { includeTime: true } },
        { name: "Kind", type: "singleSelect", options: { choices: [{ id: "selMeet00000", name: "Meeting", color: "#eee" }, { id: "selTrip00000", name: "Trip", color: "#eee" }] } },
      ],
    }).tableId;
    const f = (n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
    const F = { name: f("Name"), start: f("Start"), end: f("End"), days: f("Days"), at: f("At"), kind: f("Kind") };
    s.createRows(actor, t, [
      { cells: { [F.name]: "single", [F.start]: "2026-03-10" } },
      { cells: { [F.name]: "span", [F.start]: "2026-03-08", [F.end]: "2026-03-12", [F.kind]: "selMeet00000" } },
      { cells: { [F.name]: "before", [F.start]: "2026-02-01", [F.end]: "2026-02-03" } },
      { cells: { [F.name]: "backwards", [F.start]: "2026-03-20", [F.end]: "2026-03-01" } },
      { cells: { [F.name]: "nodate" } },
      { cells: { [F.name]: "long", [F.start]: "2026-03-01", [F.days]: 15 } },
      { cells: { [F.name]: "timed", [F.at]: "2026-03-10T23:30:00.000Z" } },
    ]);
    const names = (ids: number[]) => s.getRows(t, ids).map(r => r.cells[F.name] as string).sort();
    return { t, F, names };
  }

  it("range returns records whose span overlaps the window", async () => {
    await withStore("range-overlap", s => {
      const { t, F, names } = seedDates(s);
      const q = (r: Partial<import("../../src/worker/base/query").DateRange>) => names(s.query(t, { range: { startFieldId: F.start, from: "2026-03-01", to: "2026-03-31", ...r }, limit: 0 }).ids);
      expect(q({ endFieldId: F.end, from: "2026-03-11", to: "2026-03-15" })).toEqual(["span"]);
      expect(q({ endFieldId: F.end, from: "2026-03-10", to: "2026-03-10" })).toEqual(["single", "span"]);
      expect(q({ endFieldId: F.end, from: "2026-03-12", to: "2026-03-12" })).toEqual(["span"]);
      expect(q({ endFieldId: F.end, from: "2026-03-13", to: "2026-03-19" })).toEqual([]);
      expect(q({})).toEqual(["backwards", "long", "single", "span"]);
      expect(q({ durationFieldId: F.days, from: "2026-03-14", to: "2026-03-14" })).toEqual(["long"]);
      expect(q({ durationFieldId: F.days, from: "2026-03-16", to: "2026-03-20" })).toEqual(["backwards"]);
      expect(q({ startFieldId: F.at, from: "2026-03-10", to: "2026-03-10" })).toEqual(["timed"]);
    });
  });

  it("range treats an end before start as a single day", async () => {
    await withStore("range-backwards", s => {
      const { t, F, names } = seedDates(s);
      expect(names(s.query(t, { range: { startFieldId: F.start, endFieldId: F.end, from: "2026-03-20", to: "2026-03-20" }, limit: 0 }).ids)).toEqual(["backwards"]);
      expect(names(s.query(t, { range: { startFieldId: F.start, endFieldId: F.end, from: "2026-03-02", to: "2026-03-05" }, limit: 0 }).ids)).toEqual([]);
    });
  });

  it("range combines with filters and created time", async () => {
    await withStore("range-filters", s => {
      const { t, F, names } = seedDates(s);
      const meet = s.query(t, { range: { startFieldId: F.start, endFieldId: F.end, from: "2026-03-01", to: "2026-03-31" }, filters: { conjunction: "and", conditions: [{ fieldId: F.kind, op: "eq", value: "selMeet00000" }] }, limit: 0 });
      expect(names(meet.ids)).toEqual(["span"]);
      const ct = s.createField(t, { name: "Created", type: "createdTime" }).fieldId;
      const today = new Date().toISOString().slice(0, 10);
      expect(s.query(t, { range: { startFieldId: ct, from: today, to: today }, limit: 0 }).total).toBe(7);
    });
  });

  it("range rejects invalid windows and fields", async () => {
    await withStore("range-invalid", s => {
      const { t, F } = seedDates(s);
      const q = (r: Partial<import("../../src/worker/base/query").DateRange>) => () => s.query(t, { range: { startFieldId: F.start, from: "2026-03-01", to: "2026-03-31", ...r }, limit: 0 });
      expect(q({ from: "2026-3-1" })).toThrow("Range dates must look like 2026-01-31");
      expect(q({ from: "2026-04-01" })).toThrow("Range start must not be after its end");
      expect(q({ from: "2020-01-01", to: "2024-01-01" })).toThrow("A range can span at most 3 years");
      expect(q({ startFieldId: F.name })).toThrow("The start field must be a date field");
    });
  });

  it("orders by group levels and returns group keys", async () => {
    await withStore("group-levels", s => {
      const p = seedAggregate(s);
      const byName = (ids: number[]) => s.getRows(p.tasks, ids).map(r => r.cells[p.tname]);
      const q = s.query(p.tasks, { groupLevels: [{ fieldId: p.status, dir: "asc" }, { fieldId: p.tags, dir: "asc" }], limit: 0 });
      expect(byName(q.ids)).toEqual(["t1", "t2", "t3", "t4"]);
      expect(q.groupKeys).toEqual([
        ["selTodo00000", '["selA0000000","selB0000000"]'],
        ["selDone00000", '["selA0000000"]'],
        ["selDone00000", null],
        [null, null],
      ]);
      const desc = s.query(p.tasks, { groupLevels: [{ fieldId: p.status, dir: "desc" }], limit: 0 });
      expect(byName(desc.ids)).toEqual(["t2", "t3", "t1", "t4"]);
      const link = s.query(p.tasks, { groupLevels: [{ fieldId: p.link, dir: "asc" }], limit: 0 });
      expect(link.groupKeys![0][0]).toMatch(/^\[\{"id":\d+,"t":"Apollo"\}\]$/);
      const viewId = s.createView(p.tasks, { name: "Grouped", type: "grid", config: { groups: [{ fieldId: p.status, dir: "asc" }] } }).viewId;
      expect(s.query(p.tasks, { viewId, limit: 0 }).groupKeys).toHaveLength(4);
      expect(() => s.query(p.tasks, { groupLevels: [p.status, p.tags, p.due, p.hours].map(fieldId => ({ fieldId, dir: "asc" as const })), limit: 0 })).toThrow("Group by at most 3 fields");
    });
  });

  it("new calendar, timeline and gallery views get sensible defaults", async () => {
    await withStore("view-defaults", s => {
      const { t, F } = seedDates(s);
      const cfg = (type: "calendar" | "timeline" | "gallery") => {
        const id = s.createView(t, { name: type, type }).viewId;
        return s.schema().views.find(v => v.id === id)!.config;
      };
      expect(cfg("calendar")).toEqual({ dateFieldId: F.start, calendarMode: "month" });
      expect(cfg("timeline")).toEqual({ dateFieldId: F.start, laneFieldId: F.kind, timelineScale: "week" });
      expect(cfg("gallery")).toEqual({});
    });
  });

  it("deleteField clears every view reference", async () => {
    await withStore("view-cleanup", s => {
      const { t, F } = seedDates(s);
      const make = (type: "calendar" | "timeline" | "grid" | "gallery", config: object) => s.createView(t, { name: type, type, config }).viewId;
      const cal = make("calendar", { dateFieldId: F.start, endDateFieldId: F.end });
      const tl = make("timeline", { dateFieldId: F.at, durationFieldId: F.days, laneFieldId: F.kind });
      const grid = make("grid", { groups: [{ fieldId: F.kind, dir: "asc" }, { fieldId: F.name, dir: "asc" }], summaries: { [F.days]: "sum" } });
      const gal = make("gallery", { coverFieldId: F.at });
      for (const id of [F.start, F.end, F.days, F.kind, F.at]) s.deleteField(id);
      const views = s.schema().views;
      const c = (id: string) => views.find(v => v.id === id)!.config;
      expect(c(cal)).toEqual({ calendarMode: "month" });
      expect(c(tl)).toEqual({ timelineScale: "week" });
      expect(c(grid)).toEqual({ groups: [{ fieldId: F.name, dir: "asc" }], summaries: {} });
      expect(c(gal)).toEqual({});
    });
  });
  it("aggregate without fan-out uses the same keys as grouped queries", async () => {
    await withStore("agg-keys", s => {
      const p = seedAggregate(s);
      const flag = s.createField(p.tasks, { name: "Flag", type: "checkbox" }).fieldId;
      const first = s.query(p.tasks, { limit: 0 }).ids[0];
      s.updateRows(actor, p.tasks, [{ id: first, cells: { [flag]: true } }]);
      for (const fieldId of [p.status, p.tags, p.link, p.due, p.hours, flag]) {
        const q = s.query(p.tasks, { groupLevels: [{ fieldId, dir: "asc" }], limit: 0 });
        const agg = s.aggregate(p.tasks, { groupBy: [{ fieldId }], fanOut: false, metrics: [{ fn: "count", as: "n" }] });
        expect(new Set(agg.groups.map(g => g.key[0]))).toEqual(new Set(q.groupKeys!.map(k => k[0])));
      }
      const tags = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.tags }], fanOut: false, metrics: [{ fn: "count", as: "n" }] });
      expect(tags.groups.map(g => [g.key[0], g.values.n])).toEqual([[null, 2], ['["selA0000000","selB0000000"]', 1], ['["selA0000000"]', 1]]);
    });
  });

  it("fix: aggregate without fan-out accepts 3 group levels", async () => {
    await withStore("fix-agg3", s => {
      const p = seedAggregate(s);
      const r = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.status }, { fieldId: p.tags }, { fieldId: p.link }], fanOut: false, metrics: [{ fn: "count", as: "n" }] });
      expect(r.total).toBe(4);
      expect(() => s.aggregate(p.tasks, { groupBy: [{ fieldId: p.status }, { fieldId: p.tags }, { fieldId: p.link }], metrics: [{ fn: "count", as: "n" }] })).toThrow(/at most 2/);
    });
  });

  it("fix: grouped rows stay consecutive when sort order and key disagree", async () => {
    await withStore("fix-consecutive", s => {
      const p = seedAggregate(s);
      const t = s.createTable(actor, { name: "Mix", fields: [{ name: "Name", type: "text" }, { name: "Tags", type: "multiSelect", options: { choices: [{ id: "selA0000000", name: "A", color: "#eee" }, { id: "selB0000000", name: "B", color: "#eee" }] } }] }).tableId;
      const f = (n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
      s.createRows(actor, t, [
        { cells: { [f("Name")]: "Apple", [f("Tags")]: ["selA0000000"] } },
        { cells: { [f("Name")]: "apple", [f("Tags")]: ["selA0000000", "selB0000000"] } },
        { cells: { [f("Name")]: "Apple", [f("Tags")]: ["selA0000000"] } },
      ]);
      for (const fieldId of [f("Tags"), f("Name")]) {
        const keys = s.query(t, { groupLevels: [{ fieldId, dir: "asc" }], limit: 0 }).groupKeys!.map(k => k[0]);
        const runs = keys.filter((k, i) => i === 0 || k !== keys[i - 1]).length;
        expect(runs).toBe(new Set(keys).size);
      }
      void p;
    });
  });

  it("fix: range ignores an end or duration field that is not a date or number", async () => {
    await withStore("fix-range-lenient", s => {
      const { t, F, names } = seedDates(s);
      expect(names(s.query(t, { range: { startFieldId: F.start, endFieldId: F.kind, from: "2026-03-10", to: "2026-03-10" }, limit: 0 }).ids)).toEqual(["single"]);
      expect(names(s.query(t, { range: { startFieldId: F.start, durationFieldId: F.name, from: "2026-03-10", to: "2026-03-10" }, limit: 0 }).ids)).toEqual(["single"]);
    });
  });

  it("fix: deleting a link field also cleans view references to the lookups it removed", async () => {
    await withStore("fix-cascade", s => {
      const p = setupProjects(s);
      const due = s.createField(p.projects, { name: "Due", type: "date" }).fieldId;
      const latest = s.createField(p.tasks, { name: "Project due", type: "rollup", options: { linkFieldId: p.link, targetFieldId: due, fn: "max" } }).fieldId;
      const start = s.createField(p.tasks, { name: "Start", type: "date" }).fieldId;
      const viewId = s.createView(p.tasks, { name: "Cal", type: "calendar", config: { dateFieldId: start, endDateFieldId: latest } }).viewId;
      s.deleteField(p.link);
      expect(s.schema().views.find(v => v.id === viewId)!.config.endDateFieldId).toBeUndefined();
    });
  });

  it("search matches what cells show, not field ids, option ids or JSON syntax", async () => {
    await withStore("search-values", s => {
      const p = setupProjects(s);
      const name = p.f(p.tasks, "Name"), status = p.f(p.tasks, "Status");
      s.createRows(actor, p.tasks, [
        { cells: { [name]: "Write docs", [status]: "selDone00000", [p.link]: [p.apollo] } },
        { cells: { [name]: "Ship it", [p.link]: [p.gemini] } },
      ]);
      const q = (search: string) => s.query(p.tasks, { search, limit: 0 }).total;
      expect([q("fld"), q("sel"), q('":"'), q("id")]).toEqual([0, 0, 0, 0]);
      expect([q("write"), q("done"), q("apollo"), q("gem")]).toEqual([1, 1, 1, 1]);
    });
  });

  it("fix: aggregate honors search like the grouped query", async () => {
    await withStore("fix-agg-search", s => {
      const p = seedAggregate(s);
      const q = s.query(p.tasks, { search: "t1", limit: 0 });
      const r = s.aggregate(p.tasks, { search: "t1", metrics: [{ fn: "count", as: "n" }] });
      expect(r.total).toBe(q.total);
      expect(r.total).toBe(1);
    });
  });
});
