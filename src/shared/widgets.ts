// Dashboard widgets: default sizes, the aggregate request each widget runs, and checks shared by the Worker and the client.
import type { DateBucket, Field, FilterSpec, View, Widget, WidgetType } from "./types";
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

/** Settings that decide what a widget counts; only changes to these are checked against the schema. */
export const SOURCE_KEYS: (keyof Widget)[] = ["type", "tableId", "viewId", "filters", "dateFieldId", "metric", "xFieldId", "seriesFieldId", "groupFieldId", "rowFieldId", "colFieldId"];

/**
 * Returns why a widget cannot be saved, or null. Unfinished widgets are allowed; broken references are not,
 * unless `source` is false: moving or renaming a widget whose field was deleted must still work.
 */
const TEXT_KEYS = ["id", "type", "title", "tableId", "viewId", "dateFieldId", "xFieldId", "bucket", "seriesFieldId", "sort", "groupFieldId", "rowFieldId", "colFieldId", "rowBucket", "colBucket", "text"];
const NUMBER_KEYS = ["x", "y", "w", "h", "limit"];
const BOOL_KEYS = ["compare", "stacked", "horizontal", "area", "donut"];
const KNOWN = new Set([...TEXT_KEYS, ...NUMBER_KEYS, ...BOOL_KEYS, "filters", "metric"]);
const MAX_WIDGET_BYTES = 32 * 1024;

const isFilterSpec = (f: unknown): boolean => {
  const spec = f as FilterSpec;
  return !!spec && typeof spec === "object" && (spec.conjunction === "and" || spec.conjunction === "or") && Array.isArray(spec.conditions) && spec.conditions.every(c => !!c && typeof c === "object" && typeof c.fieldId === "string" && typeof c.op === "string");
};

/** Settings sent to the API are JSON: only known keys of the right type, and a bounded size. */
function shapeProblem(w: Widget): string | null {
  for (const [k, v] of Object.entries(w)) {
    if (v === undefined) continue;
    if (!KNOWN.has(k)) return `Unknown widget setting "${k}"`;
    if (TEXT_KEYS.includes(k) && typeof v !== "string") return `"${k}" must be text`;
    if (NUMBER_KEYS.includes(k) && typeof v !== "number") return `"${k}" must be a number`;
    if (BOOL_KEYS.includes(k) && typeof v !== "boolean") return `"${k}" must be true or false`;
  }
  if (w.filters !== undefined && !isFilterSpec(w.filters)) return "filters must be { conjunction, conditions }";
  if (w.metric !== undefined) {
    const m = w.metric as unknown as Record<string, unknown>;
    if (!m || typeof m !== "object" || typeof m.fn !== "string" || (m.fieldId !== undefined && typeof m.fieldId !== "string") || Object.keys(m).some(k => k !== "fn" && k !== "fieldId")) return "metric must be { fn, fieldId }";
  }
  if (new TextEncoder().encode(JSON.stringify(w)).length > MAX_WIDGET_BYTES) return "A widget's settings are limited to 32 KB";
  return null;
}

export function checkWidget(w: Widget, s: SchemaLike, opts: { source?: boolean } = {}): string | null {
  if (!WIDGET_TYPES.includes(w.type)) return `Unknown widget type "${w.type}"`;
  const shape = shapeProblem(w);
  if (shape) return shape;
  if (typeof w.title !== "string" || w.title.length > 200) return "Widget titles are text up to 200 characters";
  if (![w.x, w.y, w.w, w.h].every(n => Number.isInteger(n))) return "Widget position must be whole grid units";
  if (w.w < 1 || w.x < 0 || w.x + w.w > GRID_COLS) return "Widgets must fit in 12 columns";
  if (w.h < 1 || w.h > MAX_H || w.y < 0 || w.y > 10000) return "Widget height must be 1 to 12 rows";
  if (w.text !== undefined && (typeof w.text !== "string" || new TextEncoder().encode(w.text).length > MAX_TEXT)) return "Text blocks are limited to 20 KB";
  if (w.limit !== undefined && (!Number.isInteger(w.limit) || w.limit < 1 || w.limit > 1000)) return "limit must be 1 to 1000";
  if (opts.source === false) return null;
  const p = widgetProblem(w, s);
  return p?.kind === "changed" ? p.message : null;
}
