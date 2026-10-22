import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { BaseStore } from "../../src/worker/base/store";
import { HttpClient, ownerWithBase, signup } from "./helpers";
import { widgetProblem } from "../../src/shared/widgets";

const actor = { userId: "u1", name: "Tester" };

async function withStore<R>(name: string, fn: (s: BaseStore) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (instance: BaseDO) => {
    if (!instance.store.initialized) instance.store.init(name);
    return fn(instance.store);
  });
}

/** Seven deals: stage, amount, tags (multi select) and a close date, chosen so every grouping has distinct totals. */
function setupDeals(s: BaseStore) {
  const t = s.createTable(actor, {
    name: "Deals",
    fields: [
      { name: "Name", type: "text" },
      { name: "Stage", type: "singleSelect", options: { choices: [{ id: "chLead", name: "Lead", color: "#eee" }, { id: "chWon", name: "Won", color: "#eee" }, { id: "chLost", name: "Lost", color: "#eee" }] } },
      { name: "Amount", type: "number" },
      { name: "Tags", type: "multiSelect", options: { choices: [{ id: "tgX", name: "x", color: "#eee" }, { id: "tgY", name: "y", color: "#eee" }, { id: "tgZ", name: "z", color: "#eee" }] } },
      { name: "Closed", type: "date" },
    ],
  }).tableId;
  const f = (n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
  const F = { name: f("Name"), stage: f("Stage"), amount: f("Amount"), tags: f("Tags"), closed: f("Closed") };
  const ch = (fid: string, n: string) => s.field(fid).options.choices!.find(c => c.name === n)!.id;
  const rows: [string, string | null, number, string[], string | null][] = [
    ["A", "Won", 100, ["x"], "2026-01-05"],
    ["B", "Won", 300, ["x", "y"], "2026-01-20"],
    ["C", "Lost", 50, ["y"], "2026-02-03"],
    ["D", "Lead", 10, [], "2026-02-10"],
    ["E", "Lead", 20, ["z"], null],
    ["F", "Lost", 70, ["x"], "2026-03-01"],
    ["G", null, 5, [], "2026-03-15"],
  ];
  const res = s.createRows(actor, t, rows.map(([name, stage, amount, tags, closed]) => ({ cells: { [F.name]: name, [F.stage]: stage ? ch(F.stage, stage) : null, [F.amount]: amount, [F.tags]: tags.map(x => ch(F.tags, x)), [F.closed]: closed } })));
  const ids = Object.fromEntries(res.changes.find(c => c.tableId === t)!.rows.map(r => [r.cells[F.name] as string, r.id])) as Record<string, number>;
  return { t, F, ids };
}

const count = [{ fn: "count" as const, as: "n" }];

describe("aggregate for dashboards", () => {
  it("aggregate range keeps records whose date is in the window", async () => {
    await withStore("agg-range", s => {
      const { t, F } = setupDeals(s);
      expect(s.aggregate(t, { range: { fieldId: F.closed, from: "2026-02-01", to: "2026-02-28" }, metrics: count }).groups[0].values.n).toBe(2);
    });
  });

  it("aggregate range on a date-and-time field uses the UTC day", async () => {
    await withStore("agg-range-utc", s => {
      const t = s.createTable(actor, { name: "Events", fields: [{ name: "Name", type: "text" }, { name: "At", type: "date", options: { includeTime: true } }] }).tableId;
      const at = s.fieldsOf(t).find(f => f.name === "At")!.id;
      s.createRows(actor, t, [{ cells: { [at]: "2026-02-28T23:30:00.000Z" } }, { cells: { [at]: "2026-03-01T00:10:00.000Z" } }]);
      expect(s.aggregate(t, { range: { fieldId: at, from: "2026-02-01", to: "2026-02-28" }, metrics: count }).groups[0].values.n).toBe(1);
    });
  });

  it("aggregate sort by key orders names, months and numbers with empty last", async () => {
    await withStore("agg-sort-key", s => {
      const { t, F } = setupDeals(s);
      const keys = (q: object) => s.aggregate(t, { metrics: count, sort: "key", ...q }).groups.map(g => g.key);
      expect(keys({ groupBy: [{ fieldId: F.stage }] })).toEqual([["Lead"], ["Lost"], ["Won"], [null]]);
      expect(keys({ groupBy: [{ fieldId: F.closed, bucket: "month" }] })).toEqual([["2026-01"], ["2026-02"], ["2026-03"], [null]]);
      expect(keys({ groupBy: [{ fieldId: F.amount }] })).toEqual([["5"], ["10"], ["20"], ["50"], ["70"], ["100"], ["300"]]);
    });
  });

  it("aggregate limit keeps the top groups and marks the result truncated", async () => {
    await withStore("agg-limit", s => {
      const { t, F } = setupDeals(s);
      const r = s.aggregate(t, { groupBy: [{ fieldId: F.stage }], metrics: [{ fn: "sum", fieldId: F.amount, as: "s" }], limit: 2 });
      expect(r.groups).toEqual([{ key: ["Won"], values: { s: 400 } }, { key: ["Lost"], values: { s: 120 } }]);
      expect(r.truncated).toBe(true);
      expect(r.total).toBe(7);
    });
  });

  it("aggregate other folds the remaining groups, recomputing avg and leaving countUnique empty", async () => {
    await withStore("agg-other", s => {
      const { t, F } = setupDeals(s);
      const r = s.aggregate(t, {
        groupBy: [{ fieldId: F.stage }],
        metrics: [{ fn: "sum", fieldId: F.amount, as: "s" }, { fn: "avg", fieldId: F.amount, as: "a" }, { fn: "countUnique", fieldId: F.name, as: "u" }, { fn: "count", as: "n" }],
        limit: 2,
        other: true,
      });
      expect(r.groups.map(g => g.key)).toEqual([["Won"], ["Lost"], ["__other__"]]);
      expect(r.groups[2].values).toEqual({ s: 35, a: 35 / 3, u: null, n: 3 });
      expect(r.truncated).toBeUndefined();
    });
  });

  it("aggregate rejects bad sort, limit, other and range settings", async () => {
    await withStore("agg-bad", s => {
      const { t, F } = setupDeals(s);
      const g = [{ fieldId: F.stage }];
      expect(() => s.aggregate(t, { groupBy: g, metrics: count, sort: "size" as "key" })).toThrow('sort must be "value" or "key"');
      expect(() => s.aggregate(t, { groupBy: g, metrics: count, limit: 0 })).toThrow("limit must be 1 to 1000");
      expect(() => s.aggregate(t, { groupBy: g, metrics: count, other: true })).toThrow("other needs a limit and exactly one group field");
      expect(() => s.aggregate(t, { groupBy: [...g, { fieldId: F.tags }], metrics: count, limit: 2, other: true })).toThrow("other needs a limit and exactly one group field");
      expect(() => s.aggregate(t, { metrics: count, range: { fieldId: F.amount, from: "2026-01-01", to: "2026-01-31" } })).toThrow("The range field must be a date field");
      expect(() => s.aggregate(t, { metrics: count, range: { fieldId: F.closed, from: "2026-02-01", to: "2026-01-01" } })).toThrow("Range start must not be after its end");
    });
  });
});
describe("drill-down", () => {
  it("drill ids match the aggregate counts, with multi select fan-out", async () => {
    await withStore("drill-fanout", s => {
      const { t, F, ids } = setupDeals(s);
      const q = { groupBy: [{ fieldId: F.tags }], metrics: count };
      const r = s.aggregate(t, q);
      for (const g of r.groups) expect(s.aggregateRecords(t, q, g.key).ids).toHaveLength(g.values.n as number);
      expect(s.aggregateRecords(t, q, ["x"]).ids).toEqual([ids.A, ids.B, ids.F]);
      expect(s.aggregateRecords(t, q, [null]).ids).toEqual([ids.D, ids.G]);
    });
  });

  it("drill handles week buckets, empty dates, Other and the whole table", async () => {
    await withStore("drill-keys", s => {
      const { t, F, ids } = setupDeals(s);
      const week = { groupBy: [{ fieldId: F.closed, bucket: "week" as const }], metrics: count };
      expect(s.aggregateRecords(t, week, ["2026-01-05"]).ids).toEqual([ids.A]);
      expect(s.aggregateRecords(t, week, ["2026-01-19"]).ids).toEqual([ids.B]);
      expect(s.aggregateRecords(t, { groupBy: [{ fieldId: F.closed }], metrics: count }, [null]).ids).toEqual([ids.E]);
      const top = { groupBy: [{ fieldId: F.stage }], metrics: [{ fn: "sum" as const, fieldId: F.amount, as: "s" }], limit: 2, other: true };
      expect(s.aggregateRecords(t, top, ["__other__"]).ids).toEqual([ids.D, ids.E, ids.G]);
      expect(s.aggregateRecords(t, { metrics: count }, []).ids).toHaveLength(7);
    });
  });

  it("Other counts each record once with multi-select fan-out, the same as its drill list", async () => {
    await withStore("other-fanout", s => {
      const t = s.createTable(actor, { name: "T", fields: [{ name: "Name", type: "text" }, { name: "Tags", type: "multiSelect", options: { choices: ["a", "b", "c", "d"].map(n => ({ id: "sel" + n + "00000000", name: n, color: "#eee" })) } }, { name: "N", type: "number" }] }).tableId;
      const [tags, n] = ["Tags", "N"].map(x => s.fieldsOf(t).find(f => f.name === x)!.id);
      const sel = (x: string) => "sel" + x + "00000000";
      s.createRows(actor, t, [["a", "b"], ["a", "c"], ["a", "d"], ["b", "c"]].map((v, i) => ({ cells: { [tags]: v.map(sel), [n]: i + 1 } })));
      const q = { groupBy: [{ fieldId: tags }], metrics: [{ fn: "count" as const, as: "n" }, { fn: "sum" as const, fieldId: n, as: "s" }], limit: 1, other: true };
      const r = s.aggregate(t, q);
      expect(r.groups.map(g => [g.key[0], g.values.n])).toEqual([["a", 3], ["__other__", 4]]);
      expect(r.groups[1].values.s).toBe(10);
      expect(s.aggregateRecords(t, q, ["__other__"]).ids).toHaveLength(4);
    });
  });

  it("drill caps the list and rejects a key of the wrong length", async () => {
    await withStore("drill-cap", s => {
      const { t, F, ids } = setupDeals(s);
      expect(s.aggregateRecords(t, { metrics: count }, [], 2)).toEqual({ ids: [ids.A, ids.B], truncated: true });
      expect(() => s.aggregateRecords(t, { groupBy: [{ fieldId: F.stage }], metrics: count }, [])).toThrow("key must have one value per group field");
    });
  });

  it("drill route answers a viewer", async () => {
    const { c, wsId, baseId } = await ownerWithBase("drill-http", "blank");
    const schema = (await c.req("GET", `/api/bases/${baseId}`)).json.schema;
    const table = schema.tables[0];
    const status = schema.fields.find((f: { tableId: string; name: string }) => f.tableId === table.id && f.name === "Status").id;
    const inv = await c.req("POST", `/api/workspaces/${wsId}/invites`, { role: "viewer" });
    const viewer: HttpClient = await signup("drill-viewer@example.com", inv.json.id);
    const r = await viewer.req("POST", `/api/bases/${baseId}/aggregate/records`, { tableId: table.id, groupBy: [{ fieldId: status }], metrics: [{ fn: "count", as: "n" }], key: [null] });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ids: expect.any(Array), truncated: false });
    expect(r.json.ids).toHaveLength(3);
  });
});
describe("aggregate cache", () => {
  it("aggregate cache returns the stored result until a write", async () => {
    await withStore("cache-hit", s => {
      const { t, F, ids } = setupDeals(s);
      const q = { groupBy: [{ fieldId: F.stage }], metrics: [{ fn: "sum" as const, fieldId: F.amount, as: "s" }] };
      const a = s.aggregate(t, q);
      expect(s.aggregate(t, { ...q })).toBe(a);
      s.updateRows(actor, t, [{ id: ids.A, cells: { [F.amount]: 1000 } }]);
      const b = s.aggregate(t, q);
      expect(b).not.toBe(a);
      expect(b.groups.find(g => g.key[0] === "Won")!.values.s).toBe(1300);
    });
  });

  it("aggregate cache keeps distinct filters apart", async () => {
    await withStore("cache-filters", s => {
      const { t, F } = setupDeals(s);
      const by = (stage: string) => s.aggregate(t, { filters: { conjunction: "and", conditions: [{ fieldId: F.stage, op: "eq", value: s.field(F.stage).options.choices!.find(c => c.name === stage)!.id }] }, metrics: count }).groups[0].values.n;
      expect([by("Won"), by("Lead"), by("Won")]).toEqual([2, 2, 2]);
      expect(s.aggregate(t, { range: { fieldId: F.closed, from: "2026-01-01", to: "2026-01-31" }, metrics: count }).groups[0].values.n).toBe(2);
      expect(s.aggregate(t, { range: { fieldId: F.closed, from: "2026-03-01", to: "2026-03-31" }, metrics: count }).groups[0].values.n).toBe(2);
      expect(s.aggregate(t, { range: { fieldId: F.closed, from: "2026-02-05", to: "2026-03-31" }, metrics: count }).groups[0].values.n).toBe(3);
    });
  });

  it("aggregate cache sees a write to a linked table through a rollup", async () => {
    await withStore("cache-rollup", s => {
      const projects = s.createTable(actor, { name: "Projects", fields: [{ name: "Name", type: "text" }] }).tableId;
      const tasks = s.createTable(actor, { name: "Tasks", fields: [{ name: "Name", type: "text" }, { name: "Hours", type: "number" }] }).tableId;
      const link = s.createField(tasks, { name: "Project", type: "link", options: { linkedTableId: projects } }).fieldId;
      const hours = s.fieldsOf(tasks).find(f => f.name === "Hours")!.id;
      const total = s.createField(projects, { name: "Total", type: "rollup", options: { linkFieldId: s.field(link).options.inverseFieldId!, targetFieldId: hours, fn: "sum" } }).fieldId;
      const p = s.createRows(actor, projects, [{}]).changes.find(c => c.tableId === projects)!.rows[0].id;
      const task = s.createRows(actor, tasks, [{ cells: { [hours]: 2, [link]: [p] } }]).changes.find(c => c.tableId === tasks)!.rows[0].id;
      const q = { metrics: [{ fn: "sum" as const, fieldId: total, as: "s" }] };
      expect(s.aggregate(projects, q).groups[0].values.s).toBe(2);
      s.updateRows(actor, tasks, [{ id: task, cells: { [hours]: 5 } }]);
      expect(s.aggregate(projects, q).groups[0].values.s).toBe(5);
    });
  });
});
describe("dashboards", () => {
  it("dashboard ops create, rename and delete in order", async () => {
    await withStore("dash-crud", s => {
      const a = s.createDashboard({ name: "Sales" }).dashboardId;
      const b = s.createDashboard({ name: "  " }).dashboardId;
      expect(s.schema().dashboards.map(d => d.name)).toEqual(["Sales", "Dashboard"]);
      s.updateDashboard(a, { name: "Revenue" });
      s.deleteDashboard(b);
      expect(s.schema().dashboards).toEqual([{ id: a, name: "Revenue", ord: expect.any(String), widgets: [] }]);
      expect(() => s.deleteDashboard(b)).toThrow("Dashboard not found");
    });
  });

  it("dashboard widgets are placed below the others at their default size", async () => {
    await withStore("dash-place", s => {
      const { t, F } = setupDeals(s);
      const d = s.createDashboard({ name: "D" }).dashboardId;
      const w1 = s.addWidget(d, { type: "metric", tableId: t, metric: { fn: "count" } }).widgetId;
      const w2 = s.addWidget(d, { type: "bar", tableId: t, xFieldId: F.stage, metric: { fn: "sum", fieldId: F.amount } }).widgetId;
      expect(s.dashboard(d).widgets.map(w => [w.id, w.x, w.y, w.w, w.h, w.title])).toEqual([[w1, 0, 0, 3, 2, ""], [w2, 0, 2, 6, 4, ""]]);
    });
  });

  it("dashboard widget patches merge per widget, null clears, layout keeps settings", async () => {
    await withStore("dash-merge", s => {
      const { t, F } = setupDeals(s);
      const d = s.createDashboard({ name: "D", widgets: [{ type: "metric", tableId: t, metric: { fn: "count" } }, { type: "pie", tableId: t, groupFieldId: F.stage, metric: { fn: "count" } }] }).dashboardId;
      const [w1, w2] = s.dashboard(d).widgets.map(w => w.id);
      // Two editors working from the same snapshot touch different widgets.
      s.updateWidget(d, w1, { title: "Deals" });
      s.updateWidget(d, w2, { title: "By stage", limit: 5 });
      s.updateWidget(d, w2, { limit: null });
      // A layout save from a client that has not seen the edits above.
      s.setLayout(d, [{ id: w1, x: 3, y: 0, w: 4, h: 2 }, { id: "wgtGone0000", x: 0, y: 0, w: 1, h: 1 }]);
      const [a, b] = s.dashboard(d).widgets;
      expect(a).toMatchObject({ title: "Deals", x: 3, w: 4 });
      expect(b.title).toBe("By stage");
      expect("limit" in b).toBe(false);
      s.removeWidget(d, w1);
      expect(s.dashboard(d).widgets.map(w => w.id)).toEqual([w2]);
    });
  });

  it("dashboard rejects invalid widgets and more than 30", async () => {
    await withStore("dash-invalid", s => {
      const { t, F } = setupDeals(s);
      const d = s.createDashboard({ name: "D" }).dashboardId;
      expect(() => s.addWidget(d, { type: "map" as "bar" })).toThrow('Unknown widget type "map"');
      expect(() => s.addWidget(d, { type: "metric", x: 10, w: 4 })).toThrow("Widgets must fit in 12 columns");
      expect(() => s.addWidget(d, { type: "metric", h: 13 })).toThrow("Widget height must be 1 to 12 rows");
      expect(() => s.addWidget(d, { type: "text", text: "x".repeat(20 * 1024 + 1) })).toThrow("Text blocks are limited to 20 KB");
      expect(() => s.addWidget(d, { type: "metric", tableId: "tblNope", metric: { fn: "count" } })).toThrow("The table this widget uses no longer exists");
      expect(() => s.addWidget(d, { type: "metric", tableId: t, metric: { fn: "sum", fieldId: F.name } })).toThrow('sum needs a number field; "Name" is text');
      expect(() => s.createDashboard({ name: "Bad", widgets: [{ type: "metric", h: 13 }] })).toThrow("Widget height must be 1 to 12 rows");
      expect(s.schema().dashboards).toHaveLength(1);
      for (let i = 0; i < 30; i++) s.addWidget(d, { type: "text", text: String(i) });
      expect(() => s.addWidget(d, { type: "text" })).toThrow("A dashboard holds at most 30 widgets");
    });
  });

  it("dashboard widgets stay after their field, view or table is deleted and report the change", async () => {
    await withStore("dash-deleted", s => {
      const { t, F } = setupDeals(s);
      const other = s.createTable(actor, { name: "Other" }).tableId;
      const view = s.createView(t, { name: "Won", type: "grid" }).viewId;
      const d = s.createDashboard({ name: "D", widgets: [
        { type: "bar", tableId: t, xFieldId: F.stage, metric: { fn: "count" } },
        { type: "metric", tableId: t, viewId: view, metric: { fn: "count" } },
        { type: "metric", tableId: other, metric: { fn: "count" } },
      ] }).dashboardId;
      s.deleteField(F.stage);
      s.deleteView(view);
      s.deleteTable(other);
      const schema = s.schema();
      expect(schema.dashboards[0].widgets.map(w => widgetProblem(w, schema)?.message)).toEqual([
        "A field this widget uses no longer exists",
        "The view this widget uses no longer exists",
        "The table this widget uses no longer exists",
      ]);
    });
  });

  it("dashboard ops over HTTP: editors change them, viewers only read", async () => {
    const { c, wsId, baseId } = await ownerWithBase("dash-http", "blank");
    const created = await c.req("POST", `/api/bases/${baseId}/schema`, { op: "createDashboard", name: "Team" });
    expect(created.status).toBe(200);
    expect(created.json.schema.dashboards).toEqual([expect.objectContaining({ id: created.json.id, name: "Team" })]);
    const inv = await c.req("POST", `/api/workspaces/${wsId}/invites`, { role: "viewer" });
    const viewer = await signup("dash-viewer@example.com", inv.json.id);
    const denied = await viewer.req("POST", `/api/bases/${baseId}/schema`, { op: "deleteDashboard", dashboardId: created.json.id });
    expect(denied.status).toBe(403);
    expect((await viewer.req("GET", `/api/bases/${baseId}`)).json.schema.dashboards).toHaveLength(1);
  });

  it("fix: a broken widget does not block layout moves or title edits", async () => {
    await withStore("dash-broken-layout", s => {
      const { t, F } = setupDeals(s);
      const d = s.createDashboard({ name: "D", widgets: [{ type: "metric", tableId: t, metric: { fn: "count" } }, { type: "bar", tableId: t, xFieldId: F.stage, metric: { fn: "count" } }] }).dashboardId;
      const [w1, w2] = s.dashboard(d).widgets.map(w => w.id);
      s.deleteField(F.stage);
      s.setLayout(d, [{ id: w1, x: 6, y: 0, w: 3, h: 2 }, { id: w2, x: 0, y: 2, w: 6, h: 4 }]);
      expect(s.dashboard(d).widgets.map(w => [w.x, w.y])).toEqual([[6, 0], [0, 2]]);
      s.updateWidget(d, w2, { title: "Old chart" });
      expect(s.dashboard(d).widgets[1].title).toBe("Old chart");
      expect(() => s.updateWidget(d, w1, { metric: { fn: "sum", fieldId: F.stage } })).toThrow("A field this widget uses no longer exists");
      expect(() => s.setLayout(d, [{ id: w1, x: 10, y: 0, w: 4, h: 2 }])).toThrow("Widgets must fit in 12 columns");
    });
  });

  it("fix: dashboard edits keep cached aggregate results", async () => {
    await withStore("dash-keep-cache", s => {
      const { t } = setupDeals(s);
      const d = s.createDashboard({ name: "D", widgets: [{ type: "metric", tableId: t, metric: { fn: "count" } }] }).dashboardId;
      const w = s.dashboard(d).widgets[0].id;
      const q = { metrics: count };
      const a = s.aggregate(t, q);
      s.setLayout(d, [{ id: w, x: 3, y: 0, w: 3, h: 2 }]);
      s.updateWidget(d, w, { title: "N" });
      s.updateDashboard(d, { name: "E" });
      expect(s.aggregate(t, q)).toBe(a);
      s.createField(t, { name: "Note", type: "text" });
      expect(s.aggregate(t, q)).not.toBe(a);
    });
  });
});
