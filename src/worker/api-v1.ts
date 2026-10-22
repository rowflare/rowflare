// Public REST API, modeled on the Airtable Web API so existing scripts port easily.
// Auth: `Authorization: Bearer <personal access token>` (or the app session).
import { Hono } from "hono";
import type { Env } from "./env";
import type { SortSpec } from "../shared/types";
import { baseAccess, HttpError, type AppContext, type Vars } from "./access";
import { fieldsAfter, fieldsOf, filterIdsByFormula, inCells, loadTable, resolveField, toRecord, unwrap } from "./records";

export const apiV1 = new Hono<{ Bindings: Env; Variables: Vars }>();

const MAX_PAGE = 100;

async function ctx(c: AppContext, write: boolean) {
  const t = await loadTable(c, c.req.param("base")!, c.req.param("table")!, write ? "write" : "read");
  return { ...t, byId: c.req.query("returnFieldsByFieldId") === "true" };
}

async function json<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

apiV1.get("/bases", async c => {
  const user = c.get("user");
  if (!user) throw new HttpError(401, "Authentication required");
  const { results } = await c.env.DB.prepare("SELECT b.id, b.name, m.role FROM bases b JOIN members m ON m.workspace_id = b.workspace_id WHERE m.user_id = ? ORDER BY b.created_at")
    .bind(user.id)
    .all<{ id: string; name: string; role: string }>();
  return c.json({ bases: results.map(b => ({ id: b.id, name: b.name, permissionLevel: b.role === "viewer" ? "read" : b.role === "owner" ? "create" : "edit" })) });
});

apiV1.get("/bases/:base/tables", async c => {
  const a = await baseAccess(c as AppContext, c.req.param("base"), "read");
  const schema = await a.stub.schema();
  return c.json({
    tables: schema.tables.map(t => ({
      id: t.id,
      name: t.name,
      primaryFieldId: t.primaryFieldId,
      fields: fieldsOf(schema, t.id).map(f => ({ id: f.id, name: f.name, type: f.type, description: f.description, options: f.options })),
      views: schema.views.filter(v => v.tableId === t.id).map(v => ({ id: v.id, name: v.name, type: v.type })),
    })),
  });
});

apiV1.get("/:base/:table", async c => {
  const x = await ctx(c as AppContext, false);
  const q = c.req.queries();
  const pageSize = Math.min(MAX_PAGE, Math.max(1, Number(c.req.query("pageSize") ?? MAX_PAGE)));
  const maxRecords = c.req.query("maxRecords") ? Number(c.req.query("maxRecords")) : Infinity;
  const offset = Number(c.req.query("offset") ?? "0") || 0;
  const viewKey = c.req.query("view");
  const view = viewKey ? x.schema.views.find(v => v.tableId === x.table.id && (v.id === viewKey || v.name === viewKey)) : undefined;
  if (viewKey && !view) throw new HttpError(404, `View ${viewKey} not found`);
  const sorts: SortSpec[] = [];
  for (let i = 0; c.req.query(`sort[${i}][field]`); i++) {
    const f = resolveField(x.fields, c.req.query(`sort[${i}][field]`)!);
    if (!f) throw new HttpError(422, `Unknown sort field`);
    sorts.push({ fieldId: f.id, dir: c.req.query(`sort[${i}][direction]`) === "desc" ? "desc" : "asc" });
  }
  const only = q["fields[]"] ?? q["fields"];
  const onlySet = only ? new Set(only.map(k => resolveField(x.fields, k)?.id).filter((v): v is string => !!v)) : undefined;
  let ids = unwrap(await x.a.stub.query(x.table.id, { viewId: view?.id, sorts: sorts.length ? sorts : undefined, limit: 0 })).ids;
  const formula = c.req.query("filterByFormula");
  if (formula) ids = await filterIdsByFormula(x, ids, formula);
  if (Number.isFinite(maxRecords)) ids = ids.slice(0, maxRecords);
  const pageIds = ids.slice(offset, offset + pageSize);
  const rows = unwrap(await x.a.stub.rows(x.table.id, pageIds));
  const next = offset + pageSize < ids.length ? String(offset + pageSize) : undefined;
  return c.json({ records: rows.map(r => toRecord(r, x.fields, x.members, x.origin, x.byId, onlySet)), ...(next ? { offset: next } : {}) });
});

