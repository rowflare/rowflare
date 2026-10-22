// Translates model-friendly input (names) into the engine's id-based structures.
import type { Field, FieldOptions, FieldType, FilterOp, FilterSpec, Member, Schema, SortSpec, View, ViewConfig, ViewType } from "../../shared/types";
import { isDateField, isNumberField } from "../../shared/types";
import { parseDate, parseNumber } from "../../shared/cells";
import { filterKind, type FilterKind } from "../base/query";
import { HttpError } from "../access";
import { fieldOf, fieldsOf, tableOf, type TableCtx } from "../records";
import type { FieldSpecOptions, FilterInput, SortInput, ViewOptionsInput } from "./schemas";
import { promptToStored, type AiServiceInfo } from "../../shared/ai";

export function choiceId(f: Field, value: unknown): string {
  const s = String(value);
  const choices = f.options.choices ?? [];
  const c = choices.find(c => c.id === s || c.name === s) ?? choices.find(c => c.name.toLowerCase() === s.toLowerCase());
  if (!c) throw new HttpError(422, `Unknown option "${s}" for field ${f.name}. Options: ${choices.map(c => c.name).join(", ")}`);
  return c.id;
}

export function userId(members: Map<string, Member>, value: unknown): string {
  const s = String(value).toLowerCase();
  for (const m of members.values()) if (m.id.toLowerCase() === s || m.email.toLowerCase() === s || m.name.toLowerCase() === s) return m.id;
  return String(value);
}

