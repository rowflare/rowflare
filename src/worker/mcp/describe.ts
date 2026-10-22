// Schema rendered for models: names instead of internal ids, formulas with field names.
import type { Field, Schema, Table, View, ViewType } from "../../shared/types";
import { toDisplay } from "../../shared/formula";
import { promptToDisplay } from "../../shared/ai";
import { fieldsOf } from "../records";

export interface FieldInfo {
  id: string;
  name: string;
  type: Field["type"];
  description?: string;
  options?: Record<string, unknown>;
}

export interface TableInfo {
  id: string;
  name: string;
  primaryField: string | undefined;
  rowCount: number | undefined;
  fields: FieldInfo[];
  views: { id: string; name: string; type: ViewType }[];
}

export function describeField(schema: Schema, f: Field): FieldInfo {
  const o = f.options;
  const fieldName = (id?: string) => schema.fields.find(x => x.id === id)?.name;
  const options: Record<string, unknown> = {};
  switch (f.type) {
    case "number":
      if (o.precision !== undefined) options.precision = o.precision;
      if (o.format) options.format = o.format;
      if (o.symbol) options.symbol = o.symbol;
      break;
    case "singleSelect":
    case "multiSelect":
      options.choices = (o.choices ?? []).map(c => c.name);
      break;
    case "date":
      options.includeTime = !!o.includeTime;
      break;
    case "link":
      options.linkedTable = schema.tables.find(t => t.id === o.linkedTableId)?.name;
      options.inverseField = fieldName(o.inverseFieldId);
      break;
    case "lookup":
    case "rollup":
      options.linkField = fieldName(o.linkFieldId);
      options.targetField = fieldName(o.targetFieldId);
      if (f.type === "rollup") options.fn = o.fn;
      options.resultType = o.resultType;
      break;
    case "formula":
      options.formula = toDisplay(o.formula ?? "", fieldsOf(schema, f.tableId).map(x => ({ id: x.id, name: x.name })));
      options.resultType = o.resultType;
      if (o.format) options.format = o.format;
      break;
    case "user":
      options.multiple = !!o.multiple;
      break;
  }
  if (o.ai) {
    const ai = o.ai;
    options.ai = { service: ai.serviceId, ...(ai.model ? { model: ai.model } : {}), prompt: promptToDisplay(ai.prompt, fieldsOf(schema, f.tableId)), ...(ai.imageFieldIds?.length ? { imageFields: ai.imageFieldIds.map(id => fieldName(id) ?? id) } : {}), autoUpdate: ai.autoUpdate !== false };
  }
  return { id: f.id, name: f.name, type: f.type, ...(f.description ? { description: f.description } : {}), ...(Object.keys(options).length ? { options } : {}) };
}

/** A view with its settings by field name; settings are left out of describe_base, which lists every view. */
export function describeView(v: View, schema?: Schema) {
  const out: { id: string; name: string; type: ViewType; settings?: Record<string, unknown> } = { id: v.id, name: v.name, type: v.type };
  if (!schema) return out;
  const name = (id?: string) => (id ? schema.fields.find(f => f.id === id)?.name ?? id : undefined);
  const c = v.config;
  const settings: Record<string, unknown> = {
    filter: c.filters?.conditions.length ? { conjunction: c.filters.conjunction, conditions: c.filters.conditions.map(x => ({ field: name(x.fieldId), op: x.op, value: x.value })) } : undefined,
    sort: c.sorts?.length ? c.sorts.map(x => ({ field: name(x.fieldId), direction: x.dir })) : undefined,
    hiddenFields: c.hidden?.length ? c.hidden.map(name) : undefined,
    groupBy: v.type === "kanban" ? name(c.groupFieldId) : c.groups?.length ? c.groups.map(g => ({ field: name(g.fieldId), direction: g.dir })) : undefined,
    dateField: name(c.dateFieldId),
    endDateField: name(c.endDateFieldId),
    durationField: name(c.durationFieldId),
    laneField: name(c.laneFieldId),
    coverField: name(c.coverFieldId),
    calendarMode: c.calendarMode,
    timelineScale: c.timelineScale,
  };
  for (const k of Object.keys(settings)) if (settings[k] === undefined) delete settings[k];
  if (Object.keys(settings).length) out.settings = settings;
  return out;
}

export function describeTable(schema: Schema, t: Table): TableInfo {
  return {
    id: t.id,
    name: t.name,
    primaryField: schema.fields.find(f => f.id === t.primaryFieldId)?.name,
    rowCount: t.rowCount,
    fields: fieldsOf(schema, t.id).map(f => describeField(schema, f)),
    views: schema.views.filter(v => v.tableId === t.id).map(v => describeView(v)),
  };
}
