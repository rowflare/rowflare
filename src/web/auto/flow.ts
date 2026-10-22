// Editor logic for automations, free of React: labels, defaults, step tree edits,
// variables for the picker, and conversion between stored ids and names in templates.
import type { Field, Table } from "../../shared/types";
import { flatSteps, nextStepId, RECORD_SOURCES, triggerTableId, type AutomationConfig, type BranchOp, type ScheduleTrigger, type Step, type StepType, type Trigger, type TriggerType } from "../../shared/automations";
import { fromDisplay, toDisplay, type NameContext } from "../../shared/template";

export interface SchemaLite {
  tables: Pick<Table, "id" | "name" | "primaryFieldId">[];
  fields: Field[];
}

export const schemaLite = (schema: SchemaLite): SchemaLite => ({ tables: schema.tables, fields: schema.fields });
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  recordCreated: "When a record is created",
  recordUpdated: "When a record is updated",
  recordMatches: "When a record matches conditions",
  schedule: "At scheduled times",
  dateReached: "When a date is reached",
  webhook: "When a webhook is called",
  button: "When a button is clicked",
};
export const TRIGGER_ICONS: Record<TriggerType, string> = { recordCreated: "plus", recordUpdated: "edit", recordMatches: "filter", schedule: "clock", dateReached: "calendar", webhook: "link", button: "button" };
export const STEP_LABELS: Record<StepType, string> = { createRecord: "Create record", updateRecords: "Update records", findRecords: "Find records", http: "Send HTTP request", email: "Send email", branch: "If / otherwise", ai: "AI generate" };
export const STEP_ICONS: Record<StepType, string> = { createRecord: "plus", updateRecords: "edit", findRecords: "search", http: "link", email: "email", branch: "branch", ai: "sparkle" };
export const BRANCH_LABELS: Record<BranchOp, string> = { eq: "is", neq: "is not", contains: "contains", ncontains: "does not contain", empty: "is empty", notempty: "is not empty", gt: ">", gte: "≥", lt: "<", lte: "≤" };
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const tableName = (s: SchemaLite, id: string) => s.tables.find(t => t.id === id)?.name ?? "a deleted table";
const fieldName = (s: SchemaLite, id: string) => s.fields.find(f => f.id === id)?.name ?? "a deleted field";
const firstDate = (s: SchemaLite, tableId: string) => s.fields.find(f => f.tableId === tableId && f.type === "date")?.id ?? "";

export function defaultTrigger(type: TriggerType, s: SchemaLite, tz: string): Trigger {
  const tableId = s.tables[0]?.id ?? "";
  switch (type) {
    case "recordCreated":
    case "recordUpdated":
      return { type, tableId };
    case "recordMatches":
      return { type, tableId, conditions: { conjunction: "and", conditions: [] } };
    case "schedule":
      return { type, every: "day", at: "09:00", tz };
    case "dateReached": {
      const withDate = s.tables.find(t => firstDate(s, t.id)) ?? s.tables[0];
      return { type, tableId: withDate?.id ?? "", fieldId: withDate ? firstDate(s, withDate.id) : "", offsetMinutes: 0, at: "09:00", tz };
    }
    case "webhook":
      return { type, token: "" };
    case "button":
      return { type, tableId, viewerCanRun: false };
  }
}

/** The same trigger on another table; settings tied to the old table's fields are reset. */
export function withTable(t: Trigger, tableId: string, s: SchemaLite): Trigger {
  switch (t.type) {
    case "recordCreated":
      return { type: t.type, tableId };
    case "recordUpdated":
      return { type: t.type, tableId };
    case "recordMatches":
      return { type: t.type, tableId, conditions: { conjunction: "and", conditions: [] } };
    case "dateReached":
      return { ...t, tableId, fieldId: firstDate(s, tableId), conditions: undefined };
    case "button":
      return { ...t, tableId };
    default:
      return t;
  }
}

