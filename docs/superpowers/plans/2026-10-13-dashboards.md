# Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Base-level dashboards with metric, bar, line, pie, pivot and text widgets over any table, a per-viewer date range, drill-down to records, live refresh, MCP tools, and a stored verification record per feature.

**Architecture:** Dashboards live in each base's Durable Object (`_dashboards` table) and travel with the schema; widgets are edited per widget through schema ops. Every number comes from the existing aggregate engine, extended with a date range, key sort, top-N with "Other", a drill-down that reuses the aggregate's own grouping, and an in-memory result cache cleared on any write. The client renders widgets with ECharts (modular, lazy) on a react-grid-layout 12-column grid.

**Tech Stack:** Cloudflare Workers, Durable Objects (SQLite), Hono, React 18, ECharts 6.1.0, react-grid-layout 2.2.4, marked 4.3.0, Vitest (unit + workerd pool), Playwright MCP for UI checks.

**Spec:** `docs/superpowers/specs/2026-10-13-dashboards-design.md`

## Global Constraints

- No git operations (user rule). The plan's "Commit" steps are replaced by "Checkpoint": run the task's tests and record the result in the ledger.
- No Chinese in code or comments. Never output the em dash character; use "-".
- Exact dependency versions: `echarts@6.1.0`, `react-grid-layout@2.2.4` (2.3.0 is under two weeks old). Install with `--save-exact`.
- Grid: 12 columns, `w` 1 to 12, `h` 1 to 12, `x + w <= 12`; at most 30 widgets per dashboard; text blocks at most 20 KB.
- Aggregate `limit` 1 to 1000; drill-down returns at most 500 ids.
- Result cache: in-memory LRU of 200 entries, cleared by any row write or schema change in the base.
- Date range: local days sent as they are, no padding; values with a time are filtered and bucketed by UTC day.
- Phone layout below 768 px: one column, read only.
- Live refresh: only widgets of the open dashboard whose table changed, after a 1 s debounce.
- ECharts must not load on table pages.
- Verification records in `docs/verification/` for mcp, views and dashboards; local `wrangler dev` numbers labeled as local.

## Review Focus

- A date-and-time field filtered by the dashboard range: a value at 23:30 UTC on the last day counts, 00:10 UTC the next day does not, whatever the browser's zone (Task 2 test).
- Two editors at once: one drags the layout while the other edits a widget's settings; the layout save must not undo the settings (Task 5 test).
- A text block containing raw HTML or a `javascript:` link must not run script or produce a live link (Task 7 test).
- A day-bucketed line chart over all time on years of data must not hang the tab (bucket fill capped, Task 7 test).
- A widget whose view was deleted, or whose metric field changed type, shows the "data source changed" state rather than a server error loop (Task 1 and Task 5 tests).

---

### Task 1: Shared dashboard types and widget rules

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/worker/base/aggregate.ts:5-6` (move `AggFn`, `DateBucket` to shared types, re-export)
- Modify: `src/shared/ids.ts`
- Create: `src/shared/widgets.ts`
- Test: `test/unit/widgets.test.ts`

**Interfaces:**
- Produces: `Widget`, `WidgetType`, `WidgetMetric`, `Dashboard`, `AggFn`, `DateBucket` (shared types); `Schema.dashboards: Dashboard[]`; `newDashboardId()`, `newWidgetId()`; from `src/shared/widgets.ts`: `WIDGET_TYPES`, `GRID_COLS`, `MAX_WIDGETS`, `MAX_TEXT`, `MAX_H`, `PIE_LIMIT`, `defaultSize(type)`, `DateWindow`, `widgetQuery(w, fields, range?)`, `SchemaLike`, `WidgetProblem`, `widgetProblem(w, s)`, `checkWidget(w, s)`, `WidgetInput`, `WidgetPatch`, `LayoutItemInput`.
- Consumes: `validateAggregate`, `AggregateInput` from `src/worker/base/aggregate.ts` (Task 2 adds `range`, `sort`, `limit`, `other` to `AggregateInput`; this task adds those optional keys to the interface already so `widgetQuery` compiles, and Task 2 implements them).

- [ ] **Step 1: Write the failing test**

`test/unit/widgets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Field, View, Widget } from "../../src/shared/types";
import { checkWidget, defaultSize, widgetProblem, widgetQuery } from "../../src/shared/widgets";

const fld = (id: string, name: string, type: Field["type"], options: Field["options"] = {}): Field => ({ id, tableId: "tblA", name, type, options, ord: "a" });
const fields = [
  fld("fldName", "Name", "text"),
  fld("fldStage", "Stage", "singleSelect", { choices: [{ id: "chWon", name: "Won", color: "#dff5dc" }] }),
  fld("fldAmount", "Amount", "number"),
  fld("fldClosed", "Closed", "date"),
];
const fmap = new Map(fields.map(f => [f.id, f]));
const views: View[] = [{ id: "viwA", tableId: "tblA", name: "Grid", type: "grid", config: {}, ord: "a" }];
const schema = { tables: [{ id: "tblA" }], views, fields };
const base = (w: Partial<Widget>): Widget => ({ id: "wgt1", type: "metric", title: "", x: 0, y: 0, w: 3, h: 2, ...w });

describe("widget queries", () => {
  it("metric counts with the widget filters and the dashboard range on its date field", () => {
    const q = widgetQuery(base({ tableId: "tblA", metric: { fn: "count" }, dateFieldId: "fldClosed", viewId: "viwA" }), fmap, { from: "2026-10-01", to: "2026-10-31" });
    expect(q).toEqual({ viewId: "viwA", filters: undefined, metrics: [{ fn: "count", fieldId: undefined, as: "v" }], range: { fieldId: "fldClosed", from: "2026-10-01", to: "2026-10-31" } });
  });

  it("ignores the range when the widget has no date field", () => {
    const q = widgetQuery(base({ tableId: "tblA", metric: { fn: "count" } }), fmap, { from: "2026-10-01", to: "2026-10-31" });
    expect(q?.range).toBeUndefined();
  });

  it("bar over a date field buckets by month and sorts by key; over a select sorts by value", () => {
    const byDate = widgetQuery(base({ type: "bar", tableId: "tblA", xFieldId: "fldClosed", metric: { fn: "sum", fieldId: "fldAmount" } }), fmap);
    expect(byDate).toMatchObject({ groupBy: [{ fieldId: "fldClosed", bucket: "month" }], sort: "key" });
    const bySelect = widgetQuery(base({ type: "bar", tableId: "tblA", xFieldId: "fldStage", limit: 5, metric: { fn: "count" } }), fmap);
    expect(bySelect).toMatchObject({ groupBy: [{ fieldId: "fldStage", bucket: undefined }], sort: "value", limit: 5 });
  });

  it("series charts group by two fields without a limit", () => {
    const q = widgetQuery(base({ type: "line", tableId: "tblA", xFieldId: "fldClosed", bucket: "week", seriesFieldId: "fldStage", limit: 3, metric: { fn: "count" } }), fmap);
    expect(q).toMatchObject({ groupBy: [{ fieldId: "fldClosed", bucket: "week" }, { fieldId: "fldStage" }], limit: undefined });
  });

  it("pie keeps the top 10 and folds the rest into Other", () => {
    const q = widgetQuery(base({ type: "pie", tableId: "tblA", groupFieldId: "fldStage", metric: { fn: "count" } }), fmap);
    expect(q).toMatchObject({ groupBy: [{ fieldId: "fldStage" }], sort: "value", limit: 10, other: true });
  });

  it("pivot groups rows then columns, sorted by key", () => {
    const q = widgetQuery(base({ type: "pivot", tableId: "tblA", rowFieldId: "fldStage", colFieldId: "fldClosed", colBucket: "year", metric: { fn: "count" } }), fmap);
    expect(q).toMatchObject({ groupBy: [{ fieldId: "fldStage" }, { fieldId: "fldClosed", bucket: "year" }], sort: "key" });
  });

  it("text widgets and incomplete widgets have no query", () => {
    expect(widgetQuery(base({ type: "text", text: "hi" }), fmap)).toBeNull();
    expect(widgetQuery(base({ type: "bar", tableId: "tblA", metric: { fn: "count" } }), fmap)).toBeNull();
    expect(widgetQuery(base({ tableId: "tblA" }), fmap)).toBeNull();
  });

  it("default sizes", () => {
    expect(defaultSize("metric")).toEqual({ w: 3, h: 2 });
    expect(defaultSize("text")).toEqual({ w: 4, h: 2 });
    expect(defaultSize("bar")).toEqual({ w: 6, h: 4 });
  });
});

