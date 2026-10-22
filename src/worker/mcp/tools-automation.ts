// Automation tools: list, read with recent runs, create and edit using table and field names.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Field, FilterSpec, Schema } from "../../shared/types";
import { BRANCH_OPS, flatSteps, HTTP_METHODS, MAIL_PROVIDERS, STEP_TYPES, TRIGGER_TYPES, triggerTableId, type Automation, type AutomationConfig, type AutomationOp, type Step, type Trigger } from "../../shared/automations";
import { fromDisplay, toDisplay, type NameContext } from "../../shared/template";
import { baseAccess, HttpError, ROLE_RANK, type AppContext, type BaseAccess } from "../access";
import { fieldOf, fieldsOf, tableOf, unwrap } from "../records";
import { guard } from "./result";
import { FILTER_OPS, sortSchema } from "./schemas";
import { choiceId } from "./translate";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const filterInput = z.object({
  conjunction: z.enum(["and", "or"]).optional(),
  conditions: z.array(z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: z.unknown().optional() })).max(20),
});
type FilterIn = z.infer<typeof filterInput>;

const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  table: z.string().optional().describe("Table name or id (record, date and button triggers)"),
  filter: filterInput.optional().describe("Record and date triggers: only records matching this; recordMatches fires when a record starts to match"),
  watch: z.array(z.string()).max(50).optional().describe("recordUpdated: only changes to these fields"),
  every: z.enum(["hour", "day", "week", "month"]).optional(),
  interval: z.number().int().min(1).max(24).optional().describe("schedule every hour: hours between runs"),
  at: z.string().optional().describe("HH:MM local time (schedule; dateReached for date-only fields, default 09:00)"),
  weekday: z.number().int().min(0).max(6).optional().describe("0 is Sunday"),
  monthday: z.number().int().min(1).max(31).optional(),
  timezone: z.string().optional().describe("IANA time zone, default UTC"),
  dateField: z.string().optional(),
  offsetMinutes: z.number().int().optional().describe("dateReached: minutes after the date (negative for before)"),
  viewerCanRun: z.boolean().optional(),
});
type TriggerIn = z.infer<typeof triggerSchema>;

const baseStep = z.object({
  id: z.string().regex(/^[A-Za-z0-9_]{1,40}$/).optional().describe("Id for {{steps.<id>...}}; s1, s2, ... when missing"),
  type: z.enum(STEP_TYPES),
  table: z.string().optional(),
  values: z.record(z.string(), z.string()).optional().describe("createRecord, updateRecords: field name to template"),
  target: z.string().optional().describe("updateRecords: 'trigger' or the id of an earlier findRecords or createRecord step"),
  filter: filterInput.optional().describe("findRecords; text values may contain templates"),
  sort: sortSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  method: z.enum(HTTP_METHODS).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional().describe("HTTP body or email message"),
  provider: z.enum(MAIL_PROVIDERS).optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  subject: z.string().optional(),
  format: z.enum(["text", "html"]).optional(),
  match: z.enum(["all", "any"]).optional(),
  conditions: z.array(z.object({ left: z.string(), op: z.enum(BRANCH_OPS), right: z.string().optional() })).max(20).optional(),
  service: z.string().optional().describe("ai: AI service id from list_ai_services"),
  model: z.string().optional().describe("ai: model name; the service's default when missing"),
  prompt: z.string().max(8000).optional().describe("ai: prompt template; the answer is {{steps.<id>.text}}, or {{steps.<id>.json.<path>}} with output json"),
  output: z.enum(["text", "json"]).optional(),
});
const stepSchema = baseStep.extend({ then: z.array(baseStep).max(25).optional(), else: z.array(baseStep).max(25).optional() });
type BaseStepIn = z.infer<typeof baseStep>;
type StepIn = z.infer<typeof stepSchema>;

const TEMPLATE_HELP =
  "Templates: {{trigger.record.<Field>}}, {{trigger.record}} (the record, for link fields), {{trigger.body.<path>}} (webhook), " +
  "{{steps.<id>.records[0].<Field>}}, {{steps.<id>.count}}, {{steps.<id>.status}}, {{steps.<id>.body.<path>}}, {{now}}, {{record.url}}.";

interface Ctx {
  a: BaseAccess;
  schema: Schema;
  origin: string;
}

async function ctxFor(c: AppContext, baseId: string, need: "read" | "write"): Promise<Ctx> {
  const a = await baseAccess(c, baseId, need);
  if (ROLE_RANK[a.role] < ROLE_RANK.editor) throw new HttpError(403, "Only editors can see automations");
  return { a, schema: await a.stub.schema(), origin: c.env.APP_URL || new URL(c.req.url).origin };
}

async function listOf(x: Ctx): Promise<Automation[]> {
  return (await x.a.stub.automationList(x.origin)).automations;
}