export function defaultStep(type: StepType, steps: Step[], trigger: Trigger, s: SchemaLite): Step {
  const id = nextStepId(steps);
  const tableId = triggerTableId(trigger) ?? s.tables[0]?.id ?? "";
  switch (type) {
    case "createRecord":
      return { id, type, tableId, values: {} };
    case "updateRecords": {
      if (RECORD_SOURCES.has(trigger.type)) return { id, type, target: "trigger", tableId, values: {} };
      const src = [...flatSteps(steps)].reverse().find(x => x.type === "findRecords" || x.type === "createRecord");
      return { id, type, target: src?.id ?? "trigger", tableId: src && "tableId" in src ? src.tableId : tableId, values: {} };
    }
    case "findRecords":
      return { id, type, tableId, conditions: { conjunction: "and", conditions: [] }, limit: 10 };
    case "http":
      return { id, type, method: "POST", url: "", headers: [] };
    case "email":
      return { id, type, provider: "system", to: "", subject: "", body: "", format: "text" };
    case "branch":
      return { id, type, match: "all", conditions: [{ left: "", op: "notempty" }], then: [], else: [] };
    case "ai":
      return { id, type, serviceId: "", prompt: "", output: "text" };
  }
}

/** Where a new step goes: an index at the top level, or in one side of a branch. */
export interface Slot {
  parentId?: string;
  side?: "then" | "else";
  index: number;
}

const splice = (list: Step[], index: number, step: Step) => [...list.slice(0, index), step, ...list.slice(index)];

export function insertStep(steps: Step[], at: Slot, step: Step): Step[] {
  if (!at.parentId || !at.side) return splice(steps, at.index, step);
  const side = at.side;
  return steps.map(s => (s.type === "branch" && s.id === at.parentId ? { ...s, [side]: splice(s[side], at.index, step) } : s));
}

export function removeStep(steps: Step[], id: string): Step[] {
  return steps.filter(s => s.id !== id).map(s => (s.type === "branch" ? { ...s, then: s.then.filter(x => x.id !== id), else: s.else.filter(x => x.id !== id) } : s));
}

export function replaceStep(steps: Step[], id: string, next: Step): Step[] {
  const swap = (s: Step) => (s.id === id ? next : s);
  return steps.map(s => (s.id === id ? next : s.type === "branch" ? { ...s, then: s.then.map(swap), else: s.else.map(swap) } : s));
}

export function moveStep(steps: Step[], id: string, dir: -1 | 1): Step[] {
  const move = (list: Step[]): Step[] | null => {
    const i = list.findIndex(s => s.id === id);
    if (i < 0) return null;
    const j = i + dir;
    if (j < 0 || j >= list.length) return list;
    const out = list.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };
  const top = move(steps);
  if (top) return top;
  return steps.map(s => {
    if (s.type !== "branch") return s;
    const then = move(s.then);
    if (then) return { ...s, then };
    const other = move(s.else);
    return other ? { ...s, else: other } : s;
  });
}

export function findStep(steps: Step[], id: string): Step | undefined {
  return flatSteps(steps).find(s => s.id === id);
}

export interface Variable {
  group: string;
  label: string;
  /** In display form, with field names. */
  template: string;
}

