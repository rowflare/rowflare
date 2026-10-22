// Record shape and name resolution shared by the REST API and the MCP server.
import { failure, type LimitInfo } from "./hosting";
import type { Attachment, Field, LinkValue, Member, Row, Schema, Table } from "../shared/types";
import { COMPUTED_TYPES } from "../shared/types";
import { compileFormula, evaluate, FormulaError, truthy } from "../shared/formula";
import { formulaValue } from "../shared/cells";
import { baseAccess, HttpError, workspaceMembers, type AppContext, type BaseAccess } from "./access";
import type { MutationResult } from "./base/store";

export interface ApiRecord {
  id: number;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface TableCtx {
  a: BaseAccess;
  schema: Schema;
  table: Table;
  fields: Field[];
  members: Map<string, Member>;
  origin: string;
}

export function tableOf(schema: Schema, idOrName: string): Table {
  const decoded = decodeURIComponent(idOrName);
  const t = schema.tables.find(t => t.id === decoded) ?? schema.tables.find(t => t.name === decoded) ?? schema.tables.find(t => t.name.toLowerCase() === decoded.toLowerCase());
  if (!t) throw new HttpError(404, `Table ${decoded} not found`);
  return t;
}

export function fieldsOf(schema: Schema, tableId: string): Field[] {
  return schema.fields.filter(f => f.tableId === tableId);
}

export function resolveField(fields: Field[], key: string): Field | undefined {
  return fields.find(f => f.id === key) ?? fields.find(f => f.name === key) ?? fields.find(f => f.name.toLowerCase() === key.toLowerCase());
}

/** Like resolveField, but fails with the list of valid names so a caller (or a model) can correct itself. */
export function fieldOf(fields: Field[], key: string, tableName: string): Field {
  const f = resolveField(fields, key);
  if (!f) throw new HttpError(422, `Unknown field "${key}" in table ${tableName}. Fields: ${fields.map(f => f.name).join(", ")}`);
  return f;
}

export function outValue(f: Field, row: Row, members: Map<string, Member>, origin: string): unknown {
  const v = f.type === "createdTime" ? row.createdAt : f.type === "modifiedTime" ? row.updatedAt : f.type === "autonumber" ? row.id : row.cells[f.id];
  if (v === undefined || v === null) return undefined;
  switch (f.type) {
    case "singleSelect":
      return f.options.choices?.find(c => c.id === v)?.name;
    case "multiSelect":
      return (v as string[]).map(id => f.options.choices?.find(c => c.id === id)?.name).filter(Boolean);
    case "link":
      return (v as LinkValue[]).map(x => x.id);
    case "attachment":
      return (v as Attachment[]).map(a => ({ id: a.id, filename: a.name, size: a.size, type: a.type, url: `${origin}/api/files/${a.key.split("/").map(encodeURIComponent).join("/")}` }));
    case "user": {
      const one = (id: string) => ({ id, email: members.get(id)?.email, name: members.get(id)?.name });
      return Array.isArray(v) ? v.map(one) : one(String(v));
    }
    case "createdTime":
    case "modifiedTime":
      return new Date(v as number).toISOString();
    default:
      return v;
  }
}

export function toRecord(row: Row, fields: Field[], members: Map<string, Member>, origin: string, byId: boolean, only?: Set<string>): ApiRecord {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (only && !only.has(f.id)) continue;
    const v = outValue(f, row, members, origin);
    if (v !== undefined) out[byId ? f.id : f.name] = v;
  }
  return { id: row.id, createdTime: new Date(row.createdAt).toISOString(), fields: out };
}

export function inCells(fields: Field[], input: Record<string, unknown> | undefined, replace = false): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const f = resolveField(fields, k);
    if (!f) throw new HttpError(422, `Unknown field name: "${k}"`);
    if (COMPUTED_TYPES.has(f.type)) throw new HttpError(422, `Field "${f.name}" cannot accept a value because the field is computed`);
    cells[f.id] = f.type === "user" && typeof v === "object" && v !== null && !Array.isArray(v) ? (v as { id?: string; email?: string }).id ?? (v as { email?: string }).email : v;
  }
  if (replace) for (const f of fields) if (!COMPUTED_TYPES.has(f.type) && !(f.id in cells)) cells[f.id] = null;
  return cells;
}

export function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string; status?: number; limit?: LimitInfo }): T {
  if (!r.ok) throw r.limit ? failure(r, 422) : new HttpError(422, r.error);
  return r.value;
}

/** Typecast can add select options during a write; format results with the schema the write returned. */
export function fieldsAfter(t: TableCtx, res: MutationResult): Field[] {
  return res.schema ? fieldsOf(res.schema, t.table.id) : t.fields;
}

export async function loadTable(c: AppContext, baseId: string, tableKey: string, need: "read" | "write"): Promise<TableCtx> {
  const a = await baseAccess(c, baseId, need);
  const schema = await a.stub.schema();
  const table = tableOf(schema, tableKey);
  const fields = fieldsOf(schema, table.id);
  const members = new Map((await workspaceMembers(c.env, a.base.workspace_id)).map(m => [m.id, m]));
  return { a, schema, table, fields, members, origin: new URL(c.req.url).origin };
}

/** Evaluates an Airtable formula per row (in the Worker) and keeps the ids where it is truthy, preserving order. */
export async function filterIdsByFormula(t: TableCtx, ids: number[], formula: string): Promise<number[]> {
  let compiled;
  try {
    compiled = compileFormula(formula, t.fields.map(f => ({ id: f.id, name: f.name })));
  } catch (e) {
    throw new HttpError(422, e instanceof FormulaError ? `Invalid filterByFormula: ${e.message}` : "Invalid filterByFormula");
  }
  const keep: number[] = [];
  const fmap = new Map(t.fields.map(f => [f.id, f]));
  const userName = (id: string) => t.members.get(id)?.name ?? id;
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = unwrap(await t.a.stub.rows(t.table.id, ids.slice(i, i + 1000)));
    for (const r of rows) {
      const v = evaluate(compiled.ast, {
        get: fid => {
          const f = fmap.get(fid);
          if (!f) return null;
          const raw = f.type === "createdTime" ? r.createdAt : f.type === "modifiedTime" ? r.updatedAt : f.type === "autonumber" ? r.id : r.cells[f.id];
          return formulaValue(f, raw, { userName });
        },
        recordId: r.id,
        createdTime: new Date(r.createdAt).toISOString(),
        modifiedTime: new Date(r.updatedAt).toISOString(),
        now: new Date(),
      });
      if (truthy(v) && v !== "#ERROR!") keep.push(r.id);
    }
  }
  return keep;
}
