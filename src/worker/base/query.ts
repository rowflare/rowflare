// Translates view filters / sorts / search into SQL over one physical table.
// Field ids are validated by isSafeId before being embedded in JSON paths; values are always bound.
import type { Condition, Field, FilterSpec, SortSpec } from "../../shared/types";
import { isSafeId } from "../../shared/ids";
import { parseDate, parseNumber } from "../../shared/cells";

export interface SqlPart {
  sql: string;
  params: unknown[];
}

const ARRAY_TYPES = new Set(["multiSelect", "link", "lookup", "attachment"]);

export function valueExpr(f: Field): string {
  if (f.type === "createdTime") return "created_at";
  if (f.type === "modifiedTime") return "updated_at";
  if (f.type === "autonumber") return "id";
  if (!isSafeId(f.id)) throw new Error("bad field id");
  return `json_extract(data, '$.${f.id}')`;
}

function isArrayField(f: Field): boolean {
  if (ARRAY_TYPES.has(f.type)) return true;
  if (f.type === "user") return !!f.options.multiple;
  if (f.type === "formula" || f.type === "rollup") return f.options.resultType === "array";
  return false;
}

export type FilterKind = "text" | "number" | "date" | "time" | "bool" | "select" | "array";

/** How a field is compared in filters; the MCP layer uses it to reject ops that conditionSql would ignore. */
export function filterKind(f: Field): FilterKind {
  switch (f.type) {
    case "number":
    case "autonumber":
      return "number";
    case "date":
      return "date";
    case "createdTime":
    case "modifiedTime":
      return "time";
    case "checkbox":
      return "bool";
    case "singleSelect":
      return "select";
    case "formula":
    case "rollup":
      if (f.options.resultType === "number") return "number";
      if (f.options.resultType === "date") return "date";
      if (f.options.resultType === "boolean") return "bool";
      if (f.options.resultType === "array") return "array";
      return "text";
    default:
      return isArrayField(f) ? "array" : "text";
  }
}

function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === "") return [];
  return [v];
}