function automationOf(list: Automation[], key: string): Automation {
  const a = list.find(a => a.id === key) ?? list.find(a => a.name === key) ?? list.find(a => a.name.toLowerCase() === key.toLowerCase());
  if (!a) throw new HttpError(404, `Automation "${key}" not found. Automations: ${list.map(a => a.name).join(", ") || "none"}`);
  return a;
}

const tableName = (schema: Schema, id: string) => schema.tables.find(t => t.id === id)?.name ?? id;

function fieldIn(schema: Schema, tableId: string, key: string): Field {
  return fieldOf(fieldsOf(schema, tableId), key, tableName(schema, tableId));
}

function toFilter(schema: Schema, tableId: string, f: FilterIn | undefined, names?: NameContext): FilterSpec | undefined {
  if (!f?.conditions.length) return undefined;
  return {
    conjunction: f.conjunction ?? "and",
    conditions: f.conditions.map(cond => {
      const field = fieldIn(schema, tableId, cond.field);
      let value = cond.value;
      if (typeof value === "string" && value.includes("{{")) value = names ? fromDisplay(value, names) : value;
      else if ((field.type === "singleSelect" || field.type === "multiSelect") && value !== undefined && value !== null) value = Array.isArray(value) ? value.map(v => choiceId(field, v)) : choiceId(field, value);
      return { fieldId: field.id, op: cond.op, value };
    }),
  };
}

function toTrigger(schema: Schema, t: TriggerIn): Trigger {
  const table = () => {
    if (!t.table) throw new HttpError(422, `A ${t.type} trigger needs a table`);
    return tableOf(schema, t.table).id;
  };
  switch (t.type) {
    case "recordCreated": {
      const id = table();
      return { type: t.type, tableId: id, conditions: toFilter(schema, id, t.filter) };
    }
    case "recordUpdated": {
      const id = table();
      return { type: t.type, tableId: id, fieldIds: t.watch?.map(k => fieldIn(schema, id, k).id), conditions: toFilter(schema, id, t.filter) };
    }
    case "recordMatches": {
      const id = table();
      return { type: t.type, tableId: id, conditions: toFilter(schema, id, t.filter) ?? { conjunction: "and", conditions: [] } };
    }
    case "schedule":
      return { type: "schedule", every: t.every ?? "day", interval: t.interval, at: t.at ?? "09:00", weekday: t.weekday, monthday: t.monthday, tz: t.timezone ?? "UTC" };
    case "dateReached": {
      const id = table();
      if (!t.dateField) throw new HttpError(422, "A dateReached trigger needs dateField");
      return { type: t.type, tableId: id, fieldId: fieldIn(schema, id, t.dateField).id, offsetMinutes: t.offsetMinutes ?? 0, at: t.at, tz: t.timezone ?? "UTC", conditions: toFilter(schema, id, t.filter) };
    }
    case "webhook":
      return { type: "webhook", token: "" };
    case "button":
      return { type: "button", tableId: table(), viewerCanRun: t.viewerCanRun ?? false };
  }
}

/** Name-based steps to stored steps. Ids are assigned first so templates can name any earlier step. */
function toSteps(schema: Schema, trigger: Trigger, steps: StepIn[]): Step[] {
  const all: BaseStepIn[] = steps.flatMap(s => [s, ...(s.then ?? []), ...(s.else ?? [])]);
  let n = all.reduce((m, s) => Math.max(m, s.id && /^s(\d+)$/.test(s.id) ? Number(s.id.slice(1)) : 0), 0);
  const ids = new Map(all.map(s => [s, s.id ?? "s" + ++n]));
  const stepTables = new Map<string, string>();
  const names: NameContext = { fields: schema.fields, triggerTableId: triggerTableId(trigger), stepTableId: id => stepTables.get(id) };
  const tpl = (s: string | undefined) => fromDisplay(s ?? "", names);
  const table = (s: BaseStepIn) => {
    if (!s.table) throw new HttpError(422, `A ${s.type} step needs a table`);
    return tableOf(schema, s.table).id;
  };
  const one = (s: BaseStepIn): Step => {
    const id = ids.get(s)!;
    switch (s.type) {
      case "createRecord":
      case "updateRecords": {
        const tableId = table(s);
        const values = Object.fromEntries(Object.entries(s.values ?? {}).map(([k, v]) => [fieldIn(schema, tableId, k).id, tpl(v)]));
        stepTables.set(id, tableId);
        return s.type === "createRecord" ? { id, type: s.type, tableId, values } : { id, type: s.type, tableId, target: s.target ?? "trigger", values };
      }
      case "findRecords": {
        const tableId = table(s);
        const sort = s.sort?.map(x => ({ fieldId: fieldIn(schema, tableId, x.field).id, dir: x.direction === "desc" ? ("desc" as const) : ("asc" as const) }));
        const step: Step = { id, type: s.type, tableId, conditions: toFilter(schema, tableId, s.filter, names), sort, limit: s.limit ?? 10 };
        stepTables.set(id, tableId);
        return step;
      }
      case "http":
        return { id, type: "http", method: s.method ?? "POST", url: tpl(s.url), headers: Object.entries(s.headers ?? {}).map(([k, v]) => [k, tpl(v)]), body: s.body === undefined ? undefined : tpl(s.body) };
      case "email":
        return { id, type: "email", provider: s.provider ?? "system", to: tpl(s.to), cc: s.cc === undefined ? undefined : tpl(s.cc), subject: tpl(s.subject), body: tpl(s.body), format: s.format ?? "text" };
      case "ai":
        return { id, type: "ai", serviceId: s.service ?? "", model: s.model, prompt: tpl(s.prompt ?? ""), output: s.output ?? "text" };
      case "branch":
        return { id, type: "branch", match: s.match ?? "all", conditions: (s.conditions ?? []).map(c => ({ left: tpl(c.left), op: c.op, right: c.right === undefined ? undefined : tpl(c.right) })), then: [], else: [] };
    }
  };
  return steps.map(s => {
    const st = one(s);
    if (st.type === "branch") {
      st.then = (s.then ?? []).map(one);
      st.else = (s.else ?? []).map(one);
    }
    return st;
  });
}

