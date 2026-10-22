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
      for (const id of args.remove ?? []) if (!d.widgets.some(w => w.id === id)) throw new HttpError(404, `Widget ${id} is not on dashboard "${d.name}"`);
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
