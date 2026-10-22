// {{...}} references in automation steps: parsing, rendering as text or typed values,
// checking references against the schema, and showing field names in the editor.
import type { Field, Row, Table } from "./types";
import { displayCell, formulaValue } from "./cells";
import { flatSteps, RECORD_SOURCES, triggerTableId, type AutomationConfig, type AutomationSchema, type Step, type StepOutput, type Template, type Trigger } from "./automations";

export type Part = { text: string } | { path: string[] };

const REF = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function parseTemplate(tpl: Template): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of tpl.matchAll(REF)) {
    if (m.index! > last) out.push({ text: tpl.slice(last, m.index) });
    out.push({ path: splitPath(m[1]) });
    last = m.index! + m[0].length;
  }
  if (last < tpl.length) out.push({ text: tpl.slice(last) });
  return out;
}

/** "steps.s1.records[0].fldA" becomes ["steps", "s1", "records", "0", "fldA"]. */
export function splitPath(s: string): string[] {
  return s.replace(/\[(\d+)\]/g, ".$1").split(".").map(x => x.trim()).filter(Boolean);
}

export function templatePaths(tpl: Template): string[][] {
  return parseTemplate(tpl).flatMap(p => ("path" in p ? [p.path] : []));
}

export interface RecordRef {
  tableId: string;
  row: Row;
}

export interface TemplateContext {
  trigger: { record?: RecordRef; body?: unknown };
  steps: Record<string, StepOutput>;
  now: number;
  automationName: string;
  /** Origin plus /base/<id>, without a trailing slash. */
  baseUrl: string;
}

export interface TemplateEnv {
  field(id: string): Field | undefined;
  table(id: string): Pick<Table, "id" | "primaryFieldId"> | undefined;
  /** Rows by id, in the given order; missing ids are skipped. */
  rows(tableId: string, ids: number[]): Row[];
  userName(id: string): string;
}

interface Resolved {
  value: unknown;
  text: string;
}

const EMPTY: Resolved = { value: undefined, text: "" };
const plain = (s: string): Resolved => ({ value: s, text: s });

export function recordUrl(baseUrl: string, tableId: string, id: number): string {
  return `${baseUrl}/${tableId}?record=${id}`;
}

function cellOf(f: Field, r: Row): unknown {
  if (f.type === "createdTime") return r.createdAt;
  if (f.type === "modifiedTime") return r.updatedAt;
  if (f.type === "autonumber") return r.id;
  return r.cells[f.id];
}

function fieldValue(f: Field, row: Row, env: TemplateEnv): Resolved {
  const raw = cellOf(f, row);
  if (raw === undefined || raw === null) return EMPTY;
  const ctx = { userName: env.userName };
  let value: unknown;
  if (f.type === "link") value = (raw as { id: number }[]).map(x => ({ id: x.id }));
  else if (f.type === "user" || f.type === "attachment") value = raw;
  else value = formulaValue(f, raw, ctx);
  return { value, text: displayCell(f, raw, ctx) };
}

function title(r: RecordRef, env: TemplateEnv): string {
  const t = env.table(r.tableId);
  const f = t && env.field(t.primaryFieldId);
  return f ? displayCell(f, cellOf(f, r.row), { userName: env.userName }) : String(r.row.id);
}

function recordPath(list: RecordRef[], tail: string[], env: TemplateEnv): Resolved {
  if (!list.length) return EMPTY;
  // The records themselves: ids for link fields, titles as text.
  if (!tail.length) return { value: list.map(r => ({ id: r.row.id })), text: list.map(r => title(r, env)).join(", ") };
  const f = env.field(tail[0]);
  if (!f) return EMPTY;
  const parts = list.map(r => fieldValue(f, r.row, env));
  if (parts.length === 1) return parts[0];
  return {
    value: parts.flatMap(p => (Array.isArray(p.value) ? p.value : p.value === undefined ? [] : [p.value])),
    text: parts.map(p => p.text).filter(Boolean).join(", "),
  };
}

function jsonPath(v: unknown, path: string[]): Resolved {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return EMPTY;
    cur = Array.isArray(cur) ? cur[Number(k)] : (cur as Record<string, unknown>)[k];
  }
  if (cur === undefined || cur === null) return EMPTY;
  return { value: cur, text: typeof cur === "string" ? cur : typeof cur === "number" || typeof cur === "boolean" ? String(cur) : JSON.stringify(cur) };
}