/** A stored automation with names instead of ids, in the same shape the tools accept. */
function describe(x: Ctx, a: Automation) {
  const { schema } = x;
  const fname = (id: string) => schema.fields.find(f => f.id === id)?.name ?? id;
  const t = a.config.trigger;
  const stepTables = new Map(flatSteps(a.config.steps).flatMap(s => ("tableId" in s ? [[s.id, s.tableId] as [string, string]] : [])));
  const names: NameContext = { fields: schema.fields, triggerTableId: triggerTableId(t), stepTableId: id => stepTables.get(id) };
  const show = (s: string) => toDisplay(s, names);
  const filter = (spec?: FilterSpec) =>
    spec?.conditions.length
      ? {
          conjunction: spec.conjunction,
          conditions: spec.conditions.map(c => {
            const f = schema.fields.find(x => x.id === c.fieldId);
            const choice = (v: unknown) => f?.options.choices?.find(ch => ch.id === v)?.name ?? v;
            const value = f && (f.type === "singleSelect" || f.type === "multiSelect") ? (Array.isArray(c.value) ? c.value.map(choice) : choice(c.value)) : typeof c.value === "string" ? show(c.value) : c.value;
            return { field: fname(c.fieldId), op: c.op, ...(value === undefined ? {} : { value }) };
          }),
        }
      : undefined;
  const trigger: Record<string, unknown> = { type: t.type };
  if ("tableId" in t) trigger.table = tableName(schema, t.tableId);
  if ("conditions" in t && filter(t.conditions)) trigger.filter = filter(t.conditions);
  if (t.type === "recordUpdated" && t.fieldIds?.length) trigger.watch = t.fieldIds.map(fname);
  if (t.type === "schedule") Object.assign(trigger, { every: t.every, interval: t.interval, at: t.at, weekday: t.weekday, monthday: t.monthday, timezone: t.tz });
  if (t.type === "dateReached") Object.assign(trigger, { dateField: fname(t.fieldId), offsetMinutes: t.offsetMinutes, at: t.at, timezone: t.tz });
  if (t.type === "button") trigger.viewerCanRun = t.viewerCanRun;
  const step = (s: Step): Record<string, unknown> => {
    const out: Record<string, unknown> = { id: s.id, type: s.type };
    switch (s.type) {
      case "createRecord":
      case "updateRecords":
        out.table = tableName(schema, s.tableId);
        if (s.type === "updateRecords") out.target = s.target;
        out.values = Object.fromEntries(Object.entries(s.values).map(([k, v]) => [fname(k), show(v)]));
        break;
      case "findRecords":
        Object.assign(out, { table: tableName(schema, s.tableId), filter: filter(s.conditions), sort: s.sort?.map(x => ({ field: fname(x.fieldId), direction: x.dir })), limit: s.limit });
        break;
      case "http":
        Object.assign(out, { method: s.method, url: show(s.url), headers: Object.fromEntries(s.headers.map(([k, v]) => [k, show(v)])) });
        if (s.body !== undefined) out.body = show(s.body);
        break;
      case "email":
        Object.assign(out, { provider: s.provider, to: show(s.to), subject: show(s.subject), body: show(s.body), format: s.format });
        if (s.cc) out.cc = show(s.cc);
        break;
      case "ai":
        Object.assign(out, { service: s.serviceId, model: s.model, prompt: show(s.prompt), output: s.output });
        break;
      case "branch":
        Object.assign(out, { match: s.match, conditions: s.conditions.map(c => ({ left: show(c.left), op: c.op, ...(c.right === undefined ? {} : { right: show(c.right) }) })), then: s.then.map(step), else: s.else.map(step) });
        break;
    }
    return JSON.parse(JSON.stringify(out));
  };
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    ...(a.disabledReason ? { disabledReason: "Switched off after 20 failed runs in a row" } : {}),
    trigger: JSON.parse(JSON.stringify(trigger)),
    steps: a.config.steps.map(step),
    ...(t.type === "webhook" ? { webhookUrl: `${x.origin}/api/hooks/${x.a.base.id}/${t.token}` } : {}),
  };
}