function conditionSql(f: Field, c: Condition): SqlPart | null {
  const e = valueExpr(f);
  const k = filterKind(f);
  const v = c.value;
  if (c.op === "empty") {
    if (k === "array") return { sql: `coalesce(json_array_length(${e}), 0) = 0`, params: [] };
    if (k === "bool") return { sql: `coalesce(${e}, 0) = 0`, params: [] };
    return { sql: `(${e} IS NULL OR ${e} = '')`, params: [] };
  }
  if (c.op === "notempty") {
    if (k === "array") return { sql: `coalesce(json_array_length(${e}), 0) > 0`, params: [] };
    if (k === "bool") return { sql: `coalesce(${e}, 0) <> 0`, params: [] };
    return { sql: `(${e} IS NOT NULL AND ${e} <> '')`, params: [] };
  }
  // Conditions without a value are ignored, like an unfinished filter row in Airtable.
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
    if (k !== "bool") return null;
  }
  const cmp: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  switch (k) {
    case "bool": {
      const want = v === true || v === 1 || v === "true" ? 1 : 0;
      if (c.op === "eq") return { sql: `coalesce(${e}, 0) = ?`, params: [want] };
      if (c.op === "neq") return { sql: `coalesce(${e}, 0) <> ?`, params: [want] };
      return null;
    }
    case "number": {
      const n = parseNumber(v);
      if (n === null || !cmp[c.op]) return null;
      if (c.op === "neq") return { sql: `(${e} IS NULL OR ${e} <> ?)`, params: [n] };
      return { sql: `${e} ${cmp[c.op]} ?`, params: [n] };
    }
    case "date":
    case "time": {
      if (!cmp[c.op]) return null;
      const day = parseDate(v, false);
      if (!day) return null;
      if (k === "time") {
        const start = Date.parse(day + "T00:00:00Z"), end = start + 86400000;
        if (c.op === "eq") return { sql: `${e} >= ? AND ${e} < ?`, params: [start, end] };
        if (c.op === "neq") return { sql: `(${e} < ? OR ${e} >= ?)`, params: [start, end] };
        if (c.op === "gt") return { sql: `${e} >= ?`, params: [end] };
        if (c.op === "gte") return { sql: `${e} >= ?`, params: [start] };
        if (c.op === "lt") return { sql: `${e} < ?`, params: [start] };
        return { sql: `${e} < ?`, params: [end] };
      }
      // Stored as YYYY-MM-DD or full ISO; compare on the date part.
      const d = `substr(${e}, 1, 10)`;
      if (c.op === "neq") return { sql: `(${e} IS NULL OR ${d} <> ?)`, params: [day] };
      return { sql: `${d} ${cmp[c.op]} ?`, params: [day] };
    }
    case "select": {
      const ids = list(v).map(String);
      if (c.op === "eq") return { sql: `${e} = ?`, params: [ids[0]] };
      if (c.op === "neq") return { sql: `(${e} IS NULL OR ${e} <> ?)`, params: [ids[0]] };
      if (c.op === "anyOf") return { sql: `${e} IN (${ids.map(() => "?").join(",")})`, params: ids };
      if (c.op === "noneOf") return { sql: `(${e} IS NULL OR ${e} NOT IN (${ids.map(() => "?").join(",")}))`, params: ids };
      return null;
    }
    case "array": {
      const item = f.type === "link" ? "json_extract(value, '$.id')" : f.type === "attachment" ? "json_extract(value, '$.name')" : "value";
      if (c.op === "contains" || c.op === "ncontains") {
        const sql = `instr(lower(coalesce(${e}, '')), lower(?)) > 0`;
        return { sql: c.op === "contains" ? sql : `NOT (${sql})`, params: [String(v)] };
      }
      const vals = list(v).map(x => (f.type === "link" ? Number(x) : x));
      const inList = `(${vals.map(() => "?").join(",")})`;
      const src = `json_each(data, '$.${f.id}')`;
      if (c.op === "anyOf" || c.op === "eq") return { sql: `EXISTS (SELECT 1 FROM ${src} WHERE ${item} IN ${inList})`, params: vals };
      if (c.op === "noneOf" || c.op === "neq") return { sql: `NOT EXISTS (SELECT 1 FROM ${src} WHERE ${item} IN ${inList})`, params: vals };
      if (c.op === "allOf") return { sql: `(SELECT count(DISTINCT ${item}) FROM ${src} WHERE ${item} IN ${inList}) = ?`, params: [...vals, new Set(vals).size] };
      return null;
    }
    default: {
      const s = String(v);
      if (c.op === "eq") return { sql: `lower(${e}) = lower(?)`, params: [s] };
      if (c.op === "neq") return { sql: `(${e} IS NULL OR lower(${e}) <> lower(?))`, params: [s] };
      if (c.op === "contains") return { sql: `instr(lower(${e}), lower(?)) > 0`, params: [s] };
      if (c.op === "ncontains") return { sql: `(${e} IS NULL OR instr(lower(${e}), lower(?)) = 0)`, params: [s] };
      if (cmp[c.op]) return { sql: `${e} ${cmp[c.op]} ?`, params: [s] };
      return null;
    }
  }
}

export function filterSql(spec: FilterSpec | undefined, fields: Map<string, Field>): SqlPart | null {
  if (!spec || !spec.conditions?.length) return null;
  const parts: SqlPart[] = [];
  for (const c of spec.conditions) {
    const f = fields.get(c.fieldId);
    if (!f) continue;
    const p = conditionSql(f, c);
    if (p) parts.push(p);
  }
  if (!parts.length) return null;
  const joiner = spec.conjunction === "or" ? " OR " : " AND ";
  return { sql: "(" + parts.map(p => `(${p.sql})`).join(joiner) + ")", params: parts.flatMap(p => p.params) };
}

export function searchSql(search: string | undefined, fields: Field[]): SqlPart | null {
  const s = search?.trim();
  if (!s) return null;
  const needle = s.toLowerCase();
  const parts: SqlPart[] = [];
  // Each cell's own values: the row JSON also holds field ids, option ids and link ids, which must not match.
  // Linked records and lookups of them match on their titles, attachments on their file names.
  for (const f of fields) {
    if (!SEARCHED.has(f.type) || !isSafeId(f.id)) continue;
    parts.push({
      sql: `EXISTS (SELECT 1 FROM json_each(data, '$.${f.id}') WHERE instr(lower(CASE type WHEN 'object' THEN coalesce(json_extract(value, '$.t'), json_extract(value, '$.name')) WHEN 'array' THEN NULL ELSE value END), ?) > 0)`,
      params: [needle],
    });
  }
  // Select cells store choice ids, so match choice names separately.
  for (const f of fields) {
    if (f.type !== "singleSelect" && f.type !== "multiSelect") continue;
    const ids = (f.options.choices ?? []).filter(ch => ch.name.toLowerCase().includes(needle) && isSafeId(ch.id)).map(ch => ch.id);
    if (!ids.length) continue;
    const inList = `(${ids.map(id => `'${id}'`).join(",")})`;
    parts.push(
      f.type === "singleSelect"
        ? { sql: `json_extract(data, '$.${f.id}') IN ${inList}`, params: [] }
        : { sql: `EXISTS (SELECT 1 FROM json_each(data, '$.${f.id}') WHERE value IN ${inList})`, params: [] },
    );
  }
  if (!parts.length) return { sql: "0", params: [] };
  return { sql: "(" + parts.map(p => p.sql).join(" OR ") + ")", params: parts.flatMap(p => p.params) };
}