apiV1.get("/:base/:table/:record", async c => {
  const x = await ctx(c as AppContext, false);
  const rows = unwrap(await x.a.stub.rows(x.table.id, [Number(c.req.param("record"))]));
  if (!rows.length) throw new HttpError(404, "Record not found");
  return c.json(toRecord(rows[0], x.fields, x.members, x.origin, x.byId));
});

apiV1.post("/:base/:table", async c => {
  const x = await ctx(c as AppContext, true);
  const b = await json<{ records?: { fields: Record<string, unknown> }[]; fields?: Record<string, unknown>; typecast?: boolean }>(c as AppContext);
  const single = !b.records && !!b.fields;
  const input = b.records ?? (b.fields ? [{ fields: b.fields }] : []);
  if (!input.length || input.length > 10 * MAX_PAGE) throw new HttpError(422, "Send between 1 and 1,000 records");
  const res = unwrap(await x.a.stub.rowOp(x.a.actor, { op: "create", tableId: x.table.id, rows: input.map(r => ({ cells: inCells(x.fields, r.fields) })), typecast: !!b.typecast }));
  const created = res.changes.find(ch => ch.tableId === x.table.id)?.rows ?? [];
  const fields = fieldsAfter(x, res);
  const records = created.slice(0, input.length).map(r => toRecord(r, fields, x.members, x.origin, x.byId));
  return c.json(single ? records[0] : { records });
});

async function update(c: AppContext, replace: boolean) {
  const x = await ctx(c, true);
  const b = await json<{ records?: { id: number | string; fields: Record<string, unknown> }[]; fields?: Record<string, unknown>; typecast?: boolean }>(c);
  const recordParam = c.req.param("record");
  const input = recordParam ? [{ id: recordParam, fields: b.fields ?? {} }] : b.records ?? [];
  if (!input.length || input.length > 10 * MAX_PAGE) throw new HttpError(422, "Send between 1 and 1,000 records");
  const updates = input.map(r => ({ id: Number(r.id), cells: inCells(x.fields, r.fields, replace) }));
  const res = unwrap(await x.a.stub.rowOp(x.a.actor, { op: "update", tableId: x.table.id, updates, typecast: !!b.typecast }));
  const rows = unwrap(await x.a.stub.rows(x.table.id, updates.map(u => u.id)));
  const fields = fieldsAfter(x, res);
  if (recordParam) {
    if (!rows.length) throw new HttpError(404, "Record not found");
    return c.json(toRecord(rows[0], fields, x.members, x.origin, x.byId));
  }
  return c.json({ records: rows.map(r => toRecord(r, fields, x.members, x.origin, x.byId)) });
}

apiV1.patch("/:base/:table", c => update(c as AppContext, false));
apiV1.patch("/:base/:table/:record", c => update(c as AppContext, false));
apiV1.put("/:base/:table", c => update(c as AppContext, true));
apiV1.put("/:base/:table/:record", c => update(c as AppContext, true));

apiV1.delete("/:base/:table", async c => {
  const x = await ctx(c as AppContext, true);
  const q = c.req.queries();
  const ids = (q["records[]"] ?? q["records"] ?? []).map(Number).filter(Number.isFinite);
  if (!ids.length || ids.length > 1000) throw new HttpError(422, "Pass 1 to 1,000 records[] ids");
  const res = unwrap(await x.a.stub.rowOp(x.a.actor, { op: "delete", tableId: x.table.id, ids }));
  const gone = new Set(res.deleted.find(d => d.tableId === x.table.id)?.ids ?? []);
  return c.json({ records: ids.map(id => ({ id, deleted: gone.has(id) })) });
});

apiV1.delete("/:base/:table/:record", async c => {
  const x = await ctx(c as AppContext, true);
  const id = Number(c.req.param("record"));
  const res = unwrap(await x.a.stub.rowOp(x.a.actor, { op: "delete", tableId: x.table.id, ids: [id] }));
  return c.json({ id, deleted: !!res.deleted.find(d => d.tableId === x.table.id)?.ids.includes(id) });
});