function resolve(path: string[], ctx: TemplateContext, env: TemplateEnv): Resolved {
  const [head, ...rest] = path;
  if (head === "now" && !rest.length) return plain(new Date(ctx.now).toISOString());
  if (head === "automation" && rest[0] === "name") return plain(ctx.automationName);
  if (head === "base" && rest[0] === "url") return plain(ctx.baseUrl);
  if (head === "record" && rest[0] === "url") {
    const r = ctx.trigger.record;
    return r ? plain(recordUrl(ctx.baseUrl, r.tableId, r.row.id)) : EMPTY;
  }
  if (head === "trigger") {
    if (rest[0] === "record") return ctx.trigger.record ? recordPath([ctx.trigger.record], rest.slice(1), env) : EMPTY;
    if (rest[0] === "body") return jsonPath(ctx.trigger.body, rest.slice(1));
    return EMPTY;
  }
  if (head === "steps") {
    const out = ctx.steps[rest[0]];
    if (!out) return EMPTY;
    const key = rest[1];
    if (key === "records" || key === "record") {
      const recs = out.records;
      if (!recs) return EMPTY;
      let tail = rest.slice(2);
      let ids = recs.ids;
      if (key === "record") ids = ids.slice(0, 1);
      else if (tail.length && /^\d+$/.test(tail[0])) {
        ids = ids.slice(Number(tail[0]), Number(tail[0]) + 1);
        tail = tail.slice(1);
      }
      return recordPath(env.rows(recs.tableId, ids).map(row => ({ tableId: recs.tableId, row })), tail, env);
    }
    if (key === "body") return jsonPath(out.body, rest.slice(2));
    if (key === "text") return jsonPath(out.text, []);
    if (key === "json") return jsonPath(out.json, rest.slice(2));
    if (key === "count" || key === "status" || key === "matched" || key === "messageId") return jsonPath(out[key], []);
    return EMPTY;
  }
  return EMPTY;
}

export interface RenderOptions {
  /** Numbers without currency or percent formatting, for URLs and request bodies. */
  plainNumbers?: boolean;
  /** The template is JSON: values inside string literals are escaped, values outside them are inserted as they are. */
  json?: boolean;
  /** The template is a URL: values after the "scheme://" part are percent-encoded; a value that is the whole URL is kept. */
  url?: boolean;
}

/** Whether a JSON text ends inside a string literal, given whether it started inside one. */
function inJsonString(text: string, inside: boolean): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && inside) i++;
    else if (text[i] === '"') inside = !inside;
  }
  return inside;
}

/** Text with every reference replaced; `escape` applies to inserted values only (HTML email bodies). */
export function renderText(tpl: Template, ctx: TemplateContext, env: TemplateEnv, escape?: (s: string) => string, opts: RenderOptions = {}): string {
  let inString = false;
  let before = "";
  return parseTemplate(tpl)
    .map(p => {
      if ("text" in p) {
        if (opts.json) inString = inJsonString(p.text, inString);
        before += p.text;
        return p.text;
      }
      const r = resolve(p.path, ctx, env);
      let t = opts.plainNumbers && typeof r.value === "number" ? String(r.value) : r.text;
      if (opts.json && inString) t = JSON.stringify(t).slice(1, -1);
      if (opts.url && before.includes("://")) t = encodeURIComponent(t);
      before += t;
      return escape ? escape(t) : t;
    })
    .join("");
}

/** A template that is exactly one reference keeps the referenced value's type; anything else renders as text. */
export function renderValue(tpl: Template, ctx: TemplateContext, env: TemplateEnv): unknown {
  const parts = parseTemplate(tpl.trim());
  if (parts.length === 1 && "path" in parts[0]) return resolve(parts[0].path, ctx, env).value;
  return renderText(tpl, ctx, env);
}

/** Every template string inside a step (not its children). */
export function stepTemplates(st: Step): string[] {
  switch (st.type) {
    case "createRecord":
    case "updateRecords":
      return Object.values(st.values ?? {});
    case "findRecords":
      return (st.conditions?.conditions ?? []).flatMap(c => (typeof c.value === "string" ? [c.value] : []));
    case "http":
      return [st.url, ...(st.headers ?? []).map(h => h[1]), ...(st.body !== undefined ? [st.body] : [])];
    case "email":
      return [st.to, st.cc ?? "", st.subject, st.body];
    case "branch":
      return st.conditions.flatMap(c => [c.left, c.right ?? ""]);
    case "ai":
      return [st.prompt];
  }
}