const OPS_BY_KIND: Record<FilterKind, FilterOp[]> = {
  text: ["eq", "neq", "contains", "ncontains", "gt", "gte", "lt", "lte"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte"],
  time: ["eq", "neq", "gt", "gte", "lt", "lte"],
  bool: ["eq", "neq"],
  select: ["eq", "neq", "anyOf", "noneOf"],
  array: ["eq", "neq", "contains", "ncontains", "anyOf", "noneOf", "allOf"],
};

export const MAX_FILTER_VALUES = 50;

const blank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Validates one condition against what the SQL filter supports (it silently skips anything else) and maps names to ids. */
function conditionValue(t: TableCtx, f: Field, op: FilterOp, v: unknown): unknown {
  if (op === "empty" || op === "notempty") return undefined;
  const k = filterKind(f);
  if (!OPS_BY_KIND[k].includes(op)) throw new HttpError(422, `Filter op "${op}" does not apply to field "${f.name}" (${f.type}). Use one of: ${[...OPS_BY_KIND[k], "empty", "notempty"].join(", ")}`);
  if (k === "bool") return v;
  if (blank(v)) throw new HttpError(422, `Filter op "${op}" on "${f.name}" needs a value; use empty or notempty to test for blanks`);
  if (Array.isArray(v) && v.length > MAX_FILTER_VALUES) throw new HttpError(422, `A filter value list can have at most ${MAX_FILTER_VALUES} items`);
  const each = (fn: (x: unknown) => unknown) => (Array.isArray(v) ? v.map(fn) : fn(v));
  if (k === "number" && parseNumber(v) === null) throw new HttpError(422, `Filter on "${f.name}" needs a number, got ${JSON.stringify(v)}`);
  if ((k === "date" || k === "time") && !parseDate(v, false)) throw new HttpError(422, `Filter on "${f.name}" needs a date like 2026-01-31, got ${JSON.stringify(v)}`);
  if (f.type === "link" && op !== "contains" && op !== "ncontains") {
    return each(x => {
      const n = Number(x);
      if (!Number.isInteger(n)) throw new HttpError(422, `Filter on link field "${f.name}" needs record ids (numbers); use contains to match linked record names`);
      return n;
    });
  }
  // Select cells store choice ids, so contains on a multiple select also needs the id.
  if (f.type === "singleSelect" || f.type === "multiSelect") return each(x => choiceId(f, x));
  if (f.type === "user") return each(x => userId(t.members, x));
  return v;
}

export function toFilterSpec(t: TableCtx, filter?: FilterInput): FilterSpec | undefined {
  if (!filter?.conditions.length) return undefined;
  return {
    conjunction: filter.conjunction ?? "and",
    conditions: filter.conditions.map(c => {
      const f = fieldOf(t.fields, c.field, t.table.name);
      return { fieldId: f.id, op: c.op, value: conditionValue(t, f, c.op, c.value) };
    }),
  };
}

export function toSorts(t: TableCtx, sort?: SortInput): SortSpec[] | undefined {
  if (!sort?.length) return undefined;
  return sort.map(s => ({ fieldId: fieldOf(t.fields, s.field, t.table.name).id, dir: s.direction === "desc" ? "desc" : "asc" }));
}

export function viewOf(t: TableCtx, key: string): View {
  const views = t.schema.views.filter(v => v.tableId === t.table.id);
  const v = views.find(v => v.id === key || v.name === key) ?? views.find(v => v.name.toLowerCase() === key.toLowerCase());
  if (!v) throw new HttpError(422, `Unknown view "${key}" in table ${t.table.name}. Views: ${views.map(v => v.name).join(", ")}`);
  return v;
}

export function onlyFields(t: TableCtx, keys?: string[]): Set<string> | undefined {
  return keys?.length ? new Set(keys.map(k => fieldOf(t.fields, k, t.table.name).id)) : undefined;
}

/** Types that need other fields to exist first, so create_table adds them one by one after the plain fields. */
export const COMPLEX_TYPES: ReadonlySet<FieldType> = new Set(["link", "lookup", "rollup", "formula"]);

export function toFieldOptions(schema: Schema, tableId: string, o: FieldSpecOptions | undefined, existing?: Field, services: AiServiceInfo[] = []): FieldOptions {
  const out: FieldOptions = {};
  if (!o) return out;
  if (o.precision !== undefined) out.precision = o.precision;
  if (o.format) out.format = o.format;
  if (o.symbol) out.symbol = o.symbol;
  if (o.includeTime !== undefined) out.includeTime = o.includeTime;
  if (o.multiple !== undefined) out.multiple = o.multiple;
  if (o.fn) out.fn = o.fn;
  if (o.formula !== undefined) out.formula = o.formula;
  if (o.choices) {
    // Keep ids of options that already exist (matched by name) so cells holding them survive the update.
    out.choices = o.choices.map(ch => {
      const name = typeof ch === "string" ? ch : ch.name;
      const match = (typeof ch === "string" ? undefined : ch.renameFrom) ?? name;
      const prev = existing?.options.choices?.find(c => c.name.toLowerCase() === match.toLowerCase());
      return { id: prev?.id ?? "", name, color: (typeof ch === "string" ? undefined : ch.color) ?? prev?.color ?? "" };
    });
  }
  if (o.ai) {
    const key = o.ai.service.trim().toLowerCase();
    const svc = services.find(s => s.id === o.ai!.service) ?? services.find(s => s.name.toLowerCase() === key);
    if (!svc) throw new HttpError(422, `Unknown AI service "${o.ai.service}". Services: ${services.map(s => s.name).join(", ") || "none, ask a workspace owner to add one in Settings"}`);
    const fields = fieldsOf(schema, tableId);
    const tableName = schema.tables.find(t => t.id === tableId)?.name ?? "";
    out.ai = { serviceId: svc.id, prompt: promptToStored(o.ai.prompt, fields), autoUpdate: o.ai.autoUpdate ?? true };
    if (o.ai.model) out.ai.model = o.ai.model;
    if (o.ai.imageFields?.length) out.ai.imageFieldIds = o.ai.imageFields.map(n => fieldOf(fields, n, tableName).id);
  }
  if (o.targetField && !o.linkField) throw new HttpError(422, "targetField needs linkField: the link field in this table that leads to the target's table");
  if (o.linkedTable) out.linkedTableId = tableOf(schema, o.linkedTable).id;
  if (o.linkField) {
    const table = schema.tables.find(t => t.id === tableId)!;
    const link = fieldOf(fieldsOf(schema, tableId), o.linkField, table.name);
    out.linkFieldId = link.id;
    if (o.targetField) {
      const target = schema.tables.find(t => t.id === link.options.linkedTableId);
      if (!target) throw new HttpError(422, `"${link.name}" is not a link field`);
      out.targetFieldId = fieldOf(fieldsOf(schema, target.id), o.targetField, target.name).id;
    }
  }
  return out;
}

const LANE_TYPES = new Set(["singleSelect", "user", "link"]);
const NOT_GROUPABLE = new Set(["attachment", "longText", "button", "autonumber"]);

/** View settings by name to ids, with each field checked for the role it plays. A null clears the setting (the store drops null keys). */
export function toViewConfig(t: TableCtx, v: ViewOptionsInput, viewType: ViewType): ViewConfig {
  const config: Record<string, unknown> = {};
  const field = (key: string, ok: (f: Field) => boolean, why: string) => {
    const f = fieldOf(t.fields, key, t.table.name);
    if (!ok(f)) throw new HttpError(422, why.replace("%s", `"${f.name}"`));
    return f.id;
  };
  const any = () => true;
  const set = <K extends string>(key: K, value: unknown, fn: (x: NonNullable<typeof value>) => unknown) => {
    if (value === null) config[key] = null;
    else if (value !== undefined) config[key] = fn(value as NonNullable<typeof value>);
  };
  set("filters", v.filter, x => toFilterSpec(t, x as FilterInput) ?? { conjunction: "and", conditions: [] });
  set("sorts", v.sort, x => toSorts(t, x as SortInput) ?? []);
  set("hidden", v.hiddenFields, x => (x as string[]).map(k => field(k, any, "")));
  if (v.groupBy === null) {
    config.groupFieldId = null;
    config.groups = null;
  } else if (typeof v.groupBy === "string") {
    if (viewType !== "kanban") throw new HttpError(422, "groupBy as one field name is for kanban views; grids take a list of { field, direction }");
    config.groupFieldId = field(v.groupBy, f => f.type === "singleSelect", "Kanban columns need a single select field; %s is not one");
  } else if (v.groupBy) {
    if (viewType !== "grid") throw new HttpError(422, "Grouping levels are for grid views; kanban takes one single select field name");
    config.groups = v.groupBy.map(g => ({ fieldId: field(g.field, f => !NOT_GROUPABLE.has(f.type), "%s cannot be used for grouping"), dir: g.direction ?? "asc" }));
  }
  set("dateFieldId", v.dateField, x => field(x as string, isDateField, "%s is not a date field"));
  set("endDateFieldId", v.endDateField, x => field(x as string, isDateField, "%s is not a date field"));
  set("durationFieldId", v.durationField, x => field(x as string, isNumberField, "%s is not a number field"));
  set("laneFieldId", v.laneField, x => field(x as string, f => LANE_TYPES.has(f.type), "Lanes need a single select, user or link field; %s is not one"));
  set("coverFieldId", v.coverField, x => field(x as string, f => f.type === "attachment", "A card cover needs an attachment field; %s is not one"));
  set("calendarMode", v.calendarMode, x => x);
  set("timelineScale", v.timelineScale, x => x);
  return config as ViewConfig;
}
