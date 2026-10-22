// Record write tools. typecast defaults to true so models can write option names and linked record names.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../access";
import { fieldOf, fieldsAfter, inCells, loadTable, toRecord, unwrap, type TableCtx } from "../records";
import { guard, truncateRecord } from "./result";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const fieldsValue = z.record(z.string(), z.unknown()).describe("Field name to value. Select fields take option names, links take record ids or primary field values, users take emails, dates take YYYY-MM-DD");

/** Same as inCells, but unknown names fail with the list of valid fields. */
function cells(t: TableCtx, input: Record<string, unknown>) {
  for (const k of Object.keys(input)) fieldOf(t.fields, k, t.table.name);
  return inCells(t.fields, input);
}

export function registerWriteTools(server: McpServer, c: AppContext) {
  const table = z.string().describe("Table name or id");
  const typecast = z.boolean().optional().describe("Default true: create missing select options and match linked records by name");

  server.registerTool(
    "create_records",
    { title: "Create records", description: "Create 1 to 200 records.", inputSchema: { baseId: z.string(), table, records: z.array(z.object({ fields: fieldsValue })).min(1).max(200), typecast }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; records: { fields: Record<string, unknown> }[]; typecast?: boolean }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const res = unwrap(await t.a.stub.rowOp(t.a.actor, { op: "create", tableId: t.table.id, rows: args.records.map(r => ({ cells: cells(t, r.fields) })), typecast: args.typecast ?? true }));
      const created = res.changes.find(ch => ch.tableId === t.table.id)?.rows ?? [];
      const fields = fieldsAfter(t, res);
      return { records: created.slice(0, args.records.length).map(r => truncateRecord(toRecord(r, fields, t.members, t.origin, false))) };
    }),
  );

  server.registerTool(
    "update_records",
    { title: "Update records", description: "Update 1 to 200 records by id. Only the given fields change.", inputSchema: { baseId: z.string(), table, records: z.array(z.object({ id: z.number().int(), fields: fieldsValue })).min(1).max(200), typecast }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; records: { id: number; fields: Record<string, unknown> }[]; typecast?: boolean }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const updates = args.records.map(r => ({ id: r.id, cells: cells(t, r.fields) }));
      const res = unwrap(await t.a.stub.rowOp(t.a.actor, { op: "update", tableId: t.table.id, updates, typecast: args.typecast ?? true }));
      const rows = unwrap(await t.a.stub.rows(t.table.id, updates.map(u => u.id)));
      const fields = fieldsAfter(t, res);
      return { records: rows.map(r => truncateRecord(toRecord(r, fields, t.members, t.origin, false))) };
    }),
  );

  server.registerTool(
    "delete_records",
    { title: "Delete records", description: "Permanently delete 1 to 200 records by id.", inputSchema: { baseId: z.string(), table, ids: z.array(z.number().int()).min(1).max(200) }, annotations: DELETE },
    guard(async (args: { baseId: string; table: string; ids: number[] }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const res = unwrap(await t.a.stub.rowOp(t.a.actor, { op: "delete", tableId: t.table.id, ids: args.ids }));
      return { deleted: res.deleted.find(d => d.tableId === t.table.id)?.ids ?? [] };
    }),
  );
}