const OUTPUT_KEYS: Record<Step["type"], string[]> = {
  createRecord: ["record", "records"],
  updateRecords: ["record", "records", "count"],
  findRecords: ["record", "records", "count"],
  http: ["status", "body"],
  email: ["messageId"],
  branch: ["matched"],
  ai: ["text", "json"],
};

function pathOk(path: string[], trigger: Trigger, before: Map<string, Step>, fieldsOf: (tableId: string) => Set<string>): boolean {
  const [head, ...rest] = path;
  if (head === "now") return !rest.length;
  if (head === "automation") return rest.length === 1 && rest[0] === "name";
  if (head === "base") return rest.length === 1 && rest[0] === "url";
  if (head === "record") return rest.length === 1 && rest[0] === "url" && RECORD_SOURCES.has(trigger.type);
  if (head === "trigger") {
    if (rest[0] === "body") return trigger.type === "webhook";
    if (rest[0] !== "record" || !RECORD_SOURCES.has(trigger.type)) return false;
    return rest.length === 1 || (rest.length === 2 && fieldsOf(triggerTableId(trigger) ?? "").has(rest[1]));
  }
  if (head === "steps") {
    const st = before.get(rest[0]);
    const key = rest[1];
    if (!st || !key || !OUTPUT_KEYS[st.type].includes(key)) return false;
    if (key !== "record" && key !== "records") return key === "body" || key === "json" || rest.length === 2;
    let tail = rest.slice(2);
    if (key === "records" && tail.length && /^\d+$/.test(tail[0])) tail = tail.slice(1);
    return !tail.length || (tail.length === 1 && "tableId" in st && fieldsOf(st.tableId).has(tail[0]));
  }
  return false;
}

/** The first template that refers to something that does not exist at that point of the run, or null. */
export function templateProblem(cfg: AutomationConfig, s: AutomationSchema): string | null {
  const fieldsOf = (tableId: string) => new Set(s.fields.filter(f => f.tableId === tableId).map(f => f.id));
  const before = new Map<string, Step>();
  for (const st of flatSteps(cfg.steps)) {
    for (const tpl of stepTemplates(st)) {
      for (const path of templatePaths(tpl)) if (!pathOk(path, cfg.trigger, before, fieldsOf)) return `Unknown reference {{${path.join(".")}}}`;
    }
    before.set(st.id, st);
  }
  return null;
}

export interface NameContext {
  fields: Field[];
  triggerTableId?: string;
  stepTableId(id: string): string | undefined;
}

/** The table and the field part of a record reference, or null for other references. */
function fieldRef(inner: string, n: NameContext): { prefix: string; tableId: string; rest: string } | null {
  let m = /^(trigger\.record)\.(.+)$/.exec(inner);
  if (m && n.triggerTableId) return { prefix: m[1], tableId: n.triggerTableId, rest: m[2] };
  m = /^(steps\.([A-Za-z0-9_]+)\.(?:records(?:\[\d+\])?|record))\.(.+)$/.exec(inner);
  const tableId = m ? n.stepTableId(m[2]) : undefined;
  if (m && tableId) return { prefix: m[1], tableId, rest: m[3] };
  return null;
}

function mapRefs(tpl: string, n: NameContext, map: (tableId: string, rest: string) => string | undefined): string {
  return tpl.replace(REF, (all, inner: string) => {
    const r = fieldRef(inner.trim(), n);
    if (!r) return all;
    const next = map(r.tableId, r.rest);
    return next === undefined ? all : `{{${r.prefix}.${next}}}`;
  });
}

/** Stored ids to field names, for editing. */
export function toDisplay(tpl: Template, n: NameContext): string {
  return mapRefs(tpl, n, (tableId, id) => n.fields.find(f => f.tableId === tableId && f.id === id)?.name);
}

/** Field names back to ids; unknown names are kept, so validation reports them. */
export function fromDisplay(text: string, n: NameContext): Template {
  return mapRefs(text, n, (tableId, name) => {
    const list = n.fields.filter(f => f.tableId === tableId);
    const key = name.trim();
    return (list.find(f => f.name === key) ?? list.find(f => f.name.toLowerCase() === key.toLowerCase()) ?? list.find(f => f.id === key))?.id;
  });
}
