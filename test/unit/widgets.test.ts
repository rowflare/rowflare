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

  it("checkWidget rejects unknown settings, wrong setting types, malformed filters and oversized widgets", () => {
    expect(checkWidget({ ...base({}), color: "red" } as Widget, schema)).toBe('Unknown widget setting "color"');
    expect(checkWidget(base({ filters: {} as Widget["filters"] }), schema)).toBe("filters must be { conjunction, conditions }");
    expect(checkWidget(base({ filters: { conjunction: "and", conditions: [{ fieldId: "fldName" } as never] } }), schema)).toBe("filters must be { conjunction, conditions }");
    expect(checkWidget(base({ stacked: "yes" as unknown as boolean }), schema)).toBe('"stacked" must be true or false');
    expect(checkWidget(base({ xFieldId: 5 as unknown as string }), schema)).toBe('"xFieldId" must be text');
    expect(checkWidget(base({ metric: { fn: "count", fieldId: "fldName", extra: 1 } as never }), schema)).toBe("metric must be { fn, fieldId }");
    expect(checkWidget(base({ filters: { conjunction: "and", conditions: Array.from({ length: 300 }, () => ({ fieldId: "fldName", op: "contains" as const, value: "x".repeat(200) })) } }), schema)).toBe("A widget's settings are limited to 32 KB");
  });
});
