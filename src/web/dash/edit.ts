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

const POSITION = new Set(["id", "x", "y", "w", "h"]);

/** The changes from one widget to another; settings that disappeared become null so the server removes them. Positions belong to the layout and are left out. */
export function widgetPatch(before: Widget, after: Widget): WidgetPatch {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (POSITION.has(k)) continue;
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
