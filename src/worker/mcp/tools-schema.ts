// Schema tools: tables, fields and views.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Schema, ViewType } from "../../shared/types";
import { baseAccess, HttpError, type AppContext, type BaseAccess } from "../access";
import type { SchemaOp } from "../base-do";
import { fieldOf, loadTable, unwrap } from "../records";
import { describeField, describeTable, describeView } from "./describe";
import { guard } from "./result";
import { fieldSpecOptionsSchema, fieldSpecSchema, FIELD_TYPES_ENUM, VIEW_TYPES, viewOptionsShape, type FieldSpec, type FieldSpecOptions, type ViewOptionsInput } from "./schemas";
import { COMPLEX_TYPES, toFieldOptions, toViewConfig, viewOf } from "./translate";
import { listServices } from "../ai/services";
import type { AiServiceInfo } from "../../shared/ai";

/** Lookup and rollup settings on other types would be dropped silently (or fail on a table that does not exist yet). */
function checkSpec(type: FieldSpec["type"], o: FieldSpecOptions | undefined) {
  if ((o?.linkField || o?.targetField) && type !== "lookup" && type !== "rollup") throw new HttpError(422, `linkField and targetField only apply to lookup and rollup fields, not ${type}`);
}

/** Fields that refer to other fields, so create_table adds them after the plain ones. */
const isComplex = (s: FieldSpec) => COMPLEX_TYPES.has(s.type) || !!s.options?.ai;

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

async function op(a: BaseAccess, o: SchemaOp): Promise<{ schema: Schema; id?: string }> {
  return unwrap(await a.stub.schemaOp(a.actor, o));
}