describe("widget problems", () => {
  it("separates widgets still being set up from widgets whose source changed", () => {
    expect(widgetProblem(base({}), schema)).toEqual({ kind: "setup", message: "Choose a table" });
    expect(widgetProblem(base({ tableId: "tblA" }), schema)).toEqual({ kind: "setup", message: "Choose what to count" });
    expect(widgetProblem(base({ type: "bar", tableId: "tblA", metric: { fn: "count" } }), schema)).toEqual({ kind: "setup", message: "Choose a field to group by" });
    expect(widgetProblem(base({ tableId: "tblGone", metric: { fn: "count" } }), schema)).toEqual({ kind: "changed", message: "The table this widget uses no longer exists" });
    expect(widgetProblem(base({ tableId: "tblA", viewId: "viwGone", metric: { fn: "count" } }), schema)).toEqual({ kind: "changed", message: "The view this widget uses no longer exists" });
    expect(widgetProblem(base({ tableId: "tblA", metric: { fn: "sum", fieldId: "fldGone" } }), schema)).toEqual({ kind: "changed", message: "A field this widget uses no longer exists" });
    expect(widgetProblem(base({ tableId: "tblA", metric: { fn: "sum", fieldId: "fldName" } }), schema)).toEqual({ kind: "changed", message: 'sum needs a number field; "Name" is text' });
    expect(widgetProblem(base({ tableId: "tblA", dateFieldId: "fldAmount", metric: { fn: "count" } }), schema)).toEqual({ kind: "changed", message: "The date range field is not a date field" });
    expect(widgetProblem(base({ tableId: "tblA", filters: { conjunction: "and", conditions: [{ fieldId: "fldGone", op: "empty" }] }, metric: { fn: "count" } }), schema)).toEqual({ kind: "changed", message: "A field this widget uses no longer exists" });
    expect(widgetProblem(base({ tableId: "tblA", metric: { fn: "count" } }), schema)).toBeNull();
    expect(widgetProblem(base({ type: "text" }), schema)).toBeNull();
  });

  it("checkWidget rejects bad shapes and changed sources but allows unfinished widgets", () => {
    expect(checkWidget(base({ type: "map" as Widget["type"] }), schema)).toBe('Unknown widget type "map"');
    expect(checkWidget(base({ x: 10, w: 4 }), schema)).toBe("Widgets must fit in 12 columns");
    expect(checkWidget(base({ h: 13 }), schema)).toBe("Widget height must be 1 to 12 rows");
    expect(checkWidget(base({ x: 1.5 }), schema)).toBe("Widget position must be whole grid units");
    expect(checkWidget(base({ type: "text", text: "x".repeat(20 * 1024 + 1) }), schema)).toBe("Text blocks are limited to 20 KB");
    expect(checkWidget(base({ limit: 0 }), schema)).toBe("limit must be 1 to 1000");
    expect(checkWidget(base({ tableId: "tblA", metric: { fn: "sum", fieldId: "fldName" } }), schema)).toBe('sum needs a number field; "Name" is text');
    expect(checkWidget(base({}), schema)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/widgets.test.ts`
Expected: FAIL, cannot resolve `../../src/shared/widgets`.

- [ ] **Step 3: Add the shared types**

In `src/shared/types.ts`, after the `View` interface add:

```ts
export type AggFn = "count" | "countUnique" | "countEmpty" | "countFilled" | "sum" | "avg" | "min" | "max";
export type DateBucket = "day" | "week" | "month" | "year";

export type WidgetType = "metric" | "bar" | "line" | "pie" | "pivot" | "text";

export interface WidgetMetric {
  fn: AggFn;
  fieldId?: string;
}

/** One dashboard widget. Positions are 12-column grid units. Settings unused by the widget's type are ignored. */
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tableId?: string;
  viewId?: string;
  filters?: FilterSpec;
  /** The dashboard date range applies to this field; without it the widget ignores the range. */
  dateFieldId?: string;
  metric?: WidgetMetric;
  compare?: boolean; // metric: change against the previous period
  xFieldId?: string; // bar, line
  bucket?: DateBucket; // bar, line, pie: bucket of a date group field
  seriesFieldId?: string; // bar, line
  stacked?: boolean;
  horizontal?: boolean; // bar
  area?: boolean; // line
  sort?: "value" | "key";
  limit?: number;
  groupFieldId?: string; // pie
  donut?: boolean;
  rowFieldId?: string; // pivot
  colFieldId?: string;
  rowBucket?: DateBucket;
  colBucket?: DateBucket;
  text?: string; // text: Markdown
}

export interface Dashboard {
  id: string;
  name: string;
  ord: string;
  widgets: Widget[];
}
```

Add `dashboards: Dashboard[];` to `Schema` after `views`.

In `src/worker/base/aggregate.ts` replace the two type lines with:

```ts
import type { AggFn, DateBucket } from "../../shared/types";
export type { AggFn, DateBucket };
```

(merge the `AggFn, DateBucket` names into the existing `import type ... from "../../shared/types"` line instead of a second import). Also add to `AggregateInput`, after `fanOut`:

```ts
  /** Days (inclusive) on a date-like field, the same window rules as view ranges. */
  range?: { fieldId: string; from: string; to: string };
  /** "value" (default) orders by the first metric, largest first; "key" by group key, numbers and dates in order. */
  sort?: "value" | "key";
  /** Keep this many groups; with `other`, the rest fold into one group keyed OTHER_KEY. */
  limit?: number;
  other?: boolean;
```

In `src/shared/ids.ts` add:

```ts
export const newDashboardId = () => randomId("dsh");
export const newWidgetId = () => randomId("wgt", 10);
```

- [ ] **Step 4: Write `src/shared/widgets.ts`**

```ts
// Dashboard widgets: default sizes, the aggregate request each widget runs, and checks shared by the Worker and the client.
import type { DateBucket, Field, View, Widget, WidgetType } from "./types";
import { isDateField } from "./types";
import { validateAggregate, type AggregateInput } from "../worker/base/aggregate";

export const WIDGET_TYPES: WidgetType[] = ["metric", "bar", "line", "pie", "pivot", "text"];
export const GRID_COLS = 12;
export const MAX_WIDGETS = 30;
export const MAX_TEXT = 20 * 1024;
export const MAX_H = 12;
export const PIE_LIMIT = 10;

export type WidgetInput = Partial<Omit<Widget, "id">> & { type: WidgetType };
/** A partial widget; null removes a setting. */
export type WidgetPatch = { [K in keyof Omit<Widget, "id">]?: Widget[K] | null };
export interface LayoutItemInput {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function defaultSize(type: WidgetType): { w: number; h: number } {
  if (type === "metric") return { w: 3, h: 2 };
  if (type === "text") return { w: 4, h: 2 };
  return { w: 6, h: 4 };
}

export interface DateWindow {
  from: string;
  to: string;
}

/** The aggregate request behind a widget, or null for text widgets and widgets missing a required setting. */
export function widgetQuery(w: Widget, fields: Map<string, Field>, range?: DateWindow | null): AggregateInput | null {
  if (w.type === "text" || !w.tableId || !w.metric) return null;
  const q: AggregateInput = { viewId: w.viewId, filters: w.filters, metrics: [{ fn: w.metric.fn, fieldId: w.metric.fieldId, as: "v" }] };
  if (range && w.dateFieldId) q.range = { fieldId: w.dateFieldId, from: range.from, to: range.to };
  const by = (fieldId: string | undefined, bucket?: DateBucket) => {
    if (!fieldId) return undefined;
    const f = fields.get(fieldId);
    return { fieldId, bucket: f && isDateField(f) ? bucket ?? "month" : undefined };
  };
  switch (w.type) {
    case "metric":
      return q;
    case "bar":
    case "line": {
      const x = by(w.xFieldId, w.bucket);
      if (!x) return null;
      const series = by(w.seriesFieldId);
      return { ...q, groupBy: series ? [x, series] : [x], sort: w.sort ?? (x.bucket ? "key" : "value"), limit: series ? undefined : w.limit };
    }
    case "pie": {
      const g = by(w.groupFieldId, w.bucket);
      if (!g) return null;
      return { ...q, groupBy: [g], sort: "value", limit: w.limit ?? PIE_LIMIT, other: true };
    }
    case "pivot": {
      const r = by(w.rowFieldId, w.rowBucket);
      if (!r) return null;
      const c = by(w.colFieldId, w.colBucket);
      return { ...q, groupBy: c ? [r, c] : [r], sort: "key" };
    }
  }
}

export interface SchemaLike {
  tables: { id: string }[];
  views: View[];
  fields: Field[];
}

export interface WidgetProblem {
  /** setup: a required setting is not chosen yet; changed: something it used was deleted or no longer fits. */
  kind: "setup" | "changed";
  message: string;
}

const GROUP_FIELD: Partial<Record<WidgetType, keyof Widget>> = { bar: "xFieldId", line: "xFieldId", pie: "groupFieldId", pivot: "rowFieldId" };

export function widgetProblem(w: Widget, s: SchemaLike): WidgetProblem | null {
  if (w.type === "text") return null;
  if (!w.tableId) return { kind: "setup", message: "Choose a table" };
  if (!s.tables.some(t => t.id === w.tableId)) return { kind: "changed", message: "The table this widget uses no longer exists" };
  if (w.viewId && !s.views.some(v => v.id === w.viewId && v.tableId === w.tableId)) return { kind: "changed", message: "The view this widget uses no longer exists" };
  const fields = new Map(s.fields.filter(f => f.tableId === w.tableId).map(f => [f.id, f]));
  const used = [w.metric?.fieldId, w.xFieldId, w.seriesFieldId, w.groupFieldId, w.rowFieldId, w.colFieldId, ...(w.filters?.conditions.map(c => c.fieldId) ?? [])];
  if (used.some(id => id && !fields.has(id))) return { kind: "changed", message: "A field this widget uses no longer exists" };
  if (w.dateFieldId) {
    const d = fields.get(w.dateFieldId);
    if (!d) return { kind: "changed", message: "A field this widget uses no longer exists" };
    if (!isDateField(d)) return { kind: "changed", message: "The date range field is not a date field" };
  }
  if (!w.metric) return { kind: "setup", message: "Choose what to count" };
  const group = GROUP_FIELD[w.type];
  if (group && !w[group]) return { kind: "setup", message: "Choose a field to group by" };
  const q = widgetQuery(w, fields);
  const err = q && validateAggregate(fields, q);
  return err ? { kind: "changed", message: err } : null;
}

/** Returns why a widget cannot be saved, or null. Unfinished widgets are allowed; broken references are not. */
export function checkWidget(w: Widget, s: SchemaLike): string | null {
  if (!WIDGET_TYPES.includes(w.type)) return `Unknown widget type "${w.type}"`;
  if (typeof w.title !== "string" || w.title.length > 200) return "Widget titles are text up to 200 characters";
  if (![w.x, w.y, w.w, w.h].every(n => Number.isInteger(n))) return "Widget position must be whole grid units";
  if (w.w < 1 || w.x < 0 || w.x + w.w > GRID_COLS) return "Widgets must fit in 12 columns";
  if (w.h < 1 || w.h > MAX_H || w.y < 0 || w.y > 10000) return "Widget height must be 1 to 12 rows";
  if (w.text !== undefined && (typeof w.text !== "string" || new TextEncoder().encode(w.text).length > MAX_TEXT)) return "Text blocks are limited to 20 KB";
  if (w.limit !== undefined && (!Number.isInteger(w.limit) || w.limit < 1 || w.limit > 1000)) return "limit must be 1 to 1000";
  const p = widgetProblem(w, s);
  return p?.kind === "changed" ? p.message : null;
}
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx vitest run --project unit test/unit/widgets.test.ts && npm run typecheck`
Expected: tests PASS. Typecheck reports every place that builds a `Schema` without `dashboards`; fix each by adding `dashboards: []` (test fixtures) or, in `BaseStore.schema()`, temporarily `dashboards: []` (Task 5 replaces it). Re-run until clean.

- [ ] **Step 6: Checkpoint**

Run: `npm test 2>&1 | tail -5` and record the pass count in the ledger.

---

### Task 2: Aggregate range, key sort, top N and "Other"

**Files:**
- Modify: `src/worker/base/aggregate.ts`
- Modify: `src/worker/base/store.ts:418-425` (`aggregate`)
- Test: `test/worker/dashboards.test.ts` (new)

**Interfaces:**
- Consumes: `AggregateInput.range | sort | limit | other` (declared in Task 1).
- Produces: `OTHER_KEY = "__other__"`, `compareKeys(a: GroupKey[], b: GroupKey[]): number`, `Aggregator.keysOf(r: Row): GroupKey[][]`, `BaseStore.aggIds(tableId, input): number[]` (private helper used by Task 3).

- [ ] **Step 1: Write the failing tests**

Create `test/worker/dashboards.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { BaseStore } from "../../src/worker/base/store";

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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project worker test/worker/dashboards.test.ts`
Expected: FAIL. Range counts 7 (range ignored), key sort and limit not applied, validation messages missing. The UTC-day test may pass or fail depending on range support; it must pass after Step 3.

- [ ] **Step 3: Implement in `aggregate.ts`**

Add after `MAX_METRICS`:

```ts
export const OTHER_KEY = "__other__";
```

Add to `validateAggregate`, before the metric loop:

```ts
  if (input.sort !== undefined && input.sort !== "value" && input.sort !== "key") return 'sort must be "value" or "key"';
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_GROUPS)) return `limit must be 1 to ${MAX_GROUPS}`;
  if (input.other && (input.limit === undefined || (input.groupBy?.length ?? 0) !== 1)) return "other needs a limit and exactly one group field";
  if (input.range) {
    const f = fields.get(input.range.fieldId);
    if (!f || !isDateLike(f)) return "The range field must be a date field";
  }
```

Add key comparison after `desc`:

```ts
const collator = new Intl.Collator("en", { numeric: true });

function compareKey(a: GroupKey, b: GroupKey): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) - Number(b);
  const x = Number(a), y = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return collator.compare(a, b);
}

/** Orders group keys: numbers by value, text and dates naturally, booleans false first, empty last. */
export function compareKeys(a: GroupKey[], b: GroupKey[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = compareKey(a[i] ?? null, b[i] ?? null);
    if (c) return c;
  }
  return 0;
}

function merge(into: MetricAcc, a: MetricAcc) {
  into.count += a.count;
  into.sum += a.sum;
  if (a.min !== null && (into.min === null || a.min < into.min)) into.min = a.min;
  if (a.max !== null && (into.max === null || a.max > into.max)) into.max = a.max;
}
```

In `Aggregator`, split `add` so drill-down can reuse the keys:

```ts
  /** Every group key combination a row belongs to (one, or several when multi-value cells fan out). */
  keysOf(r: Row): GroupKey[][] {
    const lists = (this.input.groupBy ?? []).map(g => {
      const f = this.fields.get(g.fieldId)!;
      const raw = this.raw(f, r);
      return this.input.fanOut === false ? [rawKey(raw)] : groupKeys(f, raw, g.bucket, this.userName);
    });
    return product(lists);
  }

  add(rows: Row[]) {
    for (const r of rows) {
      this.total++;
      for (const key of this.keysOf(r)) {
        const k = JSON.stringify(key);
        let g = this.groups.get(k);
        if (!g) this.groups.set(k, (g = { key, m: this.input.metrics.map(newAcc) }));
        this.input.metrics.forEach((m, i) => this.addMetric(g!.m[i], m, r));
      }
    }
  }
```

Replace `result()`:

```ts
  result(): AggregateResult {
    if (!this.input.groupBy?.length && !this.groups.size) this.groups.set("[]", { key: [], m: this.input.metrics.map(newAcc) });
    const metrics = this.input.metrics;
    const valuesOf = (m: MetricAcc[]) => Object.fromEntries(metrics.map((x, i) => [x.as, finish(m[i], x)]));
    const list = [...this.groups.values()].map(g => ({ key: g.key, m: g.m, values: valuesOf(g.m) }));
    const first = metrics[0].as;
    if (this.input.sort === "key") list.sort((x, y) => compareKeys(x.key, y.key));
    else list.sort((x, y) => desc(x.values[first], y.values[first]) || (JSON.stringify(x.key) < JSON.stringify(y.key) ? -1 : 1));
    const cap = Math.min(this.input.limit ?? MAX_GROUPS, MAX_GROUPS);
    const rest = list.slice(cap);
    const groups: AggregateGroup[] = list.slice(0, cap).map(g => ({ key: g.key, values: g.values }));
    const out: AggregateResult = { groups, total: this.total };
    if (rest.length && this.input.other) {
      const m = metrics.map(newAcc);
      for (const g of rest) g.m.forEach((a, i) => merge(m[i], a));
      // Unique counts cannot be added up across groups without the values, so "Other" leaves them empty.
      groups.push({ key: [OTHER_KEY], values: Object.fromEntries(metrics.map((x, i) => [x.as, x.fn === "countUnique" ? null : finish(m[i], x)])) });
    } else if (rest.length) out.truncated = true;
    return out;
  }
```

In `store.ts`, add `OTHER_KEY` and `GroupKey` to the aggregate import, and replace `aggregate` with:

```ts
  /** Ids of the records an aggregate covers: the view, extra filters, search and date range, in view order. */
  private aggIds(tableId: string, input: AggregateInput): number[] {
    const range = input.range ? { startFieldId: input.range.fieldId, from: input.range.from, to: input.range.to } : undefined;
    return this.query(tableId, { viewId: input.viewId, extraFilters: input.filters, search: input.search, range, limit: 0 }).ids;
  }

  aggregate(tableId: string, input: AggregateInput): AggregateResult {
    const fields = this.fieldMap(tableId);
    const err = validateAggregate(fields, input);
    if (err) throw new UserError(err);
    const ids = this.aggIds(tableId, input);
    const agg = new Aggregator(fields, input, (f, r) => this.rawFromRow(f, r), this.userName);
    for (let i = 0; i < ids.length; i += 1000) agg.add(this.getRows(tableId, ids.slice(i, i + 1000)));
    return agg.result();
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/worker/dashboards.test.ts test/worker/engine.test.ts`
Expected: PASS, including the existing aggregate tests in `engine.test.ts` ("rejects bad metrics and caps groups" still sees `truncated` at 1,000 groups).

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`; ledger the count.

---

### Task 3: Drill-down to the records behind a number

**Files:**
- Modify: `src/worker/base/store.ts` (new `aggregateRecords`)
- Modify: `src/worker/base-do.ts` (RPC method)
- Modify: `src/worker/access.ts:12` (`BaseStub` keys)
- Modify: `src/worker/index.ts` (route after `/aggregate`)
- Test: `test/worker/dashboards.test.ts`

**Interfaces:**
- Consumes: `Aggregator.keysOf`, `OTHER_KEY`, `aggIds` (Task 2).
- Produces: `BaseStore.aggregateRecords(tableId, input, key: GroupKey[], max = 500): { ids: number[]; truncated: boolean }`; `BaseDO.aggregateRecords(tableId, input, key)` returning `Result<...>`; `POST /api/bases/:base/aggregate/records` with body `{ tableId, key, ...AggregateInput }` (read access).

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/dashboards.test.ts` (add `import { HttpClient, ownerWithBase, signup } from "./helpers";` at the top):

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project worker test/worker/dashboards.test.ts -t drill`
Expected: FAIL, `s.aggregateRecords is not a function` and a 404 from the route.

- [ ] **Step 3: Implement**

`store.ts`, after `aggregate`:

```ts
  /** Records counted in one aggregate group, in view order. Uses the aggregate's own grouping so the list matches its number. */
  aggregateRecords(tableId: string, input: AggregateInput, key: GroupKey[], max = 500): { ids: number[]; truncated: boolean } {
    const fields = this.fieldMap(tableId);
    const err = validateAggregate(fields, input);
    if (err) throw new UserError(err);
    const other = Array.isArray(key) && key.length === 1 && key[0] === OTHER_KEY;
    if (!Array.isArray(key) || (!other && key.length !== (input.groupBy?.length ?? 0))) throw new UserError("key must have one value per group field");
    // "Other" holds every record with a key outside the groups the aggregate kept.
    const kept = other ? new Set(this.aggregate(tableId, input).groups.filter(g => g.key[0] !== OTHER_KEY).map(g => JSON.stringify(g.key))) : null;
    const want = JSON.stringify(key);
    const agg = new Aggregator(fields, input, (f, r) => this.rawFromRow(f, r), this.userName);
    const ids = this.aggIds(tableId, input);
    const out: number[] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      for (const r of this.getRows(tableId, ids.slice(i, i + 1000))) {
        const keys = agg.keysOf(r).map(k => JSON.stringify(k));
        if (!(kept ? keys.some(k => !kept.has(k)) : keys.includes(want))) continue;
        if (out.length === max) return { ids: out, truncated: true };
        out.push(r.id);
      }
    }
    return { ids: out, truncated: false };
  }
```

`base-do.ts`, after `aggregate` (import `GroupKey` with `AggregateInput`):

```ts
  aggregateRecords(tableId: string, input: AggregateInput, key: GroupKey[]): Result<{ ids: number[]; truncated: boolean }> {
    return this.safe(() => this.store.aggregateRecords(tableId, input, key));
  }
```

`access.ts`: add `"aggregateRecords"` to the `BaseStub` key list after `"aggregate"`.

`index.ts`, after the `/aggregate` route:

```ts
app.post("/api/bases/:base/aggregate/records", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const b = await body<{ tableId: string; key: import("./base/aggregate").GroupKey[] } & import("./base/aggregate").AggregateInput>(c);
  return c.json(unwrap(await a.stub.aggregateRecords(b.tableId, b, b.key)));
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/worker/dashboards.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`; ledger the count.

---

### Task 4: Aggregate result cache

**Files:**
- Modify: `src/worker/base/store.ts`
- Test: `test/worker/dashboards.test.ts`

**Interfaces:**
- Produces: `BaseStore.clearAggCache(): void` (used by the bench in Task 10). `aggregate` returns the same object for a repeated identical request until the base changes.

- [ ] **Step 1: Write the tests**

Append:

```ts
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
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run --project worker test/worker/dashboards.test.ts -t "aggregate cache"`
Expected: "returns the stored result" FAILS on `toBe(a)` (no cache yet). The filters and rollup tests pass now; they are guards that must stay green once the cache exists (a per-table cache would fail the rollup test).

- [ ] **Step 3: Implement**

In `BaseStore`, add fields and helpers near `cache`:

```ts
  /** Aggregate results by table and request; any write or schema change in the base clears it (rollups and lookups cross tables). */
  private aggCache = new Map<string, AggregateResult>();

  clearAggCache() {
    this.aggCache.clear();
  }
```

Add a module-level helper near `same`:

```ts
const AGG_CACHE_SIZE = 200;
/** JSON with object keys sorted, so equal requests built in a different key order share a cache entry. */
const stableJson = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
```

In `aggregate`, after validation:

```ts
    const { viewId, filters, search, groupBy, metrics, fanOut, range, sort, limit, other } = input;
    const key = tableId + " " + stableJson({ viewId, filters, search, groupBy, metrics, fanOut, range, sort, limit, other });
    const hit = this.aggCache.get(key);
    if (hit) {
      this.aggCache.delete(key);
      this.aggCache.set(key, hit);
      return hit;
    }
```

and before returning, store the result:

```ts
    const result = agg.result();
    this.aggCache.set(key, result);
    if (this.aggCache.size > AGG_CACHE_SIZE) this.aggCache.delete(this.aggCache.keys().next().value!);
    return result;
```

Clear it in: `invalidate()` (add `this.aggCache.clear();`), `bumpVersion()` (already calls `invalidate`), `setMembers()` (user names label groups), and `run()` right after `this.storage.transactionSync(...)` returns. Every row write (create, update, delete, move, jobs, imports) goes through `run()`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/worker/dashboards.test.ts test/worker/engine.test.ts test/worker/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`; ledger the count.

---

### Task 5: Dashboard storage and schema ops

**Files:**
- Modify: `src/worker/base/store.ts`
- Modify: `src/worker/base-do.ts` (`SchemaOp`, `schemaOp`)
- Test: `test/worker/dashboards.test.ts`

**Interfaces:**
- Consumes: `checkWidget`, `defaultSize`, `MAX_WIDGETS`, `WidgetInput`, `WidgetPatch`, `LayoutItemInput`, `widgetProblem` (Task 1); `newDashboardId`, `newWidgetId`.
- Produces on `BaseStore`: `createDashboard(input: { name: string; widgets?: WidgetInput[] }): { dashboardId: string; schema: Schema }`, `updateDashboard(id, patch: { name?: string; ord?: string }): Schema`, `deleteDashboard(id): Schema`, `addWidget(dashboardId, input: WidgetInput): { widgetId: string; schema: Schema }`, `updateWidget(dashboardId, widgetId, patch: WidgetPatch): Schema`, `removeWidget(dashboardId, widgetId): Schema`, `setLayout(dashboardId, items: LayoutItemInput[]): Schema`, `dashboard(id): Dashboard`.
- Produces `SchemaOp` members: `createDashboard { name; widgets? }` (returns id), `updateDashboard { dashboardId; name?; ord? }`, `deleteDashboard { dashboardId }`, `addWidget { dashboardId; widget }` (returns id), `updateWidget { dashboardId; widgetId; patch }`, `removeWidget { dashboardId; widgetId }`, `setLayout { dashboardId; items }`.

- [ ] **Step 1: Write the failing tests**

Append (add `widgetProblem` import from `../../src/shared/widgets`):

```ts
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
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project worker test/worker/dashboards.test.ts -t dashboard`
Expected: FAIL, `s.createDashboard is not a function` and a 400 "unknown op" style error over HTTP.

- [ ] **Step 3: Implement storage**

`store.ts`:

1. Imports: add `Dashboard, Widget` to the shared types import; `newDashboardId, newWidgetId` to the ids import; and `import { checkWidget, defaultSize, MAX_WIDGETS, type LayoutItemInput, type WidgetInput, type WidgetPatch } from "../../shared/widgets";`.
2. Constructor: `this.sql.exec(\`CREATE TABLE IF NOT EXISTS _dashboards (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord TEXT NOT NULL, config TEXT NOT NULL)\`);`
3. `Cache` gets `dashboards: Map<string, Dashboard>;`. In `loadCache`:

```ts
    const dashboards = new Map<string, Dashboard>();
    for (const d of this.all<{ id: string; name: string; ord: string; config: string }>("SELECT * FROM _dashboards ORDER BY ord")) {
      dashboards.set(d.id, { id: d.id, name: d.name, ord: d.ord, widgets: (JSON.parse(d.config) as { widgets?: Widget[] }).widgets ?? [] });
    }
```

and include `dashboards` in the returned object.
4. `schema()` returns `dashboards: [...c.dashboards.values()]` (replacing the Task 1 placeholder).
5. New section after the views section:

```ts
  // ---------- schema: dashboards ----------

  dashboard(id: string): Dashboard {
    const d = this.c.dashboards.get(id);
    if (!d) throw new UserError("Dashboard not found");
    return d;
  }

  private schemaLike() {
    const c = this.c;
    return { tables: [...c.tables.values()], views: [...c.views.values()], fields: [...c.fields.values()] };
  }

  private checked(w: Widget): Widget {
    const err = checkWidget(w, this.schemaLike());
    if (err) throw new UserError(err);
    return w;
  }

  /** A new widget from caller input: its own id, default size, placed below the existing widgets unless positioned. */
  private newWidget(existing: Widget[], input: WidgetInput): Widget {
    const bottom = existing.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    const clean = Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== "id" && v !== null && v !== undefined));
    return this.checked({ title: "", x: 0, y: bottom, ...defaultSize(input.type), ...clean, id: newWidgetId() } as Widget);
  }

  private saveWidgets(id: string, widgets: Widget[]): Schema {
    if (widgets.length > MAX_WIDGETS) throw new UserError(`A dashboard holds at most ${MAX_WIDGETS} widgets`);
    this.sql.exec("UPDATE _dashboards SET config = ? WHERE id = ?", JSON.stringify({ widgets }), id);
    this.bumpVersion();
    return this.schema();
  }

  createDashboard(input: { name: string; widgets?: WidgetInput[] }): { dashboardId: string; schema: Schema } {
    const widgets: Widget[] = [];
    for (const w of input.widgets ?? []) widgets.push(this.newWidget(widgets, w));
    if (widgets.length > MAX_WIDGETS) throw new UserError(`A dashboard holds at most ${MAX_WIDGETS} widgets`);
    const id = newDashboardId();
    const last = this.one<{ o: string | null }>("SELECT max(ord) o FROM _dashboards")?.o ?? null;
    this.sql.exec("INSERT INTO _dashboards (id, name, ord, config) VALUES (?, ?, ?, ?)", id, input.name?.trim() || "Dashboard", generateKeyBetween(last, null), JSON.stringify({ widgets }));
    this.bumpVersion();
    return { dashboardId: id, schema: this.schema() };
  }

  updateDashboard(id: string, patch: { name?: string; ord?: string }): Schema {
    const d = this.dashboard(id);
    if (patch.name !== undefined) this.sql.exec("UPDATE _dashboards SET name = ? WHERE id = ?", patch.name.trim() || d.name, id);
    if (patch.ord !== undefined) this.sql.exec("UPDATE _dashboards SET ord = ? WHERE id = ?", String(patch.ord), id);
    this.bumpVersion();
    return this.schema();
  }

  deleteDashboard(id: string): Schema {
    this.dashboard(id);
    this.sql.exec("DELETE FROM _dashboards WHERE id = ?", id);
    this.bumpVersion();
    return this.schema();
  }

  addWidget(dashboardId: string, input: WidgetInput): { widgetId: string; schema: Schema } {
    const d = this.dashboard(dashboardId);
    const w = this.newWidget(d.widgets, input);
    return { widgetId: w.id, schema: this.saveWidgets(d.id, [...d.widgets, w]) };
  }

  /** Merges a patch into one widget; other widgets are untouched, so editors working on different widgets do not collide. */
  updateWidget(dashboardId: string, widgetId: string, patch: WidgetPatch): Schema {
    const d = this.dashboard(dashboardId);
    const i = d.widgets.findIndex(w => w.id === widgetId);
    if (i < 0) throw new UserError("Widget not found");
    const next: Record<string, unknown> = { ...d.widgets[i] };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (k === "id") continue;
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const w = this.checked(next as unknown as Widget);
    return this.saveWidgets(d.id, d.widgets.map((x, j) => (j === i ? w : x)));
  }

  removeWidget(dashboardId: string, widgetId: string): Schema {
    const d = this.dashboard(dashboardId);
    return this.saveWidgets(d.id, d.widgets.filter(w => w.id !== widgetId));
  }

  /** Moves and resizes widgets; only positions change, and ids no longer on the dashboard are ignored. */
  setLayout(dashboardId: string, items: LayoutItemInput[]): Schema {
    const d = this.dashboard(dashboardId);
    const pos = new Map((Array.isArray(items) ? items : []).map(p => [p.id, p]));
    const widgets = d.widgets.map(w => {
      const p = pos.get(w.id);
      return p ? this.checked({ ...w, x: p.x, y: p.y, w: p.w, h: p.h }) : w;
    });
    return this.saveWidgets(d.id, widgets);
  }
```

`base-do.ts`: import `WidgetInput, WidgetPatch, LayoutItemInput` from `../shared/widgets`; extend `SchemaOp`:

```ts
  | { op: "createDashboard"; name: string; widgets?: WidgetInput[] }
  | { op: "updateDashboard"; dashboardId: string; name?: string; ord?: string }
  | { op: "deleteDashboard"; dashboardId: string }
  | { op: "addWidget"; dashboardId: string; widget: WidgetInput }
  | { op: "updateWidget"; dashboardId: string; widgetId: string; patch: WidgetPatch }
  | { op: "removeWidget"; dashboardId: string; widgetId: string }
  | { op: "setLayout"; dashboardId: string; items: LayoutItemInput[] };
```

and the switch in `schemaOp`:

```ts
        case "createDashboard": {
          const r = s.createDashboard({ name: op.name, widgets: op.widgets });
          return { schema: r.schema, id: r.dashboardId };
        }
        case "updateDashboard":
          return { schema: s.updateDashboard(op.dashboardId, { name: op.name, ord: op.ord }) };
        case "deleteDashboard":
          return { schema: s.deleteDashboard(op.dashboardId) };
        case "addWidget": {
          const r = s.addWidget(op.dashboardId, op.widget);
          return { schema: r.schema, id: r.widgetId };
        }
        case "updateWidget":
          return { schema: s.updateWidget(op.dashboardId, op.widgetId, op.patch) };
        case "removeWidget":
          return { schema: s.removeWidget(op.dashboardId, op.widgetId) };
        case "setLayout":
          return { schema: s.setLayout(op.dashboardId, op.items) };
```

If the switch has no `default`, add `default: throw new UserError("Unknown schema operation");` so a bad `op` is a 400, not a 500.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/worker/dashboards.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`; ledger the count.

---

### Task 6: MCP dashboard tools

**Files:**
- Create: `src/worker/mcp/tools-dashboard.ts`
- Modify: `src/worker/mcp/server.ts` (register; mention dashboards in `INSTRUCTIONS`)
- Modify: `docs/mcp.md` (tool list)
- Test: `test/worker/mcp-dashboards.test.ts`

**Interfaces:**
- Consumes: schema ops from Task 5, `widgetQuery`, `widgetProblem` (Task 1), `tableOf`, `fieldsOf`, `fieldOf` (`records.ts`), `toFilterSpec`, `viewOf` (`translate.ts`), `filterSchema` (`schemas.ts`), `guard` (`result.ts`), `baseAccess`, `workspaceMembers` (`access.ts`).
- Produces tools: `list_dashboards { baseId }`, `get_dashboard { baseId, dashboard }`, `create_dashboard { baseId, name, widgets? }`, `update_dashboard { baseId, dashboard, name?, add?, update?, remove? }`. Widget input fields: `type, title, table, view, filter, dateField, metric {fn, field}, compare, x, bucket, series, stacked, horizontal, area, sort, limit, group, donut, rows, columns, rowBucket, columnBucket, text, position {x,y,w,h}`; in `update` items also `id`. Output widgets use the same names plus `id`, `position`, `problem` (string or absent) and, in `get_dashboard`, `data` (aggregate result, at most 100 groups, `truncated` when cut).

- [ ] **Step 1: Write the failing tests**

`test/worker/mcp-dashboards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addViewer, call, mcpClient, ownerWithBase } from "./helpers";

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("MCP dashboard tools", () => {
  it("creates a dashboard by names and reads live numbers back", async () => {
    const { token, baseId } = await ownerWithBase("mcp-dash");
    const client = await mcpClient(token);
    const created = await call(client, "create_dashboard", {
      baseId,
      name: "Pipeline",
      widgets: [
        { type: "metric", title: "Deals", table: "Deals", metric: { fn: "count" } },
        { type: "bar", title: "Amount by stage", table: "Deals", x: "Stage", metric: { fn: "sum", field: "Amount" } },
        { type: "text", text: "# Notes" },
      ],
    });
    expect(created.isError).toBeFalsy();
    const id = created.structuredContent.dashboard.id;
    const got = await call(client, "get_dashboard", { baseId, dashboard: "Pipeline" });
    const [metric, bar, note] = got.structuredContent.dashboard.widgets;
    expect(metric).toMatchObject({ type: "metric", table: "Deals", metric: { fn: "count" }, position: { x: 0, y: 0, w: 3, h: 2 } });
    expect(metric.data.groups[0].values.v).toBe(30);
    expect(bar).toMatchObject({ x: "Stage", metric: { fn: "sum", field: "Amount" } });
    const agg = await call(client, "aggregate", { baseId, table: "Deals", groupBy: [{ field: "Stage" }], metrics: [{ fn: "sum", field: "Amount", as: "v" }] });
    expect(bar.data.groups).toEqual(agg.structuredContent.groups);
    expect(note).toMatchObject({ type: "text", text: "# Notes" });
    expect(note.data).toBeUndefined();
    const list = await call(client, "list_dashboards", { baseId });
    expect(list.structuredContent.dashboards).toEqual([{ id, name: "Pipeline", widgets: 3 }]);
  });

  it("updates a dashboard: rename, edit and move, remove, add", async () => {
    const { token, baseId } = await ownerWithBase("mcp-dash-update");
    const client = await mcpClient(token);
    const created = await call(client, "create_dashboard", { baseId, name: "P", widgets: [{ type: "metric", table: "Deals", metric: { fn: "count" } }, { type: "text", text: "x" }] });
    const [m, t] = created.structuredContent.dashboard.widgets;
    const r = await call(client, "update_dashboard", {
      baseId,
      dashboard: "P",
      name: "Sales",
      update: [{ id: m.id, title: "All deals", position: { x: 6, y: 0, w: 6, h: 2 } }],
      remove: [t.id],
      add: [{ type: "pie", table: "Deals", group: "Stage", metric: { fn: "count" }, donut: true }],
    });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent.dashboard;
    expect(d.name).toBe("Sales");
    expect(d.widgets.map((w: { type: string }) => w.type)).toEqual(["metric", "pie"]);
    expect(d.widgets[0]).toMatchObject({ title: "All deals", position: { x: 6, y: 0, w: 6, h: 2 } });
    expect(d.widgets[1]).toMatchObject({ group: "Stage", donut: true });
  });

  it("explains bad names and refuses viewers", async () => {
    const { c, wsId, token, baseId } = await ownerWithBase("mcp-dash-errors");
    const client = await mcpClient(token);
    const bad = await call(client, "create_dashboard", { baseId, name: "X", widgets: [{ type: "bar", table: "Deals", x: "Stagee", metric: { fn: "count" } }] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('Unknown field "Stagee" in table Deals. Fields: Name, Company, Stage');
    const viewer = await mcpClient(await addViewer(c, wsId, "mcp-dash-viewer@example.com"));
    const denied = await call(viewer, "create_dashboard", { baseId, name: "Y" });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toBe("You have read-only access to this base");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project worker test/worker/mcp-dashboards.test.ts`
Expected: FAIL, tool `create_dashboard` not found.

- [ ] **Step 3: Implement `tools-dashboard.ts`**

```ts
// Dashboard tools: list, read with live numbers, create and edit widgets using table and field names.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Dashboard, DateBucket, Field, Member, Schema, Widget, WidgetType } from "../../shared/types";
import { widgetProblem, widgetQuery, WIDGET_TYPES, type WidgetInput, type WidgetPatch } from "../../shared/widgets";
import { baseAccess, HttpError, workspaceMembers, type AppContext, type BaseAccess } from "../access";
import type { SchemaOp } from "../base-do";
import { fieldOf, fieldsOf, tableOf, unwrap, type TableCtx } from "../records";
import { guard } from "./result";
import { filterSchema, type FilterInput } from "./schemas";
import { toFilterSpec, viewOf } from "./translate";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const BUCKETS = ["day", "week", "month", "year"] as const;
const FNS = ["count", "countUnique", "countEmpty", "countFilled", "sum", "avg", "min", "max"] as const;
const MAX_DATA_GROUPS = 100;

const position = z.object({ x: z.number().int().min(0).max(11), y: z.number().int().min(0), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(12) });

const widgetShape = {
  type: z.enum(WIDGET_TYPES as [WidgetType, ...WidgetType[]]),
  title: z.string().max(200).optional(),
  table: z.string().optional().describe("Table name or id (not needed for text)"),
  view: z.string().optional().describe("Use this view's filters"),
  filter: filterSchema.optional(),
  dateField: z.string().optional().describe("Date field the dashboard date range applies to"),
  metric: z.object({ fn: z.enum(FNS), field: z.string().optional() }).optional().describe("What each number is; count needs no field"),
  compare: z.boolean().optional().describe("metric: show change against the previous period"),
  x: z.string().optional().describe("bar, line: category or date field"),
  bucket: z.enum(BUCKETS).optional().describe("Bucket for a date x or group field (default month)"),
  series: z.string().optional().describe("bar, line: second field, one series per value"),
  stacked: z.boolean().optional(),
  horizontal: z.boolean().optional(),
  area: z.boolean().optional(),
  sort: z.enum(["value", "key"]).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  group: z.string().optional().describe("pie: group field"),
  donut: z.boolean().optional(),
  rows: z.string().optional().describe("pivot: row field"),
  columns: z.string().optional().describe("pivot: column field"),
  rowBucket: z.enum(BUCKETS).optional(),
  columnBucket: z.enum(BUCKETS).optional(),
  text: z.string().optional().describe("text: Markdown"),
  position: position.optional(),
};
const widgetSchema = z.object(widgetShape);
const widgetUpdateSchema = z.object({ ...widgetShape, id: z.string(), type: widgetShape.type.optional() });
type WidgetIn = z.infer<typeof widgetSchema>;
type WidgetUpdateIn = z.infer<typeof widgetUpdateSchema>;

interface Ctx {
  a: BaseAccess;
  schema: Schema;
  members: Map<string, Member>;
  origin: string;
}

async function ctxFor(c: AppContext, baseId: string, need: "read" | "write"): Promise<Ctx> {
  const a = await baseAccess(c, baseId, need);
  const members = new Map((await workspaceMembers(c.env, a.base.workspace_id)).map(m => [m.id, m]));
  return { a, schema: await a.stub.schema(), members, origin: new URL(c.req.url).origin };
}

function tableCtx(x: Ctx, key: string): TableCtx {
  const table = tableOf(x.schema, key);
  return { a: x.a, schema: x.schema, table, fields: fieldsOf(x.schema, table.id), members: x.members, origin: x.origin };
}

function dashboardOf(schema: Schema, key: string): Dashboard {
  const d = schema.dashboards.find(d => d.id === key) ?? schema.dashboards.find(d => d.name.toLowerCase() === key.toLowerCase());
  if (!d) throw new HttpError(404, `Dashboard "${key}" not found. Dashboards: ${schema.dashboards.map(d => d.name).join(", ") || "none"}`);
  return d;
}

/** Name-based input to stored widget settings. Only keys present in the input are returned. */
function toWidget(x: Ctx, w: Partial<WidgetIn>, current?: Widget): WidgetInput | WidgetPatch {
  const out: Record<string, unknown> = {};
  if (w.type) out.type = w.type;
  if (w.title !== undefined) out.title = w.title;
  if (w.text !== undefined) out.text = w.text;
  const tableKey = w.table ?? current?.tableId;
  const t = tableKey ? tableCtx(x, tableKey) : undefined;
  const f = (name: string) => {
    if (!t) throw new HttpError(422, "Choose a table before naming fields");
    return fieldOf(t.fields, name, t.table.name).id;
  };
  if (w.table !== undefined) out.tableId = t!.table.id;
  if (w.view !== undefined) out.viewId = viewOf(t!, w.view).id;
  if (w.filter !== undefined) out.filters = toFilterSpec(t!, w.filter as FilterInput);
  if (w.dateField !== undefined) out.dateFieldId = f(w.dateField);
  if (w.metric !== undefined) out.metric = { fn: w.metric.fn, fieldId: w.metric.field ? f(w.metric.field) : undefined };
  if (w.x !== undefined) out.xFieldId = f(w.x);
  if (w.series !== undefined) out.seriesFieldId = f(w.series);
  if (w.group !== undefined) out.groupFieldId = f(w.group);
  if (w.rows !== undefined) out.rowFieldId = f(w.rows);
  if (w.columns !== undefined) out.colFieldId = f(w.columns);
  if (w.bucket !== undefined) out.bucket = w.bucket;
  if (w.rowBucket !== undefined) out.rowBucket = w.rowBucket;
  if (w.columnBucket !== undefined) out.colBucket = w.columnBucket;
  for (const k of ["compare", "stacked", "horizontal", "area", "sort", "limit", "donut"] as const) if (w[k] !== undefined) out[k] = w[k];
  if (w.position) Object.assign(out, w.position);
  return out as WidgetInput;
}

function describeWidget(schema: Schema, w: Widget) {
  const name = (id?: string) => (id ? schema.fields.find(f => f.id === id)?.name ?? id : undefined);
  const out: Record<string, unknown> = { id: w.id, type: w.type, title: w.title, position: { x: w.x, y: w.y, w: w.w, h: w.h } };
  if (w.tableId) out.table = schema.tables.find(t => t.id === w.tableId)?.name ?? w.tableId;
  if (w.viewId) out.view = schema.views.find(v => v.id === w.viewId)?.name ?? w.viewId;
  if (w.filters?.conditions.length) out.filter = { conjunction: w.filters.conjunction, conditions: w.filters.conditions.map(c => ({ field: name(c.fieldId), op: c.op, value: c.value })) };
  if (w.dateFieldId) out.dateField = name(w.dateFieldId);
  if (w.metric) out.metric = w.metric.fieldId ? { fn: w.metric.fn, field: name(w.metric.fieldId) } : { fn: w.metric.fn };
  const pairs: [string, string | undefined][] = [["x", w.xFieldId], ["series", w.seriesFieldId], ["group", w.groupFieldId], ["rows", w.rowFieldId], ["columns", w.colFieldId]];
  for (const [k, id] of pairs) if (id) out[k] = name(id);
  for (const k of ["bucket", "rowBucket", "compare", "stacked", "horizontal", "area", "sort", "limit", "donut", "text"] as const) if (w[k] !== undefined) out[k] = w[k];
  if (w.colBucket) out.columnBucket = w.colBucket;
  const p = widgetProblem(w, schema);
  if (p) out.problem = p.message;
  return out;
}

function describeDashboard(schema: Schema, d: Dashboard) {
  return { id: d.id, name: d.name, widgets: d.widgets.map(w => describeWidget(schema, w)) };
}

async function op(a: BaseAccess, o: SchemaOp): Promise<{ schema: Schema; id?: string }> {
  return unwrap(await a.stub.schemaOp(a.actor, o));
}

export function registerDashboardTools(server: McpServer, c: AppContext) {
  server.registerTool(
    "list_dashboards",
    { title: "List dashboards", description: "Dashboards of a base with their widget counts.", inputSchema: { baseId: z.string() }, annotations: READ },
    guard(async (args: { baseId: string }) => {
      const x = await ctxFor(c, args.baseId, "read");
      return { dashboards: x.schema.dashboards.map(d => ({ id: d.id, name: d.name, widgets: d.widgets.length })) };
    }),
  );

  server.registerTool(
    "get_dashboard",
    {
      title: "Get dashboard",
      description: "A dashboard's widgets with their settings (table and field names) and each widget's current numbers over all time. Widgets with a problem (deleted field, unfinished) say so and carry no data.",
      inputSchema: { baseId: z.string(), dashboard: z.string().describe("Dashboard name or id") },
      annotations: READ,
    },
    guard(async (args: { baseId: string; dashboard: string }) => {
      const x = await ctxFor(c, args.baseId, "read");
      const d = dashboardOf(x.schema, args.dashboard);
      const out = describeDashboard(x.schema, d);
      for (const [i, w] of d.widgets.entries()) {
        if (widgetProblem(w, x.schema) || !w.tableId) continue;
        const fields = new Map<string, Field>(fieldsOf(x.schema, w.tableId).map(f => [f.id, f]));
        const q = widgetQuery(w, fields);
        if (!q) continue;
        const r = unwrap(await x.a.stub.aggregate(w.tableId, q));
        const cut = r.groups.length > MAX_DATA_GROUPS;
        (out.widgets[i] as Record<string, unknown>).data = { ...r, groups: r.groups.slice(0, MAX_DATA_GROUPS), truncated: r.truncated || cut || undefined };
      }
      return { dashboard: out };
    }),
  );

  server.registerTool(
    "create_dashboard",
    {
      title: "Create dashboard",
      description:
        "Create a dashboard, optionally with widgets. Widget types: metric (one number), bar, line, pie, pivot (summary table), text (Markdown). " +
        "Charts group by a field (x for bar and line, group for pie, rows and columns for pivot); date fields are bucketed by month unless bucket says otherwise. " +
        "metric is what each number is: count, or sum/avg/min/max of a field. Widgets without a position stack below each other on a 12-column grid.",
      inputSchema: { baseId: z.string(), name: z.string().min(1), widgets: z.array(widgetSchema).max(30).optional() },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; name: string; widgets?: WidgetIn[] }) => {
      const x = await ctxFor(c, args.baseId, "write");
      const widgets = (args.widgets ?? []).map(w => toWidget(x, w) as WidgetInput);
      const r = await op(x.a, { op: "createDashboard", name: args.name, widgets });
      return { dashboard: describeDashboard(r.schema, dashboardOf(r.schema, r.id!)) };
    }),
  );

  server.registerTool(
    "update_dashboard",
    {
      title: "Update dashboard",
      description:
        "Rename a dashboard and add, change, move or remove widgets. update items name a widget id (from get_dashboard) and only the settings you pass change; position moves or resizes it. " +
        "Names are checked before anything is written; changes then apply in order: rename, remove, update, add.",
      inputSchema: {
        baseId: z.string(),
        dashboard: z.string().describe("Dashboard name or id"),
        name: z.string().min(1).optional(),
        add: z.array(widgetSchema).max(30).optional(),
        update: z.array(widgetUpdateSchema).max(30).optional(),
        remove: z.array(z.string()).max(30).optional().describe("Widget ids"),
      },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; dashboard: string; name?: string; add?: WidgetIn[]; update?: WidgetUpdateIn[]; remove?: string[] }) => {
      const x = await ctxFor(c, args.baseId, "write");
      const d = dashboardOf(x.schema, args.dashboard);
      const updates = (args.update ?? []).map(u => {
        const cur = d.widgets.find(w => w.id === u.id);
        if (!cur) throw new HttpError(404, `Widget ${u.id} is not on dashboard "${d.name}"`);
        const { id, ...rest } = u;
        return { id, patch: toWidget(x, rest, cur) as WidgetPatch };
      });
      const adds = (args.add ?? []).map(w => toWidget(x, w) as WidgetInput);
      const steps: SchemaOp[] = [];
      if (args.name) steps.push({ op: "updateDashboard", dashboardId: d.id, name: args.name });
      for (const id of args.remove ?? []) steps.push({ op: "removeWidget", dashboardId: d.id, widgetId: id });
      for (const u of updates) steps.push({ op: "updateWidget", dashboardId: d.id, widgetId: u.id, patch: u.patch });
      for (const w of adds) steps.push({ op: "addWidget", dashboardId: d.id, widget: w });
      let schema = x.schema;
      for (const [i, s] of steps.entries()) {
        try {
          schema = (await op(x.a, s)).schema;
        } catch (e) {
          if (e instanceof HttpError && i > 0) throw new HttpError(e.status, `Stopped after ${i} of ${steps.length} changes: ${e.message}`);
          throw e;
        }
      }
      return { dashboard: describeDashboard(schema, dashboardOf(schema, d.id)) };
    }),
  );
}
```

Register in `server.ts` (`registerDashboardTools(server, c);`) and append to `INSTRUCTIONS`: `" Dashboards: get_dashboard shows each widget with its current numbers; create_dashboard and update_dashboard build them by table and field names."`. Check `BaseAccess` exposes `base.workspace_id` (as `loadTable` uses it); if the access helper names differ, follow `records.ts:loadTable`.

Add a "Dashboards" section to `docs/mcp.md` listing the four tools and the widget input fields, in the same style as the existing tool list.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project worker test/worker/mcp-dashboards.test.ts test/worker/mcp.test.ts && npm run typecheck`
Expected: PASS. If `mcp.test.ts` counts the tool list, update that count by 4 (ledger it as a ruling only if the test asserts an exact list).

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`; ledger the count.

---

### Task 7: Client logic modules (pure)

**Files:**
- Create: `src/web/dash/dateRange.ts`, `src/web/dash/series.ts`, `src/web/dash/layout.ts`, `src/web/dash/edit.ts`, `src/web/dash/markdown.ts`
- Test: `test/unit/dash.test.ts`

**Interfaces:**
- Consumes: `bucketDate`, `compareKeys`, `OTHER_KEY`, `AggregateResult`, `GroupKey` (`aggregate.ts`), date helpers from `src/web/base/dates.ts`, `displayCell`, `isDateField`, `isNumberField`, `WIDGET_TYPES`, `WidgetInput`, `WidgetPatch`, `LayoutItemInput`.
- Produces:
  - `dateRange.ts`: `RangePreset`, `DayRange`, `PRESET_LABELS`, `presetRange(p, today, custom?)`, `previousRange(p, r)`.
  - `series.ts`: `CHART_COLORS`, `nextBucket`, `bucketsBetween(fromKey, toKey, bucket)`, `keyLabel(k, bucket?)`, `deepen(hex)`, `colorFor(field, key, i)`, `ChartData`, `chartData(res, opts)`, `drillKey(data, twoLevels, seriesIndex, dataIndex)`, `ChartTheme`, `chartOption(w, data, ctx)`, `PivotData`, `pivotData(res, twoLevels)`, `formatMetric(v, fn, field?)`, `change(cur, prev)`, `metricLabel(m, field?)`.
  - `layout.ts`: `ROW_H`, `MOBILE_BREAK`, `stackOrder(ws)`, `layoutOf(ws)`, `changedPositions(ws, layout)`.
  - `edit.ts`: `WIDGET_LABELS`, `FN_LABELS`, `groupable(f)`, `fieldsForFn(fn, fields)`, `widgetPatch(before, after)`, `starterWidget(type, schema)`.
  - `markdown.ts`: `renderMarkdown(src)`.

- [ ] **Step 1: Write the failing tests**

`test/unit/dash.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Field, Schema, Widget } from "../../src/shared/types";
import { presetRange, previousRange } from "../../src/web/dash/dateRange";
import { bucketsBetween, change, chartData, chartOption, deepen, drillKey, formatMetric, keyLabel, metricLabel, pivotData } from "../../src/web/dash/series";
import { changedPositions, layoutOf, stackOrder } from "../../src/web/dash/layout";
import { fieldsForFn, starterWidget, widgetPatch } from "../../src/web/dash/edit";
import { renderMarkdown } from "../../src/web/dash/markdown";

const fld = (id: string, name: string, type: Field["type"], options: Field["options"] = {}): Field => ({ id, tableId: "tblA", name, type, options, ord: "a" });
const stage = fld("fldStage", "Stage", "singleSelect", { choices: [{ id: "c1", name: "Won", color: "#dff5dc" }, { id: "c2", name: "Lost", color: "#ffe0e6" }] });
const amount = fld("fldAmount", "Amount", "number");
const closed = fld("fldClosed", "Closed", "date");
const w = (x: Partial<Widget>): Widget => ({ id: "wgt1", type: "bar", title: "", x: 0, y: 0, w: 6, h: 4, ...x });
const theme = { ink: "#111", muted: "#888", line: "#ddd" };
const fmt = (v: number) => String(v);

describe("date range presets", () => {
  it("computes presets from the local day", () => {
    const today = "2026-10-13";
    expect(presetRange("all", today)).toBeNull();
    expect(presetRange("week", today)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(presetRange("month", today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("quarter", today)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(presetRange("year", today)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(presetRange("last7", today)).toEqual({ from: "2026-10-07", to: "2026-10-13" });
    expect(presetRange("last30", today)).toEqual({ from: "2026-09-14", to: "2026-10-13" });
    expect(presetRange("custom", today, { from: "2026-03-01", to: "2026-03-10" })).toEqual({ from: "2026-03-01", to: "2026-03-10" });
    expect(presetRange("custom", today, { from: "2026-03-10", to: "2026-03-01" })).toBeNull();
  });

  it("handles year boundaries and leap years", () => {
    expect(presetRange("week", "2026-01-01")).toEqual({ from: "2025-12-29", to: "2026-01-04" });
    expect(presetRange("month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(presetRange("quarter", "2026-02-15")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("previous period: calendar periods for calendar presets, equal length otherwise", () => {
    expect(previousRange("week", { from: "2026-10-12", to: "2026-10-18" })).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(previousRange("month", { from: "2026-03-01", to: "2026-03-31" })).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousRange("quarter", { from: "2026-01-01", to: "2026-03-31" })).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(previousRange("year", { from: "2026-01-01", to: "2026-12-31" })).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(previousRange("custom", { from: "2026-03-01", to: "2026-03-10" })).toEqual({ from: "2026-02-19", to: "2026-02-28" });
    expect(previousRange("last7", { from: "2026-10-07", to: "2026-10-13" })).toEqual({ from: "2026-09-30", to: "2026-10-06" });
  });
});

describe("chart data", () => {
  it("fills missing time buckets with zero inside the range", () => {
    const res = { total: 3, groups: [{ key: ["2026-03"], values: { v: 2 } }, { key: ["2026-01"], values: { v: 1 } }] };
    const d = chartData(res, { twoLevels: false, bucket: "month", range: { from: "2026-01-01", to: "2026-04-30" } });
    expect(d.categories).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(d.series).toEqual([{ key: null, data: [1, 0, 2, 0] }]);
  });

  it("without a range fills between the first and last bucket and keeps empty last", () => {
    const res = { total: 3, groups: [{ key: ["2026-01-12"], values: { v: 1 } }, { key: [null], values: { v: 4 } }, { key: ["2026-01-26"], values: { v: 2 } }] };
    const d = chartData(res, { twoLevels: false, bucket: "week" });
    expect(d.categories).toEqual(["2026-01-12", "2026-01-19", "2026-01-26", null]);
    expect(d.series[0].data).toEqual([1, 0, 2, 4]);
  });

  it("caps bucket filling so years of days cannot hang the page", () => {
    expect(bucketsBetween("2000-01-01", "2030-01-01", "day")).toHaveLength(5000);
    expect(bucketsBetween("2026-11", "2027-02", "month")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(bucketsBetween("2026", "2028", "year")).toEqual(["2026", "2027", "2028"]);
  });

  it("two levels become one series per second key, in order of appearance", () => {
    const res = { total: 5, groups: [{ key: ["Q1", "Won"], values: { v: 3 } }, { key: ["Q2", "Lost"], values: { v: 1 } }, { key: ["Q1", "Lost"], values: { v: 1 } }] };
    const d = chartData(res, { twoLevels: true });
    expect(d.categories).toEqual(["Q1", "Q2"]);
    expect(d.series).toEqual([{ key: "Won", data: [3, 0] }, { key: "Lost", data: [1, 1] }]);
    expect(drillKey(d, true, 1, 0)).toEqual(["Q1", "Lost"]);
    expect(drillKey(d, false, 0, 1)).toEqual(["Q2"]);
  });

  it("labels keys", () => {
    expect(keyLabel(null)).toBe("(empty)");
    expect(keyLabel("__other__")).toBe("Other");
    expect(keyLabel(true)).toBe("Checked");
    expect(keyLabel("2026-03", "month")).toBe("Mar 2026");
    expect(keyLabel("2026-01-12", "week")).toBe("Week of 2026-01-12");
    expect(keyLabel("Won")).toBe("Won");
  });

  it("deepens pastel option colors keeping the hue", () => {
    const c = deepen("#d6ecff");
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    const [r, , b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r);
  });
});

describe("chart options", () => {
  const data = { categories: ["Won", "Lost"], series: [{ key: null, data: [3, 1] }] };
  it("horizontal bars swap the axes and color bars by select option", () => {
    const o = chartOption(w({ horizontal: true }), data, { xField: stage, label: "Count", theme, format: fmt }) as any;
    expect(o.xAxis.type).toBe("value");
    expect(o.yAxis).toMatchObject({ type: "category", data: ["Won", "Lost"], inverse: true });
    expect(o.series[0].data[0]).toEqual({ value: 3, itemStyle: { color: deepen("#dff5dc") } });
  });

  it("stacked series, area lines and donuts", () => {
    const two = { categories: ["Q1"], series: [{ key: "Won", data: [3] }, { key: "Lost", data: [1] }] };
    const bar = chartOption(w({ stacked: true, seriesFieldId: "fldStage" }), two, { seriesField: stage, label: "Count", theme, format: fmt }) as any;
    expect(bar.series.map((s: any) => [s.name, s.stack])).toEqual([["Won", "total"], ["Lost", "total"]]);
    expect(bar.legend).toBeDefined();
    const line = chartOption(w({ type: "line", area: true }), data, { label: "Count", theme, format: fmt }) as any;
    expect(line.series[0]).toMatchObject({ type: "line", areaStyle: {}, data: [3, 1] });
    const pie = chartOption(w({ type: "pie", donut: true }), data, { xField: stage, label: "Count", theme, format: fmt }) as any;
    expect(pie.series[0].radius).toEqual(["45%", "70%"]);
    expect(pie.series[0].data[1]).toMatchObject({ name: "Lost", value: 1 });
  });
});

describe("pivot, numbers and labels", () => {
  it("pivot rows keep server order and columns sort by key", () => {
    const p = pivotData({ total: 3, groups: [{ key: ["A", "2026"], values: { v: 1 } }, { key: ["A", "2025"], values: { v: 2 } }, { key: ["B", null], values: { v: 3 } }] }, true);
    expect(p.rows).toEqual(["A", "B"]);
    expect(p.cols).toEqual(["2025", "2026", null]);
    expect([p.value("A", "2025"), p.value("B", null), p.value("B", "2026")]).toEqual([2, 3, null]);
    const one = pivotData({ total: 1, groups: [{ key: ["A"], values: { v: 5 } }] }, false);
    expect([one.cols, one.value("A", null)]).toEqual([[null], 5]);
  });

  it("formats metric values and changes", () => {
    expect(formatMetric(1234, "count")).toBe("1,234");
    expect(formatMetric(null, "sum", amount)).toBe("-");
    expect(formatMetric("2026-01-05T10:00:00.000Z", "min", closed)).toBe("2026-01-05");
    expect(formatMetric(10 / 3, "avg")).toBe("3.33");
    expect(change(120, 100)).toEqual({ pct: 20, dir: "up" });
    expect(change(50, 100)).toEqual({ pct: -50, dir: "down" });
    expect(change(5, 0)).toEqual({ pct: null, dir: "up" });
    expect(change(null, 3)).toEqual({ pct: null, dir: "flat" });
    expect(metricLabel({ fn: "count" })).toBe("Records");
    expect(metricLabel({ fn: "sum", fieldId: "fldAmount" }, amount)).toBe("Sum of Amount");
  });
});

describe("layout and editing", () => {
  const ws = [w({ id: "b", x: 6, y: 0 }), w({ id: "a", x: 0, y: 0 }), w({ id: "c", type: "text", x: 0, y: 4, h: 1 })];
  it("stacks widgets in reading order for phones", () => {
    expect(stackOrder(ws).map(x => x.id)).toEqual(["a", "b", "c"]);
  });
  it("builds grid items and finds moved widgets", () => {
    expect(layoutOf(ws)[2]).toEqual({ i: "c", x: 0, y: 4, w: 6, h: 1, minW: 2, minH: 1 });
    expect(layoutOf(ws)[0].minH).toBe(2);
    const moved = layoutOf(ws).map(l => (l.i === "a" ? { ...l, y: 4 } : l.i === "c" ? { ...l, y: 8 } : l));
    expect(changedPositions(ws, moved)).toEqual([{ id: "a", x: 0, y: 4, w: 6, h: 4 }, { id: "c", x: 0, y: 8, w: 6, h: 1 }]);
  });
  it("diffs widgets into patches with null for removed settings", () => {
    expect(widgetPatch(w({ limit: 5, title: "A" }), w({ title: "B", stacked: true }))).toEqual({ limit: null, title: "B", stacked: true });
    expect(widgetPatch(w({}), w({}))).toEqual({});
  });
  it("offers fields that fit the metric", () => {
    const fields = [fld("fldName", "Name", "text"), amount, closed];
    expect(fieldsForFn("sum", fields).map(f => f.name)).toEqual(["Amount"]);
    expect(fieldsForFn("max", fields).map(f => f.name)).toEqual(["Amount", "Closed"]);
    expect(fieldsForFn("countFilled", fields)).toHaveLength(3);
    expect(fieldsForFn("count", fields)).toEqual([]);
  });
  it("starts new widgets on the first table with useful defaults", () => {
    const schema = { tables: [{ id: "tblA", name: "Deals", ord: "a", primaryFieldId: "fldName" }], fields: [fld("fldName", "Name", "text"), stage, closed], views: [], dashboards: [], baseId: "b", version: 1, jobs: [] } as Schema;
    expect(starterWidget("bar", schema)).toEqual({ type: "bar", tableId: "tblA", metric: { fn: "count" }, xFieldId: "fldStage" });
    expect(starterWidget("pie", schema)).toMatchObject({ groupFieldId: "fldStage" });
    expect(starterWidget("pivot", schema)).toMatchObject({ rowFieldId: "fldStage" });
    expect(starterWidget("text", schema)).toEqual({ type: "text", text: "## Title\n\nWrite notes in Markdown." });
  });
});

describe("markdown", () => {
  it("renders Markdown and neutralizes HTML and script links", () => {
    expect(renderMarkdown("# Hi\n\n**bold**")).toContain("<strong>bold</strong>");
    const evil = renderMarkdown('<img src=x onerror=alert(1)> and <script>alert(1)</script>\n\n[x](javascript:alert(1)) [ok](https://example.com)');
    expect(evil).not.toMatch(/<img|<script/);
    expect(evil).not.toContain('href="javascript');
    expect(evil).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit test/unit/dash.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `dateRange.ts`**

```ts
// Dashboard date range presets, computed from the viewer's local day.
import { addDays, addMonths, diffDays, startOfMonth, startOfWeek, type Day } from "../base/dates";

export type RangePreset = "all" | "week" | "month" | "quarter" | "year" | "last7" | "last30" | "custom";

export interface DayRange {
  from: Day;
  to: Day;
}

export const PRESET_LABELS: Record<RangePreset, string> = {
  all: "All time",
  week: "This week",
  month: "This month",
  quarter: "This quarter",
  year: "This year",
  last7: "Last 7 days",
  last30: "Last 30 days",
  custom: "Custom",
};

const startOfQuarter = (d: Day): Day => `${d.slice(0, 4)}-${String(Math.floor((+d.slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;

export function presetRange(p: RangePreset, today: Day, custom?: DayRange): DayRange | null {
  switch (p) {
    case "all":
      return null;
    case "week": {
      const s = startOfWeek(today);
      return { from: s, to: addDays(s, 6) };
    }
    case "month": {
      const s = startOfMonth(today);
      return { from: s, to: addDays(addMonths(s, 1), -1) };
    }
    case "quarter": {
      const s = startOfQuarter(today);
      return { from: s, to: addDays(addMonths(s, 3), -1) };
    }
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
    case "custom":
      return custom && custom.from && custom.to && custom.from <= custom.to ? custom : null;
  }
}

/** The period to compare with: the previous calendar period for calendar presets, else the same number of days just before. */
export function previousRange(p: RangePreset, r: DayRange): DayRange {
  const months = p === "month" ? 1 : p === "quarter" ? 3 : p === "year" ? 12 : 0;
  if (p === "week") return { from: addDays(r.from, -7), to: addDays(r.to, -7) };
  if (months) return { from: addMonths(r.from, -months), to: addDays(r.from, -1) };
  const n = diffDays(r.from, r.to) + 1;
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}
```

- [ ] **Step 4: Write `series.ts`**

```ts
// Turns aggregate results into what dashboards draw: filled time buckets, labels, chart options, pivot cells and numbers.
import type { AggFn, DateBucket, Field, Widget, WidgetMetric } from "../../shared/types";
import { isDateField, isNumberField } from "../../shared/types";
import { displayCell } from "../../shared/cells";
import { bucketDate, compareKeys, OTHER_KEY, type AggregateResult, type GroupKey } from "../../worker/base/aggregate";
import { addDays, addMonths } from "../base/dates";
import type { DayRange } from "./dateRange";

export const CHART_COLORS = ["#c4421a", "#2f6fdf", "#22863a", "#b7791f", "#7c4dff", "#0f9d9a", "#d6336c", "#5c6b7a", "#8a6d3b", "#3b5bdb"];
const EMPTY_COLOR = "#b8b2ab";
const OTHER_COLOR = "#9a948d";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_BUCKETS = 5000;

export function nextBucket(key: string, bucket: DateBucket): string {
  if (bucket === "day") return addDays(key, 1);
  if (bucket === "week") return addDays(key, 7);
  if (bucket === "month") return addMonths(key + "-01", 1).slice(0, 7);
  return String(+key + 1);
}

/** Bucket keys from one key to another inclusive, at most 5,000. */
export function bucketsBetween(fromKey: string, toKey: string, bucket: DateBucket): string[] {
  const out: string[] = [];
  for (let k = fromKey; k <= toKey && out.length < MAX_BUCKETS; k = nextBucket(k, bucket)) out.push(k);
  return out;
}

export function keyLabel(k: GroupKey, bucket?: DateBucket): string {
  if (k === null) return "(empty)";
  if (k === OTHER_KEY) return "Other";
  if (typeof k === "boolean") return k ? "Checked" : "Unchecked";
  if (bucket === "month" && /^\d{4}-\d{2}$/.test(k)) return `${MONTHS[+k.slice(5) - 1]} ${k.slice(0, 4)}`;
  if (bucket === "week") return `Week of ${k}`;
  return k;
}

function hslToHex(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${ch(h + 1 / 3)}${ch(h)}${ch(h - 1 / 3)}`;
}

/** A select option's pastel chip color as a chart color of the same hue. */
export function deepen(hex: string): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    const l = (max + min) / 2;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  return hslToHex(h, Math.max(s, 0.55), 0.5);
}

export function colorFor(field: Field | undefined, key: GroupKey, i: number): string {
  if (key === null) return EMPTY_COLOR;
  if (key === OTHER_KEY) return OTHER_COLOR;
  const choice = field?.type === "singleSelect" || field?.type === "multiSelect" ? field.options.choices?.find(c => c.name === key) : undefined;
  return choice ? deepen(choice.color) : CHART_COLORS[i % CHART_COLORS.length];
}

export interface ChartData {
  categories: GroupKey[];
  series: { key: GroupKey; data: number[] }[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Categories (first group level) and series (second level, or one series) with zeros where a combination has no records. */
export function chartData(res: AggregateResult, opts: { twoLevels: boolean; bucket?: DateBucket; range?: DayRange | null }): ChartData {
  const cats: GroupKey[] = [];
  const sers: GroupKey[] = [];
  const seenC = new Set<string>(), seenS = new Set<string>();
  const cell = new Map<string, number>();
  for (const g of res.groups) {
    const c = g.key[0] ?? null;
    const s = opts.twoLevels ? g.key[1] ?? null : null;
    if (!seenC.has(JSON.stringify(c))) seenC.add(JSON.stringify(c)), cats.push(c);
    if (!seenS.has(JSON.stringify(s))) seenS.add(JSON.stringify(s)), sers.push(s);
    cell.set(JSON.stringify([c, s]), num(g.values.v));
  }
  let categories = cats;
  if (opts.bucket) {
    const dated = cats.filter((k): k is string => typeof k === "string" && k !== OTHER_KEY).sort();
    const span = opts.range ? [bucketDate(opts.range.from, opts.bucket)!, bucketDate(opts.range.to, opts.bucket)!] : dated.length ? [dated[0], dated[dated.length - 1]] : null;
    categories = span ? bucketsBetween(span[0], span[1], opts.bucket) : [];
    if (!opts.range && cats.includes(null)) categories.push(null);
  }
  return { categories, series: sers.map(s => ({ key: s, data: categories.map(c => cell.get(JSON.stringify([c, s])) ?? 0) })) };
}

/** The aggregate group key behind one clicked chart element. */
export function drillKey(d: ChartData, twoLevels: boolean, seriesIndex: number, dataIndex: number): GroupKey[] {
  const c = d.categories[dataIndex] ?? null;
  return twoLevels ? [c, d.series[seriesIndex]?.key ?? null] : [c];
}

export interface ChartTheme {
  ink: string;
  muted: string;
  line: string;
}

export interface ChartCtx {
  xField?: Field;
  seriesField?: Field;
  bucket?: DateBucket;
  seriesBucket?: DateBucket;
  label: string;
  theme: ChartTheme;
  format: (v: number) => string;
}

/** ECharts option for a bar, line or pie widget (plain data, so it can be tested without ECharts). */
export function chartOption(w: Widget, d: ChartData, ctx: ChartCtx): Record<string, unknown> {
  const labels = d.categories.map(k => keyLabel(k, ctx.bucket));
  const { ink, muted, line } = ctx.theme;
  if (w.type === "pie") {
    const values = d.series[0]?.data ?? [];
    return {
      tooltip: { trigger: "item", valueFormatter: ctx.format },
      legend: { type: "scroll", bottom: 0, textStyle: { color: ink } },
      series: [
        {
          type: "pie",
          radius: w.donut ? ["45%", "70%"] : "70%",
          center: ["50%", "45%"],
          label: { color: ink },
          data: d.categories.map((k, i) => ({ name: labels[i], value: values[i], itemStyle: { color: colorFor(ctx.xField, k, i) } })),
        },
      ],
    };
  }
  const two = !!w.seriesFieldId;
  const horizontal = w.type === "bar" && !!w.horizontal;
  const cat = { type: "category", data: labels, axisLabel: { color: muted, hideOverlap: true }, axisLine: { lineStyle: { color: line } } };
  const val = { type: "value", axisLabel: { color: muted, formatter: ctx.format }, splitLine: { lineStyle: { color: line } } };
  return {
    grid: { left: 8, right: 16, top: two ? 32 : 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: ctx.format },
    legend: two ? { type: "scroll", top: 0, textStyle: { color: ink } } : undefined,
    xAxis: horizontal ? val : cat,
    yAxis: horizontal ? { ...cat, inverse: true } : val,
    series: d.series.map((s, si) => {
      const color = two ? colorFor(ctx.seriesField, s.key, si) : CHART_COLORS[0];
      const single = !two && w.type === "bar";
      return {
        type: w.type,
        name: two ? keyLabel(s.key, ctx.seriesBucket) : ctx.label,
        data: single ? s.data.map((v, i) => ({ value: v, itemStyle: { color: colorFor(ctx.xField, d.categories[i], 0) } })) : s.data,
        stack: w.stacked ? "total" : undefined,
        areaStyle: w.type === "line" && w.area ? {} : undefined,
        itemStyle: single ? undefined : { color },
        lineStyle: w.type === "line" ? { color } : undefined,
      };
    }),
  };
}

export interface PivotData {
  rows: GroupKey[];
  cols: GroupKey[];
  value(r: GroupKey, c: GroupKey): number | string | null;
}

export function pivotData(res: AggregateResult, twoLevels: boolean): PivotData {
  const rows: GroupKey[] = [], cols: GroupKey[] = [];
  const seenR = new Set<string>(), seenC = new Set<string>();
  const m = new Map<string, number | string | null>();
  for (const g of res.groups) {
    const r = g.key[0] ?? null;
    const c = twoLevels ? g.key[1] ?? null : null;
    if (!seenR.has(JSON.stringify(r))) seenR.add(JSON.stringify(r)), rows.push(r);
    if (!seenC.has(JSON.stringify(c))) seenC.add(JSON.stringify(c)), cols.push(c);
    m.set(JSON.stringify([r, c]), g.values.v ?? null);
  }
  cols.sort((a, b) => compareKeys([a], [b]));
  return { rows, cols: twoLevels ? cols : [null], value: (r, c) => m.get(JSON.stringify([r, c])) ?? null };
}

const COUNTS = new Set<AggFn>(["count", "countUnique", "countEmpty", "countFilled"]);

export function formatMetric(v: number | string | null | undefined, fn: AggFn, field?: Field): string {
  if (v === null || v === undefined) return "-";
  if (COUNTS.has(fn)) return Number(v).toLocaleString("en-US");
  if (field && isDateField(field)) return String(v).slice(0, 10);
  if (typeof v !== "number") return String(v);
  const rounded = Math.round(v * 100) / 100;
  if (field && isNumberField(field) && field.options.format) return displayCell(field, rounded);
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function change(cur: number | null, prev: number | null): { pct: number | null; dir: "up" | "down" | "flat" } {
  if (cur === null || prev === null) return { pct: null, dir: "flat" };
  const dir = cur > prev ? "up" : cur < prev ? "down" : "flat";
  return { pct: prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10, dir };
}

export function metricLabel(m: WidgetMetric, field?: Field): string {
  const n = field?.name ?? "field";
  switch (m.fn) {
    case "count":
      return "Records";
    case "countUnique":
      return `Unique ${n}`;
    case "countEmpty":
      return `Empty ${n}`;
    case "countFilled":
      return `Filled ${n}`;
    case "sum":
      return `Sum of ${n}`;
    case "avg":
      return `Average ${n}`;
    case "min":
      return `Min ${n}`;
    case "max":
      return `Max ${n}`;
  }
}
```

Note `formatMetric` for a number field without a display format falls through to `toLocaleString`, which gives `"3.33"` in the avg test.

- [ ] **Step 5: Write `layout.ts`, `edit.ts`, `markdown.ts`**

`layout.ts`:

```ts
// Grid sizes for dashboards and the conversions between widgets and react-grid-layout items.
import type { Widget } from "../../shared/types";
import type { LayoutItemInput } from "../../shared/widgets";

export const ROW_H = 80;
export const MOBILE_BREAK = 768;

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

/** Reading order for the one-column phone layout. */
export function stackOrder(ws: Widget[]): Widget[] {
  return [...ws].sort((a, b) => a.y - b.y || a.x - b.x);
}

export function layoutOf(ws: Widget[]): GridItem[] {
  return ws.map(w => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: w.type === "text" || w.type === "metric" ? 1 : 2 }));
}

/** Widgets whose position differs in a new layout, as setLayout items. */
export function changedPositions(ws: Widget[], layout: readonly GridItem[]): LayoutItemInput[] {
  const byId = new Map(ws.map(w => [w.id, w]));
  return layout.filter(l => {
    const w = byId.get(l.i);
    return w && (w.x !== l.x || w.y !== l.y || w.w !== l.w || w.h !== l.h);
  }).map(l => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
}
```

Text and number widgets may shrink to one row; charts and tables keep at least two. If a one-row number card is unreadable in the Task 9 UI check, raise its minimum and update the test.

`edit.ts`:

```ts
// Helpers for the widget editor: labels, field choices, defaults and diffing a draft into a patch.
import type { AggFn, Field, Schema, Widget, WidgetType } from "../../shared/types";
import { isDateField, isNumberField } from "../../shared/types";
import type { WidgetInput, WidgetPatch } from "../../shared/widgets";

export const WIDGET_LABELS: Record<WidgetType, string> = { metric: "Number", bar: "Bar chart", line: "Line chart", pie: "Pie chart", pivot: "Summary table", text: "Text" };

export const FN_LABELS: Record<AggFn, string> = {
  count: "Count records",
  countUnique: "Count unique values",
  countEmpty: "Count empty",
  countFilled: "Count filled",
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
};

export const groupable = (f: Field) => f.type !== "attachment" && f.type !== "longText";

export function fieldsForFn(fn: AggFn, fields: Field[]): Field[] {
  if (fn === "count") return [];
  if (fn === "sum" || fn === "avg") return fields.filter(isNumberField);
  if (fn === "min" || fn === "max") return fields.filter(f => isNumberField(f) || isDateField(f));
  return fields;
}

/** The changes from one widget to another; settings that disappeared become null so the server removes them. */
export function widgetPatch(before: Widget, after: Widget): WidgetPatch {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === "id") continue;
    const a = (before as unknown as Record<string, unknown>)[k];
    const b = (after as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out[k] = b === undefined ? null : b;
  }
  return out as WidgetPatch;
}

/** A new widget that shows something right away: the first table, a record count, grouped by the first select or date field. */
export function starterWidget(type: WidgetType, schema: Schema): WidgetInput {
  if (type === "text") return { type, text: "## Title\n\nWrite notes in Markdown." };
  const table = [...schema.tables].sort((a, b) => (a.ord < b.ord ? -1 : 1))[0];
  if (!table) return { type };
  const fields = schema.fields.filter(f => f.tableId === table.id);
  const group = fields.find(f => f.type === "singleSelect") ?? fields.find(isDateField);
  const out: WidgetInput = { type, tableId: table.id, metric: { fn: "count" } };
  if (group && (type === "bar" || type === "line")) out.xFieldId = group.id;
  if (group && type === "pie") out.groupFieldId = group.id;
  if (group && type === "pivot") out.rowFieldId = group.id;
  return out;
}
```

`markdown.ts`:

```ts
// Markdown for dashboard text blocks. Raw HTML is shown as text and only http(s) and mailto links are kept.
import { marked } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeUrl = (href: string | null) => (href && /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null);

export function renderMarkdown(src: string): string {
  const renderer = new marked.Renderer();
  renderer.html = (html: string) => esc(html);
  renderer.link = (href: string | null, title: string | null, text: string) => {
    const url = safeUrl(href);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ""}>${text}</a>` : text;
  };
  renderer.image = (_href: string | null, _title: string | null, text: string) => esc(text ?? "");
  return marked.parse(src, { renderer, mangle: false, headerIds: false }) as string;
}
```

If marked 4.3.0's renderer signatures differ (check `node_modules/marked/lib/marked.d.ts` or the `.cjs` source), adapt the parameter list and ledger a ruling. The markdown test is the contract.

- [ ] **Step 6: Run tests**

Run: `npx vitest run --project unit test/unit/dash.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Checkpoint**

Run: `npm test 2>&1 | tail -5`; ledger the count.

---

### Task 8: Dependencies, client data layer, routing, filter editor, dashboard tabs

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)
- Modify: `src/web/base/client.ts`
- Create: `src/web/base/FilterEditor.tsx` (moved out of `Toolbar.tsx`)
- Modify: `src/web/base/Toolbar.tsx`
- Modify: `src/web/main.tsx`
- Modify: `src/web/base/BasePage.tsx`
- Modify: `src/web/ui.tsx` (chart icon)
- Create: `src/web/dash/DashboardPage.tsx` (a placeholder that Task 9 replaces)

**Interfaces:**
- Produces on `BaseClient`: `dashboards(): Dashboard[]`, `dashboard(id): Dashboard | undefined`, `onData(fn: (tableId: string) => void): () => void`, `aggregate(tableId, input): Promise<AggregateResult>`, `aggregateRecords(tableId, input, key): Promise<{ ids: number[]; truncated: boolean }>`.
- Produces `FilterEditor({ fields, spec, onChange, emptyText })` with `onChange(next: FilterSpec, delay?: number)`; exports `kindOf`, `OPS`.
- Produces route `/base/:baseId/dash/:dashId` → `BasePage` prop `dashboardId`; `DashboardPage` default export with props `{ client: BaseClient; dashboard: Dashboard; onExpand: (tableId: string, rowId: number) => void }`.

- [ ] **Step 1: Install dependencies**

Run: `npm install --save-exact echarts@6.1.0 react-grid-layout@2.2.4`
Expected: both appear in `dependencies` with exact versions; `npm ls react-resizable` shows it installed (pulled in by react-grid-layout).

- [ ] **Step 2: BaseClient data API**

In `client.ts` add imports (`Dashboard` type; `AggregateInput`, `AggregateResult`, `GroupKey` types from `../../worker/base/aggregate`). Add:

```ts
  private dataListeners = new Set<(tableId: string) => void>();

  /** Called with a table id whenever rows of that table change: anyone's writes, recomputes, reloads. */
  onData(fn: (tableId: string) => void): () => void {
    this.dataListeners.add(fn);
    return () => {
      this.dataListeners.delete(fn);
    };
  }

  private dataChanged(tableId: string) {
    for (const l of this.dataListeners) l(tableId);
  }

  dashboards(): Dashboard[] {
    return [...(this.schema.dashboards ?? [])].sort((a, b) => (a.ord < b.ord ? -1 : 1));
  }

  dashboard(id: string): Dashboard | undefined {
    return this.schema.dashboards?.find(d => d.id === id);
  }

  aggregate(tableId: string, input: AggregateInput): Promise<AggregateResult> {
    return post<AggregateResult>(`/api/bases/${this.baseId}/aggregate`, { ...input, tableId });
  }

  aggregateRecords(tableId: string, input: AggregateInput, key: GroupKey[]): Promise<{ ids: number[]; truncated: boolean }> {
    return post(`/api/bases/${this.baseId}/aggregate/records`, { ...input, tableId, key });
  }
```

Call `dataChanged`:
- in `applyResult`, for every `ch.tableId` in `res.changes` and every `d.tableId` in `res.deleted` (own writes, including rollups in other tables);
- in `onMessage` `"rows"` after the `own` early return, `"deleted"` after its own-check, and `"reload"`;
- in the reconnect handler, for every table in the reloaded schema.

- [ ] **Step 3: Extract `FilterEditor`**

Move `Kind`, `kindOf`, `OPS`, `FilterValue` and the body of `FilterPanel` into `src/web/base/FilterEditor.tsx`:

```tsx
// Filter conditions editor shared by the view toolbar and the dashboard widget editor.
import type { Condition, Field, FilterOp, FilterSpec } from "../../shared/types";
import { Button, Icon } from "../ui";
import { Chip } from "./editors";

// (Kind, kindOf, OPS and FilterValue moved here unchanged, with kindOf and OPS exported)

export function FilterEditor({ fields, spec, onChange, emptyText }: { fields: Field[]; spec: FilterSpec; onChange: (next: FilterSpec, delay?: number) => void; emptyText: string }) {
  const setCond = (i: number, c: Partial<Condition>, delay = 0) => onChange({ ...spec, conditions: spec.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) }, delay);
  return (
    <>
      {spec.conditions.length === 0 && <p className="muted small" style={{ margin: "4px 4px 10px" }}>{emptyText}</p>}
      {/* the filter-list markup from FilterPanel, with update(...) replaced by onChange(...) */}
      {fields.length > 0 && (
        <Button small variant="ghost" icon="plus" onClick={() => {
          const f = fields[0];
          onChange({ ...spec, conditions: [...spec.conditions, { fieldId: f.id, op: OPS[kindOf(f)][0][0], value: kindOf(f) === "bool" ? true : undefined }] });
        }}>Add condition</Button>
      )}
    </>
  );
}
```

`FilterPanel` in `Toolbar.tsx` becomes:

```tsx
function FilterPanel({ client, view, anchor, onClose }: { client: BaseClient; view: View; anchor: HTMLElement; onClose: () => void }) {
  const [spec, setSpec] = useState<FilterSpec>(view.config.filters ?? { conjunction: "and", conditions: [] });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const update = (next: FilterSpec, delay = 0) => {
    setSpec(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => client.updateViewConfig(view.id, { filters: next }, 300), delay);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={560}>
      <FilterEditor fields={client.fields(view.tableId)} spec={spec} onChange={update} emptyText="No filters applied to this view." />
    </Popover>
  );
}
```

Remove imports from `Toolbar.tsx` that are no longer used.

- [ ] **Step 4: Routing, icon, tabs**

`ui.tsx` `PATHS`: add `chart: "M4 20V11M10 20V5M16 20v-8M21 20H3",`.

`main.tsx`, before the base route:

```tsx
  if ((m = match("/base/:baseId/dash/:dashId", path))) page = <BasePage key={m.baseId} baseId={m.baseId} dashboardId={m.dashId} />;
  else if ((m = match("/base/:baseId/:tableId?/:viewId?", path))) page = ...
```

`BasePage.tsx`:
- `const DashboardPage = lazy(() => import("../dash/DashboardPage"));`
- `BasePage` and `BaseShell` take `dashboardId?: string` and pass it through.
- In `BaseShell`: `const dash = dashboardId ? client.dashboard(dashboardId) : undefined;` and `const [dashRecord, setDashRecord] = useState<{ tableId: string; id: number } | null>(null);`.
- URL effect: first line `if (dashboardId) { if (!dash) navigate(\`/base/${client.baseId}\`, { replace: true }); return; }`, and add `dashboardId, dash` to its dependencies.
- `const goDash = (id: string) => navigate(\`/base/${client.baseId}/dash/${id}\`);`
- `addDashboard`: `client.schemaOp({ op: "createDashboard", name: "Dashboard" }).then(r => r.id && goDash(r.id)).catch(toastError)`.
- `dashMenu(anchor, d)`: Rename (prompt, `updateDashboard`), separator, Delete (confirm `Delete the dashboard "${d.name}"? Records are not deleted.`, `deleteDashboard`, then `go(schema.tables[0].id)`); both disabled when `!client.writable`.
- Table tabs: `active` only when `!dash`. After the tables, render `client.dashboards()` as tabs with class `table-tab dash-tab`, a `chart` icon before the name, `active` when `d.id === dash?.id`, click `goDash`, context menu and chevron like table tabs.
- "Add or import" menu: add `{ label: "New dashboard", icon: "chart", onClick: addDashboard }` first.
- Hide the sidebar toggle when `dash`.
- Body: when `dash`, render instead of `.base-body`:

```tsx
        <div className="base-body">
          <main className="view-main">
            <Suspense fallback={<div className="center-page"><Spinner /></div>}>
              <DashboardPage key={dash.id} client={client} dashboard={dash} onExpand={(tableId, id) => setDashRecord({ tableId, id })} />
            </Suspense>
          </main>
        </div>
```

- Record modal for dashboards:

```tsx
      {dashRecord && client.viewsOf(dashRecord.tableId)[0] && (
        <RecordModal client={client} view={client.viewsOf(dashRecord.tableId)[0]} rowId={dashRecord.id} onClose={() => setDashRecord(null)} onNavigate={id => setDashRecord({ ...dashRecord, id })} />
      )}
```

Placeholder `src/web/dash/DashboardPage.tsx` for this task:

```tsx
// Placeholder; replaced by the full dashboard page in the next task.
import type { Dashboard } from "../../shared/types";
import type { BaseClient } from "../base/client";

export default function DashboardPage({ dashboard }: { client: BaseClient; dashboard: Dashboard; onExpand: (tableId: string, rowId: number) => void }) {
  return <div className="center-page">{dashboard.name}</div>;
}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test 2>&1 | tail -5 && npm run build:web 2>&1 | tail -5`
Expected: clean typecheck, all tests pass, build succeeds.

Then UI check with the Playwright MCP against `npm run dev` (wrangler dev on :8787), signed in as `e2e@example.com` / `correct horse`, base "Views QA": the view toolbar filter still adds, edits and removes a condition (grid reloads); "Add or import" → "New dashboard" creates a tab and opens `/base/<id>/dash/<id>` with the dashboard name; reload keeps it; rename and delete from the tab menu work; deleting returns to the first table. Ledger what was checked.

- [ ] **Step 6: Checkpoint**

Ledger the test count and the UI checks.

---

### Task 9: Dashboard page, widgets, editor, drill-down

**Files:**
- Create: `src/web/dash/echarts.ts`, `src/web/dash/Chart.tsx`, `src/web/dash/WidgetCard.tsx`, `src/web/dash/WidgetEditor.tsx`, `src/web/dash/DrillList.tsx`, `src/web/dash/dash.css`
- Replace: `src/web/dash/DashboardPage.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1, 7 and 8.
- Produces: the dashboard UI. `Drill { tableId: string; query: AggregateInput; key: GroupKey[]; title: string }`.

- [ ] **Step 1: ECharts setup and chart component**

`echarts.ts`:

```ts
// ECharts with only the charts and components dashboards use, so the lazy dashboard chunk stays small.
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export { echarts };
```

`Chart.tsx`:

```tsx
// One ECharts canvas that follows its container size and reports clicks by series and data index.
import { useEffect, useRef } from "react";
import { echarts } from "./echarts";

export function Chart({ option, onPick }: { option: Record<string, unknown>; onPick?: (seriesIndex: number, dataIndex: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init>>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    const c = echarts.init(ref.current!, undefined, { renderer: "canvas" });
    chart.current = c;
    c.on("click", (p: { seriesIndex?: number; dataIndex?: number }) => pick.current?.(p.seriesIndex ?? 0, p.dataIndex ?? 0));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current!);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = undefined;
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, true);
  }, [option]);
  return <div ref={ref} className={"chart" + (onPick ? " clickable" : "")} />;
}
```

- [ ] **Step 2: Widget card**

`WidgetCard.tsx`:

```tsx
// One dashboard widget: loads its numbers, refreshes when its table changes, and draws a number, chart, table or text.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Field, Widget } from "../../shared/types";
import { widgetProblem, widgetQuery } from "../../shared/widgets";
import type { AggregateInput, AggregateResult, GroupKey } from "../../worker/base/aggregate";
import { useBase, type BaseClient } from "../base/client";
import { Button, Icon, Spinner } from "../ui";
import { Chart } from "./Chart";
import { previousRange, type DayRange, type RangePreset } from "./dateRange";
import type { Drill } from "./DrillList";
import { renderMarkdown } from "./markdown";
import { change, chartData, chartOption, drillKey, formatMetric, keyLabel, metricLabel, pivotData, type ChartTheme } from "./series";

interface Props {
  client: BaseClient;
  widget: Widget;
  range: DayRange | null;
  preset: RangePreset;
  editable: boolean;
  preview?: boolean;
  onEdit?: () => void;
  onMenu?: (anchor: HTMLElement) => void;
  onDrill: (d: Drill) => void;
}

function theme(): ChartTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { ink: v("--ink", "#1d1b19"), muted: v("--muted", "#8a847d"), line: v("--line", "#e6e2dd") };
}

export function defaultTitle(w: Widget, client: BaseClient): string {
  if (w.type === "text") return "";
  const f = (id?: string) => (id ? client.field(id) : undefined);
  const base = w.metric ? metricLabel(w.metric, f(w.metric.fieldId)) : "New widget";
  const by = f(w.xFieldId ?? w.groupFieldId ?? w.rowFieldId);
  return by ? `${base} by ${by.name}` : base;
}

function useWidgetData(client: BaseClient, tableId: string | undefined, q: AggregateInput | null, prevQ: AggregateInput | null) {
  const key = JSON.stringify([tableId, q, prevQ]);
  const [tick, setTick] = useState(0);
  const [st, setSt] = useState<{ result?: AggregateResult; prev?: AggregateResult; error?: string }>({});
  useEffect(() => {
    if (!tableId) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = client.onData(id => {
      if (id !== tableId) return;
      clearTimeout(t);
      t = setTimeout(() => setTick(x => x + 1), 1000);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [client, tableId]);
  useEffect(() => {
    if (!q || !tableId) return;
    let live = true;
    setSt(s => ({ ...s, error: undefined }));
    Promise.all([client.aggregate(tableId, q), prevQ ? client.aggregate(tableId, prevQ) : Promise.resolve(undefined)])
      .then(([result, prev]) => live && setSt({ result, prev }))
      .catch(e => live && setSt({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [key, tick, client.schema.version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, retry: () => setTick(x => x + 1) };
}

export function WidgetCard({ client, widget: w, range, preset, editable, preview, onEdit, onMenu, onDrill }: Props) {
  useBase(client);
  const fmap = useMemo(() => new Map((w.tableId ? client.fields(w.tableId) : []).map(f => [f.id, f])), [client.schema.version, w.tableId]); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = widgetProblem(w, client.schema);
  const q = problem ? null : widgetQuery(w, fmap, range);
  const prevQ = !problem && w.type === "metric" && w.compare && range && preset !== "all" ? widgetQuery(w, fmap, previousRange(preset, range)) : null;
  const data = useWidgetData(client, w.tableId, q, prevQ);
  const title = w.title || defaultTitle(w, client);
  const field = (id?: string): Field | undefined => (id ? fmap.get(id) : undefined);
  const metricField = field(w.metric?.fieldId);
  const format = (v: number) => formatMetric(v, w.metric?.fn ?? "count", metricField);
  const drill = (key: GroupKey[], label: string) => q && w.tableId && onDrill({ tableId: w.tableId, query: q, key, title: label ? `${title}: ${label}` : title });

  let body: ReactNode;
  if (w.type === "text") body = <div className="widget-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(w.text ?? "") }} />;
  else if (problem)
    body = (
      <div className="widget-empty">
        <p>{problem.kind === "setup" ? "Set up this widget" : "The data source changed; pick another"}</p>
        {problem.kind === "changed" && <p className="muted small">{problem.message}</p>}
        {editable && onEdit && <Button small onClick={onEdit}>Settings</Button>}
      </div>
    );
  else if (data.error)
    body = (
      <div className="widget-empty">
        <p className="danger-text">{data.error}</p>
        <Button small onClick={data.retry}>Retry</Button>
      </div>
    );
  else if (!data.result) body = <div className="widget-empty"><Spinner /></div>;
  else if (w.type === "metric") {
    const v = data.result.groups[0]?.values.v ?? null;
    const p = data.prev?.groups[0]?.values.v ?? null;
    const ch = data.prev ? change(typeof v === "number" ? v : null, typeof p === "number" ? p : null) : null;
    body = (
      <button className="metric" onClick={() => drill([], "")} disabled={preview}>
        <span className="metric-value">{formatMetric(v, w.metric!.fn, metricField)}</span>
        {ch && (
          <span className={"metric-change " + ch.dir}>
            {ch.dir === "up" ? "▲" : ch.dir === "down" ? "▼" : ""} {ch.pct === null ? "" : `${Math.abs(ch.pct)}%`} vs previous period ({formatMetric(p, w.metric!.fn, metricField)})
          </span>
        )}
      </button>
    );
  } else if (!data.result.groups.length) body = <div className="widget-empty muted">No data</div>;
  else if (w.type === "pivot") {
    const two = !!w.colFieldId;
    const p = pivotData(data.result, two);
    body = (
      <div className="pivot-wrap">
        <table className="pivot">
          {two && (
            <thead>
              <tr><th />{p.cols.map(c => <th key={JSON.stringify(c)}>{keyLabel(c, w.colBucket)}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {p.rows.map(r => (
              <tr key={JSON.stringify(r)}>
                <th>{keyLabel(r, w.rowBucket)}</th>
                {p.cols.map(c => {
                  const v = p.value(r, c);
                  const label = two ? `${keyLabel(r, w.rowBucket)}, ${keyLabel(c, w.colBucket)}` : keyLabel(r, w.rowBucket);
                  return (
                    <td key={JSON.stringify(c)}>
                      {v === null ? "" : preview ? formatMetric(v, w.metric!.fn, metricField) : <button className="cell-link" onClick={() => drill(two ? [r, c] : [r], label)}>{formatMetric(v, w.metric!.fn, metricField)}</button>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else {
    const xId = w.type === "pie" ? w.groupFieldId : w.xFieldId;
    const xField = field(xId);
    const bucket = q?.groupBy?.[0]?.bucket;
    const two = !!w.seriesFieldId && w.type !== "pie";
    const cd = chartData(data.result, { twoLevels: two, bucket, range });
    const option = chartOption(w, cd, { xField, seriesField: field(w.seriesFieldId), bucket, seriesBucket: q?.groupBy?.[1]?.bucket, label: w.metric ? metricLabel(w.metric, metricField) : "", theme: theme(), format });
    body = (
      <Chart
        option={option}
        onPick={preview ? undefined : (si, di) => {
          const key = drillKey(cd, two, si, di);
          drill(key, key.map(k => keyLabel(k, bucket)).join(", "));
        }}
      />
    );
  }

  return (
    <div className="widget">
      <div className="widget-head">
        <span className="widget-title" title={title}>{title}</span>
        {editable && !preview && onMenu && (
          <button className="icon-btn widget-menu-btn" onClick={e => onMenu(e.currentTarget)} aria-label="Widget options"><Icon name="dots" size={14} /></button>
        )}
      </div>
      <div className="widget-body">{body}</div>
      {data.result?.truncated && <div className="widget-foot muted small">Showing the top {data.result.groups.length} groups</div>}
    </div>
  );
}
```

- [ ] **Step 3: Drill list**

`DrillList.tsx`:

```tsx
// The records behind one number on a dashboard; a click opens the record.
import { useEffect, useState } from "react";
import type { Field, Row } from "../../shared/types";
import { displayCell } from "../../shared/cells";
import type { AggregateInput, GroupKey } from "../../worker/base/aggregate";
import { useBase, type BaseClient } from "../base/client";
import { Modal, Spinner } from "../ui";

export interface Drill {
  tableId: string;
  query: AggregateInput;
  key: GroupKey[];
  title: string;
}

const rawOf = (f: Field, r: Row) => (f.type === "createdTime" ? r.createdAt : f.type === "modifiedTime" ? r.updatedAt : f.type === "autonumber" ? r.id : r.cells[f.id]);

export function DrillList({ client, drill, onClose, onOpen }: { client: BaseClient; drill: Drill; onClose: () => void; onOpen: (tableId: string, id: number) => void }) {
  useBase(client);
  const [st, setSt] = useState<{ ids?: number[]; truncated?: boolean; error?: string }>({});
  useEffect(() => {
    client
      .aggregateRecords(drill.tableId, drill.query, drill.key)
      .then(r => {
        setSt(r);
        client.ensureRows(drill.tableId, r.ids);
      })
      .catch(e => setSt({ error: e instanceof Error ? e.message : String(e) }));
  }, [client, drill]);
  const view = client.viewsOf(drill.tableId)[0];
  const fields = view ? client.visibleFields(view).slice(0, 4) : [];
  return (
    <Modal title={drill.title} onClose={onClose} width={760}>
      {st.error ? (
        <p className="danger-text">{st.error}</p>
      ) : !st.ids ? (
        <div className="widget-empty"><Spinner /></div>
      ) : !st.ids.length ? (
        <p className="muted">No records</p>
      ) : (
        <>
          <p className="muted small">{st.truncated ? "Showing the first 500 records" : `${st.ids.length} record${st.ids.length === 1 ? "" : "s"}`}</p>
          <div className="drill-wrap">
            <table className="drill-table">
              <thead><tr>{fields.map(f => <th key={f.id}>{f.name}</th>)}</tr></thead>
              <tbody>
                {st.ids.map(id => {
                  const r = client.row(drill.tableId, id);
                  return (
                    <tr key={id} tabIndex={0} onClick={() => onOpen(drill.tableId, id)} onKeyDown={e => e.key === "Enter" && onOpen(drill.tableId, id)}>
                      {fields.map(f => <td key={f.id}>{r ? displayCell(f, rawOf(f, r), { userName: u => client.memberName(u) }) : "..."}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
```

- [ ] **Step 4: Widget editor**

`WidgetEditor.tsx`:

```tsx
// Side panel that edits one widget with a live preview; Save sends only what changed.
import { useEffect, useState, type ReactNode } from "react";
import type { AggFn, DateBucket, Field, Widget, WidgetType } from "../../shared/types";
import { isDateField } from "../../shared/types";
import { WIDGET_TYPES } from "../../shared/widgets";
import { FilterEditor } from "../base/FilterEditor";
import type { BaseClient } from "../base/client";
import { Button, Icon } from "../ui";
import { toastError } from "../toast";
import type { DayRange, RangePreset } from "./dateRange";
import { FN_LABELS, fieldsForFn, groupable, widgetPatch, WIDGET_LABELS } from "./edit";
import { defaultTitle, WidgetCard } from "./WidgetCard";

const BUCKETS: DateBucket[] = ["day", "week", "month", "year"];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="dash-field">
      <span className="dash-field-label">{label}</span>
      {children}
    </label>
  );
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function WidgetEditor({ client, dashboardId, widget, range, preset, onClose }: { client: BaseClient; dashboardId: string; widget: Widget; range: DayRange | null; preset: RangePreset; onClose: () => void }) {
  const [draft, setDraft] = useState<Widget>(widget);
  const preview = useDebounced(draft, 300);
  const set = (patch: Partial<Widget>) => setDraft(d => ({ ...d, ...patch }));
  const fields = draft.tableId ? client.fields(draft.tableId) : [];
  const groups = fields.filter(groupable);
  const dates = fields.filter(isDateField);
  const isDate = (id?: string) => !!id && dates.some(f => f.id === id);
  const save = () => {
    const patch = widgetPatch(widget, draft);
    if (!Object.keys(patch).length) return onClose();
    client.schemaOp({ op: "updateWidget", dashboardId, widgetId: widget.id, patch }).then(onClose).catch(toastError);
  };
  const fieldSelect = (value: string | undefined, onChange: (v: string | undefined) => void, options: Field[], empty?: string) => (
    <select className="input" value={value ?? ""} onChange={e => onChange(e.target.value || undefined)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {!value && empty === undefined && <option value="">Choose a field</option>}
      {options.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  );
  const bucketSelect = (fieldId: string | undefined, value: DateBucket | undefined, onChange: (b: DateBucket) => void) =>
    isDate(fieldId) && (
      <select className="input" value={value ?? "month"} onChange={e => onChange(e.target.value as DateBucket)} aria-label="Date bucket">
        {BUCKETS.map(b => <option key={b} value={b}>{`By ${b}`}</option>)}
      </select>
    );
  const fn = draft.metric?.fn ?? "count";
  const fnFields = fieldsForFn(fn, fields);
  const check = (key: "compare" | "stacked" | "horizontal" | "area" | "donut", label: string) => (
    <label className="dash-check"><input type="checkbox" checked={!!draft[key]} onChange={e => set({ [key]: e.target.checked || undefined })} /> {label}</label>
  );

  return (
    <aside className="dash-editor" role="dialog" aria-label="Edit widget">
      <div className="dash-editor-head">
        <strong>Edit widget</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="dash-editor-body">
        <div className="dash-editor-preview">
          <WidgetCard client={client} widget={preview} range={range} preset={preset} editable={false} preview onDrill={() => undefined} />
        </div>
        <Row label="Type">
          <select className="input" value={draft.type} onChange={e => set({ type: e.target.value as WidgetType })}>
            {WIDGET_TYPES.map(t => <option key={t} value={t}>{WIDGET_LABELS[t]}</option>)}
          </select>
        </Row>
        <Row label="Title">
          <input className="input" value={draft.title} placeholder={defaultTitle(draft, client)} onChange={e => set({ title: e.target.value })} />
        </Row>
        {draft.type === "text" ? (
          <Row label="Text (Markdown)">
            <textarea className="input" rows={12} value={draft.text ?? ""} onChange={e => set({ text: e.target.value })} />
          </Row>
        ) : (
          <>
            <Row label="Table">
              <select
                className="input"
                value={draft.tableId ?? ""}
                onChange={e => set({ tableId: e.target.value || undefined, viewId: undefined, filters: undefined, dateFieldId: undefined, metric: { fn: "count" }, xFieldId: undefined, seriesFieldId: undefined, groupFieldId: undefined, rowFieldId: undefined, colFieldId: undefined })}
              >
                {!draft.tableId && <option value="">Choose a table</option>}
                {client.schema.tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Row>
            {draft.tableId && (
              <>
                <Row label="Records">
                  <select className="input" value={draft.viewId ?? ""} onChange={e => set({ viewId: e.target.value || undefined })}>
                    <option value="">All records</option>
                    {client.viewsOf(draft.tableId).filter(v => v.type !== "form").map(v => <option key={v.id} value={v.id}>{`In view ${v.name}`}</option>)}
                  </select>
                </Row>
                <div className="dash-field">
                  <span className="dash-field-label">Filter</span>
                  <FilterEditor fields={fields} spec={draft.filters ?? { conjunction: "and", conditions: [] }} onChange={next => set({ filters: next.conditions.length ? next : undefined })} emptyText="No extra filters." />
                </div>
                <Row label="Date range applies to">{fieldSelect(draft.dateFieldId, v => set({ dateFieldId: v }), dates, "Not affected by the date range")}</Row>
                <Row label="Value">
                  <div className="dash-inline">
                    <select className="input" value={fn} onChange={e => {
                      const next = e.target.value as AggFn;
                      const ok = fieldsForFn(next, fields);
                      set({ metric: { fn: next, fieldId: next === "count" ? undefined : ok.some(f => f.id === draft.metric?.fieldId) ? draft.metric?.fieldId : ok[0]?.id } });
                    }}>
                      {(Object.keys(FN_LABELS) as AggFn[]).map(f => <option key={f} value={f}>{FN_LABELS[f]}</option>)}
                    </select>
                    {fn !== "count" && fieldSelect(draft.metric?.fieldId, v => set({ metric: { fn, fieldId: v } }), fnFields)}
                  </div>
                </Row>
                {draft.type === "metric" && check("compare", "Compare with the previous period")}
                {(draft.type === "bar" || draft.type === "line") && (
                  <>
                    <Row label={draft.type === "bar" && draft.horizontal ? "Bars" : "X axis"}>
                      <div className="dash-inline">{fieldSelect(draft.xFieldId, v => set({ xFieldId: v }), groups)}{bucketSelect(draft.xFieldId, draft.bucket, b => set({ bucket: b }))}</div>
                    </Row>
                    <Row label="Split into series by">{fieldSelect(draft.seriesFieldId, v => set({ seriesFieldId: v }), groups.filter(f => f.id !== draft.xFieldId), "No series")}</Row>
                    <Row label="Order">
                      <select className="input" value={draft.sort ?? (isDate(draft.xFieldId) ? "key" : "value")} onChange={e => set({ sort: e.target.value as "value" | "key" })}>
                        <option value="value">Largest first</option>
                        <option value="key">By label</option>
                      </select>
                    </Row>
                    {!draft.seriesFieldId && (
                      <Row label="Show at most">
                        <input className="input" type="number" min={1} max={1000} value={draft.limit ?? ""} placeholder="All groups" onChange={e => set({ limit: e.target.value ? Math.max(1, Math.min(1000, Math.round(+e.target.value))) : undefined })} />
                      </Row>
                    )}
                    {check("stacked", "Stacked")}
                    {draft.type === "bar" ? check("horizontal", "Horizontal") : check("area", "Fill area")}
                  </>
                )}
                {draft.type === "pie" && (
                  <>
                    <Row label="Slices by">
                      <div className="dash-inline">{fieldSelect(draft.groupFieldId, v => set({ groupFieldId: v }), groups)}{bucketSelect(draft.groupFieldId, draft.bucket, b => set({ bucket: b }))}</div>
                    </Row>
                    <Row label="Slices before Other">
                      <input className="input" type="number" min={1} max={1000} value={draft.limit ?? 10} onChange={e => set({ limit: e.target.value ? Math.max(1, Math.min(1000, Math.round(+e.target.value))) : undefined })} />
                    </Row>
                    {check("donut", "Donut")}
                  </>
                )}
                {draft.type === "pivot" && (
                  <>
                    <Row label="Rows">
                      <div className="dash-inline">{fieldSelect(draft.rowFieldId, v => set({ rowFieldId: v }), groups)}{bucketSelect(draft.rowFieldId, draft.rowBucket, b => set({ rowBucket: b }))}</div>
                    </Row>
                    <Row label="Columns">
                      <div className="dash-inline">{fieldSelect(draft.colFieldId, v => set({ colFieldId: v }), groups.filter(f => f.id !== draft.rowFieldId), "No columns")}{bucketSelect(draft.colFieldId, draft.colBucket, b => set({ colBucket: b }))}</div>
                    </Row>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      <div className="dash-editor-foot">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save}>Save</Button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Dashboard page**

Replace `DashboardPage.tsx`:

```tsx
// A dashboard: date range, layout editing, widgets on a 12-column grid, the widget editor and drill-down.
import { useEffect, useMemo, useState } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { Dashboard, Widget, WidgetType } from "../../shared/types";
import { WIDGET_TYPES } from "../../shared/widgets";
import { useBase, type BaseClient } from "../base/client";
import { localDay } from "../base/dates";
import { Button, Menu, type MenuItem } from "../ui";
import { toastError } from "../toast";
import { PRESET_LABELS, presetRange, type DayRange, type RangePreset } from "./dateRange";
import { DrillList, type Drill } from "./DrillList";
import { starterWidget, WIDGET_LABELS } from "./edit";
import { changedPositions, layoutOf, MOBILE_BREAK, ROW_H, stackOrder, type GridItem } from "./layout";
import { WidgetCard } from "./WidgetCard";
import { WidgetEditor } from "./WidgetEditor";
import "./dash.css";

interface RangeState {
  preset: RangePreset;
  custom?: DayRange;
}

const rangeKey = (id: string) => "rf-dash-range:" + id;

function loadRange(id: string): RangeState {
  try {
    const v = JSON.parse(localStorage.getItem(rangeKey(id)) ?? "null");
    if (v && typeof v.preset === "string" && v.preset in PRESET_LABELS) return v;
  } catch {
    // Storage can be unavailable (private mode); fall back to all time.
  }
  return { preset: "all" };
}

function saveRange(id: string, r: RangeState) {
  try {
    localStorage.setItem(rangeKey(id), JSON.stringify(r));
  } catch {
    // Not saved; the range still applies for this visit.
  }
}

export default function DashboardPage({ client, dashboard, onExpand }: { client: BaseClient; dashboard: Dashboard; onExpand: (tableId: string, rowId: number) => void }) {
  useBase(client);
  const [rangeState, setRangeState] = useState(() => loadRange(dashboard.id));
  const range = useMemo(() => presetRange(rangeState.preset, localDay(), rangeState.custom), [rangeState]);
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: (MenuItem | "sep")[] } | null>(null);
  const [local, setLocal] = useState<GridItem[] | null>(null);
  const { width, containerRef, mounted } = useContainerWidth();
  const mobile = width > 0 && width < MOBILE_BREAK;
  const widgets = dashboard.widgets;
  useEffect(() => setLocal(null), [widgets]);
  useEffect(() => {
    if (mobile) setEditing(false);
  }, [mobile]);

  const setRange = (r: RangeState) => {
    setRangeState(r);
    saveRange(dashboard.id, r);
  };
  const run = (op: Parameters<BaseClient["schemaOp"]>[0]) => client.schemaOp(op);
  const add = (type: WidgetType) =>
    run({ op: "addWidget", dashboardId: dashboard.id, widget: starterWidget(type, client.schema) })
      .then(r => r.id && setEditor(r.id))
      .catch(toastError);
  const saveLayout = (layout: readonly GridItem[]) => {
    const items = changedPositions(widgets, layout);
    if (items.length) run({ op: "setLayout", dashboardId: dashboard.id, items }).catch(e => (setLocal(null), toastError(e)));
  };
  const widgetMenu = (anchor: HTMLElement, w: Widget) =>
    setMenu({
      anchor,
      items: [
        { label: "Edit", icon: "edit", onClick: () => setEditor(w.id) },
        {
          label: "Duplicate",
          icon: "copy",
          onClick: () => {
            const { id: _id, x: _x, y: _y, ...rest } = w;
            run({ op: "addWidget", dashboardId: dashboard.id, widget: rest }).catch(toastError);
          },
        },
        "sep",
        {
          label: "Delete",
          icon: "trash",
          danger: true,
          onClick: () => {
            if (window.confirm("Delete this widget?")) run({ op: "removeWidget", dashboardId: dashboard.id, widgetId: w.id }).catch(toastError);
          },
        },
      ],
    });
  const addMenu = (anchor: HTMLElement) => setMenu({ anchor, items: WIDGET_TYPES.map(t => ({ label: WIDGET_LABELS[t], onClick: () => add(t) })) });

  const card = (w: Widget) => (
    <WidgetCard client={client} widget={w} range={range} preset={rangeState.preset} editable={client.writable} onEdit={() => setEditor(w.id)} onMenu={a => widgetMenu(a, w)} onDrill={setDrill} />
  );
  const editingWidget = editor ? widgets.find(w => w.id === editor) : undefined;

  return (
    <div className="dash-page">
      <div className="dash-bar">
        <h2 className="dash-title">{dashboard.name}</h2>
        <div className="grow" />
        <select className="input dash-range" value={rangeState.preset} onChange={e => setRange({ ...rangeState, preset: e.target.value as RangePreset })} aria-label="Date range">
          {(Object.keys(PRESET_LABELS) as RangePreset[]).map(p => <option key={p} value={p}>{PRESET_LABELS[p]}</option>)}
        </select>
        {rangeState.preset === "custom" && (
          <>
            <input className="input" type="date" aria-label="From" value={rangeState.custom?.from ?? ""} onChange={e => setRange({ ...rangeState, custom: { from: e.target.value, to: rangeState.custom?.to ?? e.target.value } })} />
            <input className="input" type="date" aria-label="To" value={rangeState.custom?.to ?? ""} onChange={e => setRange({ ...rangeState, custom: { from: rangeState.custom?.from ?? e.target.value, to: e.target.value } })} />
          </>
        )}
        {client.writable && !mobile && widgets.length > 0 && (
          <Button small variant={editing ? "primary" : "default"} icon={editing ? undefined : "edit"} onClick={() => setEditing(x => !x)}>{editing ? "Done" : "Edit layout"}</Button>
        )}
        {client.writable && <Button small icon="plus" onClick={e => addMenu(e.currentTarget)}>Add widget</Button>}
      </div>
      <div className={"dash-canvas" + (editing ? " editing" : "")} ref={containerRef}>
        {widgets.length === 0 && (
          <div className="dash-empty">
            <p className="muted">This dashboard has no widgets yet.</p>
            {client.writable && <Button variant="primary" icon="plus" onClick={e => addMenu(e.currentTarget)}>Add widget</Button>}
          </div>
        )}
        {mounted && widgets.length > 0 && (mobile ? (
          <div className="dash-stack">
            {stackOrder(widgets).map(w => <div key={w.id} className="dash-stack-item" style={{ height: Math.max(2, w.h) * ROW_H }}>{card(w)}</div>)}
          </div>
        ) : (
          <ReactGridLayout
            layout={local ?? layoutOf(widgets)}
            width={width}
            gridConfig={{ cols: 12, rowHeight: ROW_H, margin: [12, 12] }}
            dragConfig={{ enabled: editing, cancel: ".widget-menu-btn" }}
            resizeConfig={{ enabled: editing }}
            onLayoutChange={l => editing && setLocal([...l] as GridItem[])}
            onDragStop={l => saveLayout(l as readonly GridItem[])}
            onResizeStop={l => saveLayout(l as readonly GridItem[])}
          >
            {widgets.map(w => <div key={w.id}>{card(w)}</div>)}
          </ReactGridLayout>
        ))}
      </div>
      {editingWidget && <WidgetEditor key={editingWidget.id} client={client} dashboardId={dashboard.id} widget={editingWidget} range={range} preset={rangeState.preset} onClose={() => setEditor(null)} />}
      {drill && <DrillList client={client} drill={drill} onClose={() => setDrill(null)} onOpen={onExpand} />}
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
```

- [ ] **Step 6: Styles**

`dash.css` (use the existing tokens from `styles.css`):

```css
.dash-page { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
.dash-bar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
.dash-title { margin: 0; font-size: 16px; font-weight: 600; }
.dash-range { width: auto; }
.dash-canvas { flex: 1; overflow: auto; padding: 4px 4px 24px; position: relative; }
.dash-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 80px 16px; }
.dash-stack { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; }
.widget { height: 100%; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.dash-canvas.editing .widget { border-style: dashed; cursor: move; }
.widget-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 0 12px; min-height: 32px; }
.widget-title { flex: 1; font-weight: 600; font-size: 13px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.widget-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.widget-foot { padding: 0 12px 6px; }
.widget-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 8px; text-align: center; }
.widget-empty p { margin: 0; }
.widget-text { padding: 4px 14px 10px; overflow: auto; }
.widget-text h1, .widget-text h2, .widget-text h3 { margin: 4px 0 8px; }
.chart { flex: 1; min-height: 0; width: 100%; }
.metric { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 4px; padding: 0 14px 10px; background: none; border: 0; text-align: left; cursor: pointer; font: inherit; color: inherit; }
.metric:disabled { cursor: default; }
.metric-value { font-size: 30px; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; }
.metric-change { font-size: 12px; color: var(--muted); }
.metric-change.up { color: var(--ok); }
.metric-change.down { color: var(--danger); }
.pivot-wrap { flex: 1; overflow: auto; padding: 0 12px 10px; }
.pivot { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
.pivot th, .pivot td { border-bottom: 1px solid var(--line); padding: 5px 8px; text-align: right; white-space: nowrap; }
.pivot th:first-child { text-align: left; font-weight: 500; }
.pivot thead th { color: var(--muted); font-weight: 500; }
.cell-link { background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.cell-link:hover { color: var(--accent-ink); text-decoration: underline; }
.dash-editor { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow); display: flex; flex-direction: column; z-index: 40; }
.dash-editor-head, .dash-editor-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.dash-editor-foot { border-top: 1px solid var(--line); border-bottom: 0; justify-content: flex-end; }
.dash-editor-body { flex: 1; overflow: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.dash-editor-preview { height: 220px; flex: none; }
.dash-field { display: flex; flex-direction: column; gap: 4px; }
.dash-field-label { font-size: 12px; color: var(--muted); }
.dash-inline { display: flex; gap: 6px; }
.dash-inline > * { flex: 1; min-width: 0; }
.dash-check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.drill-wrap { max-height: 60vh; overflow: auto; }
.drill-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.drill-table th, .drill-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drill-table tbody tr { cursor: pointer; }
.drill-table tbody tr:hover, .drill-table tbody tr:focus { background: var(--panel-2); outline: none; }
.dash-tab button:first-child { display: inline-flex; align-items: center; gap: 5px; }
@media (max-width: 767px) {
  .dash-bar { padding: 8px 16px; }
  .dash-editor { width: 100vw; }
}
```

If `danger-text` does not exist in `styles.css`, add `.danger-text { color: var(--danger); }` there.

- [ ] **Step 7: Verify build and bundle split**

Run: `npm run typecheck && npm test 2>&1 | tail -5 && npm run build:web 2>&1 | tail -15`
Expected: clean, tests pass, build succeeds. Then: `grep -l "zrender" dist/client/assets/*.js` lists only the dashboard chunk(s), and `grep -c "DashboardPage\|zrender" dist/client/assets/BasePage-*.js` shows BasePage only references the lazy chunk by file name (no ECharts code). Record chunk sizes (gzip) of the dashboard chunk in the ledger.

- [ ] **Step 8: UI check (Playwright MCP against `npm run dev`)**

In base "Views QA" (or a CRM-template base created for the check) build a dashboard with: a number (count, compare on, date field set), a bar chart by a select field, a line chart by month of a date field with a series, a pie, a pivot with rows and columns, and a text block. For each, check real numbers against the API (`POST /api/bases/:id/aggregate` from the page with `fetch`) and take a screenshot. Then:
- drag one widget and resize another in "Edit layout"; reload; positions kept;
- switch the date range to "This month" and "Last 30 days"; numbers change to match the API with the same range;
- click a bar, a pie slice, a pivot cell and the number: the drill list count equals the number; open a record from it; the record modal opens above the list;
- edit a record's value in a second tab (or through the API) and see the affected widget refresh within about 2 s, and an unrelated table's change not re-query it (watch network requests);
- sign in as a viewer: no "Add widget", no "Edit layout", no widget menu; drill-down works;
- resize the window to 390 px wide: one column, read only;
- the text block renders Markdown, and `<script>` typed into it shows as text;
- delete a field used by a widget: the widget shows "The data source changed; pick another".
Save screenshots to `docs/verification/img/dashboards-<scenario>.png` (1440x900, plus the 390 px shot). Fix any defect found (each with a failing unit or worker test first when the defect is in testable code) and ledger it.

- [ ] **Step 9: Checkpoint**

Ledger the test count, the bundle check and the UI scenarios with their results.

---

### Task 10: Bench and docs

**Files:**
- Modify: `src/worker/bench.ts`, `bench/run.mjs`
- Modify: `README.md`, `docs/architecture.md`

- [ ] **Step 1: Bench ops**

`bench.ts` `op` switch (import `AggregateInput` type):

```ts
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
```

`run.mjs` `OPS`: add `["dashboard_8", "Dashboard: 8 widgets, cache empty"]` and `["dashboard_8_cached", "Dashboard: 8 widgets, cached"]` after `group_two_sum`.

- [ ] **Step 2: Run the bench**

Start `npx wrangler dev` (the BENCH_TOKEN comes from `.dev.vars`), then `BENCH_TOKEN=<value> npm run bench > <scratchpad>/bench.txt`. Expected: `dashboard_8` under 3,000 ms and `dashboard_8_cached` under 500 ms (spec success criteria). Record the full table and the machine (`sysctl -n machdep.cpu.brand_string`, `node -v`) in the ledger; Task 11 copies them into the verification record.

- [ ] **Step 3: Docs**

- `README.md` features list: add `- **Dashboards**: number, bar, line, pie and summary-table widgets over any table, a shared date range, and click-through to the records behind each number.` next to the views bullet.
- `docs/architecture.md` Aggregation section: a paragraph on `range`, `sort: "key"`, `limit` and `other`, drill-down reusing `Aggregator.keysOf`, the 200-entry result cache cleared on any write or schema change and why it is base-wide; add the two dashboard rows to the performance table with the local numbers and date.

- [ ] **Step 4: Checkpoint**

Run: `npm test 2>&1 | tail -5`; ledger.

---

### Task 11: Verification records (all three features)

**Files:**
- Create: `scripts/verify.mjs`
- Modify: `package.json` (`"verify": "node scripts/verify.mjs"`)
- Create: `docs/verification/README.md`, `docs/verification/mcp.md`, `docs/verification/views.md`, `docs/verification/dashboards.md`, `docs/verification/results.json`, `docs/verification/img/*.png`

**Interfaces:**
- Produces `results.json`: array of `{ feature, title, date, tests: { files, total, passed, failed }, bench: { action, ms, rows, env }[], scenarios: { name, checked, result, image? }[] }`. `npm run verify` rewrites `date` and `tests` per feature and keeps `bench` and `scenarios`.

- [ ] **Step 1: Write `scripts/verify.mjs`**

```js
// Runs the whole test suite with the JSON reporter and records per-feature test counts in docs/verification/results.json.
// Usage: npm run verify [-- --list]   (--list prints which tests count toward each feature)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const RESULTS = "docs/verification/results.json";
const TITLES = { dashboards: "Dashboards", views: "Calendar, timeline, gallery and grid grouping", mcp: "MCP server", core: "Core engine and API" };
// First match wins, so feature-specific files come before the name rules that pick part 2 tests out of the shared engine and API files.
const FEATURES = [
  { feature: "dashboards", match: t => /(dashboards|mcp-dashboards|widgets|dash)\.test\.ts$/.test(t.file) },
  { feature: "mcp", match: t => /mcp\.test\.ts$/.test(t.file) && !/calendar|timeline|gallery/i.test(t.name) },
  { feature: "views", match: t => /(dates|gridGroups|lanes)\.test\.ts$/.test(t.file) || /\brange\b|group levels|calendar|timeline|gallery|fan-out|grouped rows|view reference|honors search|aggregate route/i.test(t.name) },
  { feature: "core", match: () => true },
];

const out = join(mkdtempSync(join(tmpdir(), "rf-verify-")), "vitest.json");
try {
  execFileSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${out}`], { stdio: ["ignore", "ignore", "inherit"] });
} catch {
  // Failing tests still write the report; they are counted below.
}
const report = JSON.parse(readFileSync(out, "utf8"));
const tests = report.testResults.flatMap(f => f.assertionResults.map(a => ({ file: relative(process.cwd(), f.name), name: a.fullName ?? a.title, status: a.status })));
const by = Object.fromEntries(FEATURES.map(f => [f.feature, []]));
for (const t of tests) by[FEATURES.find(f => f.match(t)).feature].push(t);

if (process.argv.includes("--list")) {
  for (const [k, list] of Object.entries(by)) console.log(`\n## ${k} (${list.length})\n` + list.map(t => `  ${t.status === "passed" ? "ok  " : "FAIL"} ${t.file} > ${t.name}`).join("\n"));
}

let results = [];
try {
  results = JSON.parse(readFileSync(RESULTS, "utf8"));
} catch {
  // First run.
}
const date = new Date().toISOString().slice(0, 10);
for (const [feature, list] of Object.entries(by)) {
  let entry = results.find(r => r.feature === feature);
  if (!entry) results.push((entry = { feature, title: TITLES[feature], bench: [], scenarios: [] }));
  entry.date = date;
  entry.tests = { files: new Set(list.map(t => t.file)).size, total: list.length, passed: list.filter(t => t.status === "passed").length, failed: list.filter(t => t.status === "failed").length };
}
writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
for (const r of results) console.log(`${r.feature.padEnd(11)} ${r.tests.passed}/${r.tests.total} passed in ${r.tests.files} files`);
if (tests.some(t => t.status === "failed")) process.exitCode = 1;
```

- [ ] **Step 2: Run it and review the mapping**

Run: `npm run verify -- --list > <scratchpad>/verify-list.txt; tail -5 <scratchpad>/verify-list.txt`
Expected: every test passes; the "views" list holds every test added in part 2 (`docs/superpowers/plans/2026-10-13-views.md` names them) and no core test; "mcp" holds the MCP tests. Adjust the name rules until the lists are right, and ledger the final rule set.

- [ ] **Step 3: Backfill bench and UI evidence for MCP and views**

- Views: from the Task 10 bench run, copy the `calendar_month`, `group_two_sum` and `aggregate` rows. With the Playwright MCP against `wrangler dev`, in base "Views QA": calendar month with records in place, calendar week, timeline with lanes, gallery, grid grouped by 2 levels with summaries, one phone-width shot. Save as `docs/verification/img/views-<scenario>.png`; check each scenario as in part 2 (records in the right place, sums equal the API).
- MCP: run a JSON-RPC `tools/list` and one `aggregate` call against `http://127.0.0.1:8787/mcp` with a personal access token (`curl` with `Authorization: Bearer`), and record the tool count and the call's result summary; no screenshot (no UI). Record the bundle size note from part 1 (327 KiB gzip Worker).
- Dashboards: the Task 9 screenshots and scenarios, the Task 10 bench rows.

Every bench entry has `env: "local wrangler dev, <cpu>, node <version>"` and `rows: 50000`; the Markdown pages state that local numbers are not production numbers.

- [ ] **Step 4: Write the records**

`docs/verification/README.md`: what the folder is, how to refresh (`npm run verify` for tests; bench with `npm run bench`; UI scenarios by hand with Playwright), and the rule that local numbers are labeled local.

Each `docs/verification/<feature>.md` has, in this order: title and date; "What was tested" (one line per capability); "How" (unit, worker integration in workerd, UI with Playwright against `wrangler dev`, bench); "Results" (tests passed/total from `results.json`, bench table with environment, UI scenarios table with what was checked, result and screenshot link); "Known limits" (the deferred minors relevant to the feature, from the plan ledgers and the part 2 final report). Fill `scenarios` and `bench` in `results.json` to match.

- [ ] **Step 5: Verify**

Run: `npm run verify && npm run typecheck && npm run build:web 2>&1 | tail -3`
Expected: all pass; `results.json` lists four features with passing counts and the bench and scenario entries; every image path in the Markdown files exists (`ls docs/verification/img`).

- [ ] **Step 6: Checkpoint**

Ledger the final test count per feature.