/** What a step can insert: the trigger record or webhook body, results of earlier steps, and general values. */
export function variablesFor(cfg: AutomationConfig, stepId: string | null, s: SchemaLite): Variable[] {
  const out: Variable[] = [];
  const t = cfg.trigger;
  const fieldsOf = (tableId: string) => s.fields.filter(f => f.tableId === tableId && f.type !== "button");
  if (RECORD_SOURCES.has(t.type)) {
    const tid = triggerTableId(t)!;
    const g = `Trigger record (${tableName(s, tid)})`;
    out.push({ group: g, label: "The record (for link fields)", template: "{{trigger.record}}" });
    for (const f of fieldsOf(tid)) out.push({ group: g, label: f.name, template: `{{trigger.record.${f.name}}}` });
    out.push({ group: g, label: "Link to the record", template: "{{record.url}}" });
  }
  if (t.type === "webhook") {
    out.push({ group: "Webhook body", label: "The whole body", template: "{{trigger.body}}" });
    out.push({ group: "Webhook body", label: "A value, such as email", template: "{{trigger.body.email}}" });
  }
  for (const st of flatSteps(cfg.steps)) {
    if (st.id === stepId) break;
    const g = `Step ${st.id}: ${STEP_LABELS[st.type]}`;
    if (st.type === "createRecord" || st.type === "updateRecords" || st.type === "findRecords") {
      out.push({ group: g, label: "The records (for link fields)", template: `{{steps.${st.id}.records}}` });
      if (st.type !== "createRecord") out.push({ group: g, label: "How many", template: `{{steps.${st.id}.count}}` });
      for (const f of fieldsOf(st.tableId)) out.push({ group: g, label: f.name, template: `{{steps.${st.id}.records[0].${f.name}}}` });
    } else if (st.type === "http") {
      out.push({ group: g, label: "Status code", template: `{{steps.${st.id}.status}}` });
      out.push({ group: g, label: "Response body", template: `{{steps.${st.id}.body}}` });
    } else if (st.type === "ai") {
      if (st.output === "json") out.push({ group: g, label: "A value of the answer, such as name", template: `{{steps.${st.id}.json.name}}` });
      else out.push({ group: g, label: "The answer", template: `{{steps.${st.id}.text}}` });
    }
  }
  out.push({ group: "General", label: "Now", template: "{{now}}" });
  out.push({ group: "General", label: "Automation name", template: "{{automation.name}}" });
  out.push({ group: "General", label: "Link to the base", template: "{{base.url}}" });
  return out;
}

export function nameContext(cfg: AutomationConfig, fields: Field[]): NameContext {
  const tables = new Map(flatSteps(cfg.steps).flatMap(s => ("tableId" in s ? [[s.id, s.tableId] as [string, string]] : [])));
  return { fields, triggerTableId: triggerTableId(cfg.trigger), stepTableId: id => tables.get(id) };
}

function mapTemplates(steps: Step[], fn: (s: string) => string): Step[] {
  return steps.map((st): Step => {
    switch (st.type) {
      case "createRecord":
      case "updateRecords":
        return { ...st, values: Object.fromEntries(Object.entries(st.values).map(([k, v]) => [k, fn(v)])) };
      case "findRecords":
        return st.conditions ? { ...st, conditions: { ...st.conditions, conditions: st.conditions.conditions.map(c => (typeof c.value === "string" && c.value.includes("{{") ? { ...c, value: fn(c.value) } : c)) } } : st;
      case "http":
        return { ...st, url: fn(st.url), headers: st.headers.map(([k, v]) => [k, fn(v)] as [string, string]), body: st.body === undefined ? undefined : fn(st.body) };
      case "email":
        return { ...st, to: fn(st.to), cc: st.cc === undefined ? undefined : fn(st.cc), subject: fn(st.subject), body: fn(st.body) };
      case "branch":
        return { ...st, conditions: st.conditions.map(c => ({ ...c, left: fn(c.left), right: c.right === undefined ? undefined : fn(c.right) })), then: mapTemplates(st.then, fn), else: mapTemplates(st.else, fn) };
      case "ai":
        return { ...st, prompt: fn(st.prompt) };
    }
  });
}

export function toDisplayConfig(cfg: AutomationConfig, fields: Field[]): AutomationConfig {
  const n = nameContext(cfg, fields);
  return { ...cfg, steps: mapTemplates(cfg.steps, s => toDisplay(s, n)) };
}

export function toStoredConfig(cfg: AutomationConfig, fields: Field[]): AutomationConfig {
  const n = nameContext(cfg, fields);
  return { ...cfg, steps: mapTemplates(cfg.steps, s => fromDisplay(s, n)) };
}

export function scheduleText(t: ScheduleTrigger): string {
  switch (t.every) {
    case "hour":
      return `Every ${t.interval && t.interval > 1 ? `${t.interval} hours` : "hour"} at minute ${t.at.slice(3)} (${t.tz})`;
    case "day":
      return `Every day at ${t.at} (${t.tz})`;
    case "week":
      return `Every ${WEEKDAYS[t.weekday ?? 1]} at ${t.at} (${t.tz})`;
    case "month":
      return `On day ${t.monthday ?? 1} of every month at ${t.at} (${t.tz})`;
  }
}