export function registerSchemaTools(server: McpServer, c: AppContext) {
  const servicesFor = async (ws: string, specs: FieldSpec[]): Promise<AiServiceInfo[]> => (specs.some(s => s.options?.ai) ? listServices(c.env, ws, Date.now()) : []);
  const table = z.string().describe("Table name or id");

  server.registerTool(
    "create_table",
    {
      title: "Create table",
      description: "Create a table. The first field is the primary field and must be a plain type (text, number, date...). Link, lookup, rollup and formula fields may reference fields listed earlier in the same call. Without fields you get Name, Notes and Status.",
      inputSchema: { baseId: z.string(), name: z.string().min(1), fields: z.array(fieldSpecSchema).max(50).optional() },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; name: string; fields?: FieldSpec[] }) => {
      const a = await baseAccess(c, args.baseId, "write");
      const specs = args.fields ?? [];
      if (specs.length && isComplex(specs[0])) throw new HttpError(422, "The first field is the primary field and must be a plain type such as text, number or date; link, lookup, rollup and formula fields cannot come first");
      let schema = await a.stub.schema();
      for (const s of specs) checkSpec(s.type, s.options);
      const services = await servicesFor(a.base.workspace_id, specs);
      const plain = specs.filter(s => !isComplex(s)).map(s => ({ name: s.name, type: s.type, description: s.description, options: toFieldOptions(schema, "", s.options) }));
      const created = await op(a, { op: "createTable", name: args.name, fields: plain.length ? plain : undefined, emptyRows: 0 });
      const tableId = created.id!;
      schema = created.schema;
      for (const s of specs.filter(isComplex)) {
        try {
          schema = (await op(a, { op: "createField", tableId, field: { name: s.name, type: s.type, description: s.description, options: toFieldOptions(schema, tableId, s.options, undefined, services) } })).schema;
        } catch (e) {
          // All or nothing: a half-built table would make the retry create "Name 2".
          if (!(e instanceof HttpError)) throw e;
          await op(a, { op: "deleteTable", tableId });
          throw new HttpError(422, `Table "${args.name}" was not created: field "${s.name}" failed: ${e.message}`);
        }
      }
      const t = schema.tables.find(t => t.id === tableId)!;
      // Present fields in the order the caller asked for.
      const info = describeTable(schema, t);
      const order = new Map(specs.map((s, i) => [s.name.toLowerCase(), i]));
      info.fields.sort((x, y) => (order.get(x.name.toLowerCase()) ?? 999) - (order.get(y.name.toLowerCase()) ?? 999));
      return { table: info };
    }),
  );

  server.registerTool(
    "update_table",
    { title: "Update table", description: "Rename a table or change its primary field.", inputSchema: { baseId: z.string(), table, name: z.string().optional(), primaryField: z.string().optional() }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; name?: string; primaryField?: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const primaryFieldId = args.primaryField ? fieldOf(t.fields, args.primaryField, t.table.name).id : undefined;
      const { schema } = await op(t.a, { op: "updateTable", tableId: t.table.id, name: args.name, primaryFieldId });
      return { table: describeTable(schema, schema.tables.find(x => x.id === t.table.id)!) };
    }),
  );

  server.registerTool(
    "delete_table",
    { title: "Delete table", description: "Permanently delete a table, its records, and link fields in other tables that point at it.", inputSchema: { baseId: z.string(), table }, annotations: DELETE },
    guard(async (args: { baseId: string; table: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      await op(t.a, { op: "deleteTable", tableId: t.table.id });
      return { deleted: t.table.id };
    }),
  );

  server.registerTool(
    "create_field",
    { title: "Create field", description: "Add a field to a table. Formulas use field names in braces.", inputSchema: { baseId: z.string(), table, field: fieldSpecSchema }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; field: FieldSpec }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const s = args.field;
      checkSpec(s.type, s.options);
      const res = await op(t.a, { op: "createField", tableId: t.table.id, field: { name: s.name, type: s.type, description: s.description, options: toFieldOptions(t.schema, t.table.id, s.options, undefined, await servicesFor(t.a.base.workspace_id, [s])) } });
      return { field: describeField(res.schema, res.schema.fields.find(f => f.id === res.id)!) };
    }),
  );

  server.registerTool(
    "update_field",
    {
      title: "Update field",
      description:
        "Rename a field, change its type or options, or set its description. For select fields send the full option list: existing options are kept by name, rename one with { name: new, renameFrom: old }, and options left out are removed from cells. Changing the type converts every cell.",
      inputSchema: { baseId: z.string(), table, field: z.string().describe("Field name or id"), name: z.string().optional(), type: z.enum(FIELD_TYPES_ENUM).optional(), description: z.string().optional(), options: fieldSpecOptionsSchema },
      annotations: { ...WRITE, destructiveHint: true },
    },
    guard(async (args: { baseId: string; table: string; field: string; name?: string; type?: FieldSpec["type"]; description?: string; options?: FieldSpecOptions }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const f = fieldOf(t.fields, args.field, t.table.name);
      checkSpec(args.type ?? (f.type as FieldSpec["type"]), args.options);
      const options = args.options ? toFieldOptions(t.schema, t.table.id, args.options, f, args.options.ai ? await listServices(c.env, t.a.base.workspace_id, Date.now()) : []) : undefined;
      const { schema } = await op(t.a, { op: "updateField", fieldId: f.id, patch: { name: args.name, type: args.type, options, description: args.description } });
      return { field: describeField(schema, schema.fields.find(x => x.id === f.id)!) };
    }),
  );

  server.registerTool(
    "delete_field",
    { title: "Delete field", description: "Permanently delete a field and its values. Deleting a link field also deletes its inverse.", inputSchema: { baseId: z.string(), table, field: z.string() }, annotations: DELETE },
    guard(async (args: { baseId: string; table: string; field: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const f = fieldOf(t.fields, args.field, t.table.name);
      await op(t.a, { op: "deleteField", fieldId: f.id });
      return { deleted: f.id };
    }),
  );

  server.registerTool(
    "create_view",
    {
      title: "Create view",
      description: "Add a grid, kanban, calendar, timeline, gallery or form view with optional filter, sort, hidden fields and type-specific settings (grouping, date fields, lanes, cover).",
      inputSchema: { baseId: z.string(), table, name: z.string().min(1), type: z.enum(VIEW_TYPES), ...viewOptionsShape },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; table: string; name: string; type: ViewType } & ViewOptionsInput) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const res = await op(t.a, { op: "createView", tableId: t.table.id, view: { name: args.name, type: args.type, config: toViewConfig(t, args, args.type) } });
      return { view: describeView(res.schema.views.find(v => v.id === res.id)!, res.schema) };
    }),
  );

  server.registerTool(
    "update_view",
    { title: "Update view", description: "Rename a view or change its filter, sort, hidden fields or type-specific settings. Settings you leave out are kept; null clears one.", inputSchema: { baseId: z.string(), table, view: z.string(), name: z.string().optional(), ...viewOptionsShape }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; view: string; name?: string } & ViewOptionsInput) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const v = viewOf(t, args.view);
      const { schema } = await op(t.a, { op: "updateView", viewId: v.id, patch: { name: args.name, config: toViewConfig(t, args, v.type) } });
      return { view: describeView(schema.views.find(x => x.id === v.id)!, schema) };
    }),
  );
}
