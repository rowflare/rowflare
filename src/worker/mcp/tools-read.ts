// Read-only MCP tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baseAccess, requireUser, type AppContext } from "../access";
import { fieldOf, filterIdsByFormula, loadTable, toRecord, unwrap } from "../records";
import type { AggFn, DateBucket } from "../base/aggregate";
import { describeTable } from "./describe";
import { guard, truncateRecord, withinBudget } from "./result";
import { fieldsSchema, filterSchema, sortSchema, type FilterInput, type SortInput } from "./schemas";
import { onlyFields, toFilterSpec, toSorts, viewOf } from "./translate";

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export function registerReadTools(server: McpServer, c: AppContext) {
  server.registerTool(
    "list_bases",
    { title: "List bases", description: "List the Rowflare bases you can access, with their workspace and your permission (read, edit, create).", inputSchema: {}, annotations: READ },
    guard(async () => {
      const user = requireUser(c);
      const { results } = await c.env.DB.prepare(
        "SELECT b.id, b.name, w.name workspace, m.role FROM bases b JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = ? JOIN workspaces w ON w.id = b.workspace_id ORDER BY b.created_at",
      )
        .bind(user.id)
        .all<{ id: string; name: string; workspace: string; role: string }>();
      return { bases: results.map(b => ({ id: b.id, name: b.name, workspace: b.workspace, permission: b.role === "viewer" ? "read" : b.role === "owner" ? "create" : "edit" })) };
    }),
  );

  server.registerTool(
    "describe_base",
    {
      title: "Describe base",
      description: "Show every table in a base with its fields (type and options), primary field, row count and views. Call this before reading or writing records so you use the right table and field names.",
      inputSchema: { baseId: z.string().describe("Base id from list_bases") },
      annotations: READ,
    },
    guard(async ({ baseId }: { baseId: string }) => {
      const a = await baseAccess(c, baseId, "read");
      const schema = await a.stub.schema();
      return { baseId, name: a.base.name, tables: schema.tables.map(t => describeTable(schema, t)) };
    }),
  );
  const table = z.string().describe("Table name or id");

  server.registerTool(
    "query_records",
    {
      title: "Query records",
      description:
        'Find records in a table. Use filter (structured, fast) and/or formula (an Airtable formula such as AND({Status} = "Done", {Hours} > 5), slower). With view, the view\'s own filters and sorts apply and filter narrows them. Returns total and nextOffset for paging.',
      inputSchema: {
        baseId: z.string(),
        table,
        filter: filterSchema.optional(),
        formula: z.string().optional(),
        sort: sortSchema.optional(),
        view: z.string().optional().describe("View name or id"),
        fields: fieldsSchema.optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ,
    },
    guard(async (args: { baseId: string; table: string; filter?: FilterInput; formula?: string; sort?: SortInput; view?: string; fields?: string[]; limit?: number; offset?: number }) => {
      const t = await loadTable(c, args.baseId, args.table, "read");
      const viewId = args.view ? viewOf(t, args.view).id : undefined;
      let ids = unwrap(await t.a.stub.query(t.table.id, { viewId, extraFilters: toFilterSpec(t, args.filter), sorts: toSorts(t, args.sort), limit: 0 })).ids;
      if (args.formula) ids = await filterIdsByFormula(t, ids, args.formula);
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const page = unwrap(await t.a.stub.rows(t.table.id, ids.slice(offset, offset + limit)));
      const only = onlyFields(t, args.fields);
      const { kept: records } = withinBudget(page.map(r => truncateRecord(toRecord(r, t.fields, t.members, t.origin, false, only))));
      const next = offset + records.length;
      return { records, total: ids.length, ...(next < Math.min(ids.length, offset + limit) || offset + limit < ids.length ? { nextOffset: next } : {}) };
    }),
  );

  server.registerTool(
    "get_records",
    {
      title: "Get records",
      description: "Fetch up to 100 records by id. Long text is cut at 2,000 characters unless fullText is true.",
      inputSchema: { baseId: z.string(), table, ids: z.array(z.number().int()).min(1).max(100), fields: fieldsSchema.optional(), fullText: z.boolean().optional() },
      annotations: READ,
    },
    guard(async (args: { baseId: string; table: string; ids: number[]; fields?: string[]; fullText?: boolean }) => {
      const t = await loadTable(c, args.baseId, args.table, "read");
      const rows = unwrap(await t.a.stub.rows(t.table.id, args.ids));
      const only = onlyFields(t, args.fields);
      const { kept, rest } = withinBudget(rows.map(r => toRecord(r, t.fields, t.members, t.origin, false, only)).map(r => (args.fullText ? r : truncateRecord(r))));
      return rest.length ? { records: kept, omitted: rest.map(r => r.id), note: "The answer would be too large; ask again for the omitted ids, a few at a time." } : { records: kept };
    }),
  );

  server.registerTool(
    "aggregate",
    {
      title: "Aggregate",
      description:
        "Count, total, average, min or max over a table, optionally grouped by up to 2 fields, computed in the database. Use this instead of reading all records to answer how many / how much questions. " +
        "Multi-value fields (multiple select, links, users) count a record once per value. Dates group by day unless bucket is week, month or year.",
      inputSchema: {
        baseId: z.string(),
        table,
        filter: filterSchema.optional(),
        view: z.string().optional(),
        groupBy: z.array(z.object({ field: z.string(), bucket: z.enum(["day", "week", "month", "year"]).optional() })).max(2).optional(),
        timezone: z.string().optional().describe("IANA time zone, such as Asia/Shanghai, for the day buckets of values with a time; UTC by default"),
        metrics: z
          .array(z.object({ fn: z.enum(["count", "countUnique", "countEmpty", "countFilled", "sum", "avg", "min", "max"]), field: z.string().optional(), as: z.string().optional().describe("Result key; defaults to fn or 'fn Field'") }))
          .min(1)
          .max(10),
      },
      annotations: READ,
    },
    guard(async (args: { baseId: string; table: string; filter?: FilterInput; view?: string; groupBy?: { field: string; bucket?: DateBucket }[]; metrics: { fn: AggFn; field?: string; as?: string }[]; timezone?: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "read");
      const metrics = args.metrics.map(m => {
        const f = m.field ? fieldOf(t.fields, m.field, t.table.name) : undefined;
        return { fn: m.fn, fieldId: f?.id, as: m.as ?? (f ? `${m.fn} ${f.name}` : m.fn) };
      });
      const groupBy = args.groupBy?.map(g => ({ fieldId: fieldOf(t.fields, g.field, t.table.name).id, bucket: g.bucket }));
      const res = unwrap(await t.a.stub.aggregate(t.table.id, { viewId: args.view ? viewOf(t, args.view).id : undefined, filters: toFilterSpec(t, args.filter), groupBy, metrics, tz: args.timezone }));
      return { ...res, groupBy: args.groupBy?.map(g => g.field) ?? [] };
    }),
  );
}