const SEARCHED: ReadonlySet<Field["type"]> = new Set(["text", "longText", "email", "url", "phone", "number", "date", "formula", "rollup", "lookup", "link", "attachment"]);

export function sortExpr(f: Field): SqlPart {
  const e = valueExpr(f);
  switch (f.type) {
    case "singleSelect":
    case "multiSelect": {
      const choices = f.options.choices ?? [];
      const target = f.type === "multiSelect" ? `json_extract(data, '$.${f.id}[0]')` : e;
      // Choice ids are generated and validated, so they are inlined: DO SQLite allows only 100 bound parameters.
      const safe = choices.filter(c => isSafeId(c.id));
      if (!safe.length) return { sql: target, params: [] };
      return { sql: `CASE ${target} ${safe.map((c, i) => `WHEN '${c.id}' THEN ${i}`).join(" ")} ELSE NULL END`, params: [] };
    }
    case "link":
      return { sql: `json_extract(data, '$.${f.id}[0].t') COLLATE NOCASE`, params: [] };
    case "lookup":
    case "attachment":
      return { sql: `json_extract(data, '$.${f.id}[0]')`, params: [] };
    case "checkbox":
      return { sql: `coalesce(${e}, 0)`, params: [] };
    case "text":
    case "longText":
    case "email":
    case "url":
    case "phone":
      return { sql: `${e} COLLATE NOCASE`, params: [] };
    default:
      return { sql: e, params: [] };
  }
}

export function orderSql(sorts: SortSpec[] | undefined, fields: Map<string, Field>): SqlPart {
  const parts: SqlPart[] = [];
  for (const s of sorts ?? []) {
    const f = fields.get(s.fieldId);
    if (!f) continue;
    const p = sortExpr(f);
    // Empty values last in both directions, like Airtable.
    parts.push({ sql: `(${p.sql}) IS NULL, ${p.sql} ${s.dir === "desc" ? "DESC" : "ASC"}`, params: [...p.params, ...p.params] });
  }
  parts.push({ sql: "ord", params: [] });
  return { sql: parts.map(p => p.sql).join(", "), params: parts.flatMap(p => p.params) };
}

/** The date part (YYYY-MM-DD, UTC) of a date-like field as SQL text. */
export function dayExpr(f: Field): string {
  if (f.type === "createdTime" || f.type === "modifiedTime") return `strftime('%Y-%m-%d', ${valueExpr(f)} / 1000, 'unixepoch')`;
  return `substr(${valueExpr(f)}, 1, 10)`;
}

export interface DateRange {
  startFieldId: string;
  endFieldId?: string;
  durationFieldId?: string;
  from: string;
  to: string;
}

/**
 * Records whose [start, end] span overlaps [from, to]. The end is the end field, or start plus
 * (duration - 1) days, or the start; an end before the start counts as the start. Fields are validated by the caller.
 */
export function rangeSql(r: DateRange, fields: Map<string, Field>): SqlPart {
  const s = dayExpr(fields.get(r.startFieldId)!);
  const endField = r.endFieldId ? fields.get(r.endFieldId) : undefined;
  const durField = !endField && r.durationFieldId ? fields.get(r.durationFieldId) : undefined;
  const e = endField
    ? `coalesce(${dayExpr(endField)}, ${s})`
    : durField
      ? `date(${s}, '+' || (max(coalesce(cast(${valueExpr(durField)} AS INTEGER), 1), 1) - 1) || ' days')`
      : s;
  return { sql: `(${s} IS NOT NULL AND ${s} <= ? AND max(${s}, coalesce(${e}, ${s})) >= ?)`, params: [r.to, r.from] };
}