async function apply(x: Ctx, op: AutomationOp): Promise<{ id?: string; automations: Automation[] }> {
  return unwrap(await x.a.stub.automationOp(x.a.actor, op, x.origin));
}

export function registerAutomationTools(server: McpServer, c: AppContext) {
  server.registerTool(
    "list_automations",
    { title: "List automations", description: "Automations of a base with their trigger type, whether they are on, and their last run. Editors and owners only.", inputSchema: { baseId: z.string() }, annotations: READ },
    guard(async (args: { baseId: string }) => {
      const x = await ctxFor(c, args.baseId, "read");
      return { automations: (await listOf(x)).map(a => ({ id: a.id, name: a.name, enabled: a.enabled, trigger: a.config.trigger.type, lastRun: a.lastRun ?? null })) };
    }),
  );

  server.registerTool(
    "get_automation",
    {
      title: "Get automation",
      description: "An automation's trigger and steps with table and field names, its webhook URL if it has one, and its last 20 runs.",
      inputSchema: { baseId: z.string(), automation: z.string().describe("Automation name or id") },
      annotations: READ,
    },
    guard(async (args: { baseId: string; automation: string }) => {
      const x = await ctxFor(c, args.baseId, "read");
      const a = automationOf(await listOf(x), args.automation);
      const runs = unwrap(await x.a.stub.automationRuns(a.id, { limit: 20 })).map(r => ({ id: r.id, status: r.status, test: r.test, createdAt: new Date(r.createdAt).toISOString(), error: r.error, trigger: r.trigger }));
      return { automation: describe(x, a), runs };
    }),
  );

  server.registerTool(
    "create_automation",
    {
      title: "Create automation",
      description:
        "Create an automation from a trigger and steps, naming tables and fields. It starts switched off unless enabled is true. " +
        "Triggers: recordCreated, recordUpdated, recordMatches, schedule, dateReached, webhook, button. " +
        "Steps run in order: createRecord, updateRecords, findRecords, http, email, branch (one level, with then and else). " +
        TEMPLATE_HELP,
      inputSchema: { baseId: z.string(), name: z.string().min(1).max(100), trigger: triggerSchema, steps: z.array(stepSchema).max(25).optional(), enabled: z.boolean().optional() },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; name: string; trigger: TriggerIn; steps?: StepIn[]; enabled?: boolean }) => {
      const x = await ctxFor(c, args.baseId, "write");
      const trigger = toTrigger(x.schema, args.trigger);
      const config: AutomationConfig = { trigger, steps: toSteps(x.schema, trigger, args.steps ?? []) };
      const r = await apply(x, { op: "create", name: args.name, config, enabled: args.enabled ?? false });
      return { automation: describe(x, automationOf(r.automations, r.id!)) };
    }),
  );

  server.registerTool(
    "update_automation",
    {
      title: "Update automation",
      description: "Rename an automation, switch it on or off, or replace its trigger or its steps (each is replaced as a whole when given). " + TEMPLATE_HELP,
      inputSchema: { baseId: z.string(), automation: z.string().describe("Automation name or id"), name: z.string().min(1).max(100).optional(), trigger: triggerSchema.optional(), steps: z.array(stepSchema).max(25).optional(), enabled: z.boolean().optional() },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; automation: string; name?: string; trigger?: TriggerIn; steps?: StepIn[]; enabled?: boolean }) => {
      const x = await ctxFor(c, args.baseId, "write");
      const a = automationOf(await listOf(x), args.automation);
      let list: Automation[] | undefined;
      if (args.name !== undefined || args.trigger || args.steps) {
        const trigger = args.trigger ? toTrigger(x.schema, args.trigger) : a.config.trigger;
        const config: AutomationConfig = { trigger, steps: args.steps ? toSteps(x.schema, trigger, args.steps) : a.config.steps };
        list = (await apply(x, { op: "update", id: a.id, name: args.name, config })).automations;
      }
      if (args.enabled !== undefined) list = (await apply(x, { op: "setEnabled", id: a.id, enabled: args.enabled })).automations;
      return { automation: describe(x, automationOf(list ?? (await listOf(x)), a.id)) };
    }),
  );
}