export function offsetText(min: number): string {
  if (!min) return "On";
  const abs = Math.abs(min);
  const [n, unit] = abs % 1440 === 0 ? [abs / 1440, "day"] : abs % 60 === 0 ? [abs / 60, "hour"] : [abs, "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ${min < 0 ? "before" : "after"}`;
}

export function triggerSummary(t: Trigger, s: SchemaLite): string {
  switch (t.type) {
    case "recordCreated":
      return `A record is created in ${tableName(s, t.tableId)}`;
    case "recordUpdated":
      return `A record in ${tableName(s, t.tableId)} changes` + (t.fieldIds?.length ? `: ${t.fieldIds.map(id => fieldName(s, id)).join(", ")}` : "");
    case "recordMatches": {
      const n = t.conditions.conditions.length;
      return `A record in ${tableName(s, t.tableId)} starts to match ${n} condition${n === 1 ? "" : "s"}`;
    }
    case "schedule":
      return scheduleText(t);
    case "dateReached":
      return `${offsetText(t.offsetMinutes)} ${fieldName(s, t.fieldId)} in ${tableName(s, t.tableId)}`;
    case "webhook":
      return "An app sends a request to the webhook URL";
    case "button":
      return `Someone clicks a button in ${tableName(s, t.tableId)}`;
  }
}

export function stepSummary(st: Step, s: SchemaLite): string {
  switch (st.type) {
    case "createRecord":
      return `In ${tableName(s, st.tableId)}`;
    case "updateRecords":
      return st.target === "trigger" ? "The trigger record" : `Records from step ${st.target}`;
    case "findRecords":
      return `Up to ${st.limit} in ${tableName(s, st.tableId)}`;
    case "http":
      return `${st.method} ${st.url || "(no URL yet)"}`;
    case "email":
      return st.to ? `To ${st.to}` : "(no recipient yet)";
    case "branch":
      return `${st.conditions.length} condition${st.conditions.length === 1 ? "" : "s"}, ${st.match === "all" ? "all" : "any"} must hold`;
    case "ai":
      return st.prompt ? st.prompt.slice(0, 80) : "(no prompt yet)";
  }
}

export interface Preset {
  id: string;
  name: string;
  /** Display form (field names in templates), or null when the base has nothing it fits. */
  build(s: SchemaLite, tz: string): AutomationConfig | null;
}

export const PRESETS: Preset[] = [
  {
    id: "email-on-status",
    name: "Email when a status is reached",
    build(s) {
      const sel = s.fields.find(f => f.type === "singleSelect" && (f.options.choices?.length ?? 0) > 1);
      const table = sel && s.tables.find(t => t.id === sel.tableId);
      if (!sel || !table) return null;
      const last = sel.options.choices![sel.options.choices!.length - 1];
      const primary = s.fields.find(f => f.id === table.primaryFieldId)?.name ?? "Name";
      return {
        trigger: { type: "recordMatches", tableId: table.id, conditions: { conjunction: "and", conditions: [{ fieldId: sel.id, op: "eq", value: last.id }] } },
        steps: [{ id: "s1", type: "email", provider: "system", to: "team@example.com", subject: `{{trigger.record.${primary}}} is ${last.name}`, body: `{{trigger.record.${primary}}} is now ${last.name}.\n\nOpen it: {{record.url}}`, format: "text" }],
      };
    },
  },
  {
    id: "weekly-count",
    name: "Weekly count to a webhook URL",
    build(s, tz) {
      const table = s.tables[0];
      if (!table) return null;
      return {
        trigger: { type: "schedule", every: "week", weekday: 1, at: "09:00", tz },
        steps: [
          { id: "s1", type: "findRecords", tableId: table.id, conditions: { conjunction: "and", conditions: [] }, limit: 100 },
          { id: "s2", type: "http", method: "POST", url: "https://example.com/weekly", headers: [], body: `{"table": "${table.name}", "count": {{steps.s1.count}}}` },
        ],
      };
    },
  },
  {
    id: "records-from-webhook",
    name: "Create records from a webhook",
    build(s) {
      const table = s.tables[0];
      const primary = table && s.fields.find(f => f.id === table.primaryFieldId);
      if (!table || !primary) return null;
      return { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: table.id, values: { [primary.id]: "{{trigger.body.name}}" } }] };
    },
  },
];
