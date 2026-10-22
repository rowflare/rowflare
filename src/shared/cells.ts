// Cell value normalization and display, shared by server (writes) and client (paste, render).
import type { Attachment, Choice, Field, LinkValue } from "./types";
import { newChoiceId } from "./ids";
import { COLORS } from "./types";
import type { Value } from "./formula";

export interface CoerceContext {
  /** When true, unknown select options are created (paste, import, API typecast). */
  typecast?: boolean;
  /** Called when a new select choice is created during typecast. */
  onNewChoice?: (field: Field, choice: Choice) => void;
  /** Resolves a typed name to a record id in the linked table (paste / typecast of link cells). */
  findLinked?: (field: Field, text: string) => LinkValue | null;
  /** Resolves a user name or email to a user id. */
  findUser?: (text: string) => string | null;
  /** Primary text for a linked record id given without text. */
  linkText?: (field: Field, id: number) => string | null;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  let pct = false;
  if (s.endsWith("%")) { pct = true; s = s.slice(0, -1); }
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\s,$€£¥]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  let n = Number(s);
  if (neg) n = -n;
  if (pct) n = n / 100;
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Parses common date formats to an ISO string: YYYY-MM-DD, or a full ISO datetime when includeTime. */
export function parseDate(v: unknown, includeTime = false): string | null {
  if (v === null || v === undefined || v === "") return null;
  let d: Date | null = null;
  if (typeof v === "number") d = new Date(v);
  else if (v instanceof Date) d = v;
  else if (typeof v === "string") {
    const s = v.trim();
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i))) {
      let y = +m[3];
      if (y < 100) y += 2000;
      let h = m[4] ? +m[4] : 0;
      if (m[7]) h = (h % 12) + (m[7].toLowerCase() === "pm" ? 12 : 0);
      d = new Date(Date.UTC(y, +m[1] - 1, +m[2], h, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0));
    } else if ((m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i)) && MONTHS.includes(m[2].toLowerCase())) {
      d = new Date(Date.UTC(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1]));
    } else if ((m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i)) && MONTHS.includes(m[1].toLowerCase())) {
      d = new Date(Date.UTC(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2]));
    } else {
      const t = Date.parse(s);
      if (!Number.isNaN(t)) d = new Date(t);
    }
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  if (includeTime) return d.toISOString();
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function splitList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    // Comma separated, with optional quotes around items that contain commas.
    const out: string[] = [];
    let cur = "", quoted = false;
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (quoted) {
        if (ch === '"' && v[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"' && !cur.trim()) { cur = ""; quoted = true; }
      else if (ch === ",") { if (cur.trim()) out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  return v === null || v === undefined ? [] : [v];
}

function resolveChoice(field: Field, v: unknown, ctx: CoerceContext): string | null {
  const choices = field.options.choices ?? [];
  if (typeof v === "object" && v !== null && "id" in v) v = (v as Choice).id;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s) return null;
  const byId = choices.find(c => c.id === s);
  if (byId) return byId.id;
  const byName = choices.find(c => c.name === s) ?? choices.find(c => c.name.toLowerCase() === s.toLowerCase());
  if (byName) return byName.id;
  if (!ctx.typecast) return null;
  const choice: Choice = { id: newChoiceId(), name: s, color: COLORS[choices.length % COLORS.length] };
  field.options.choices = [...choices, choice];
  ctx.onNewChoice?.(field, choice);
  return choice.id;
}

/**
 * Normalizes a value written to a cell. Returns undefined to clear the cell.
 * Computed field types are not handled here.
 */
export function coerceCell(field: Field, v: unknown, ctx: CoerceContext = {}): unknown {
  if (isBlank(v)) return undefined;
  switch (field.type) {
    case "text":
    case "email":
    case "url":
    case "phone": {
      const s = Array.isArray(v) ? v.map(x => displayScalar(x)).join(", ") : displayScalar(v);
      const t = field.type === "text" ? s.replace(/\r?\n/g, " ") : s.trim();
      return t === "" ? undefined : t;
    }
    case "longText": {
      const s = Array.isArray(v) ? v.map(x => displayScalar(x)).join(", ") : displayScalar(v);
      return s === "" ? undefined : s;
    }
    case "number": {
      const n = parseNumber(Array.isArray(v) ? v[0] : v);
      if (n === null) return undefined;
      const p = field.options.precision;
      return p === undefined ? n : Math.round(n * 10 ** p) / 10 ** p;
    }
    case "checkbox": {
      if (typeof v === "string") return /^(true|1|yes|y|checked|x|on|✓|✔)$/i.test(v.trim()) ? true : undefined;
      return v ? true : undefined;
    }
    case "singleSelect": {
      const id = resolveChoice(field, Array.isArray(v) ? v[0] : v, ctx);
      return id ?? undefined;
    }
    case "multiSelect": {
      const ids: string[] = [];
      for (const item of splitList(v)) {
        const id = resolveChoice(field, item, ctx);
        if (id && !ids.includes(id)) ids.push(id);
      }
      return ids.length ? ids : undefined;
    }
    case "date":
      return parseDate(v, !!field.options.includeTime) ?? undefined;
    case "attachment": {
      const list = (Array.isArray(v) ? v : [v]).filter(
        (a): a is Attachment => typeof a === "object" && a !== null && typeof (a as Attachment).key === "string",
      );
      const out = list.map(a => ({ id: String(a.id), name: String(a.name ?? "file"), size: Number(a.size) || 0, type: String(a.type ?? ""), key: a.key }));
      return out.length ? out : undefined;
    }
    case "link": {
      const out: LinkValue[] = [];
      for (const item of splitList(v)) {
        let lv: LinkValue | null = null;
        if (typeof item === "number") lv = { id: item, t: ctx.linkText?.(field, item) ?? "" };
        else if (typeof item === "object" && item !== null && "id" in item) {
          const id = Number((item as LinkValue).id);
          lv = { id, t: ctx.linkText?.(field, id) ?? String((item as LinkValue).t ?? "") };
        } else if (typeof item === "string") {
          if (/^\d+$/.test(item) && ctx.linkText?.(field, Number(item)) != null) lv = { id: Number(item), t: ctx.linkText!(field, Number(item))! };
          else lv = ctx.findLinked?.(field, item) ?? null;
        }
        if (lv && Number.isFinite(lv.id) && !out.some(x => x.id === lv!.id)) out.push(lv);
      }
      return out.length ? out : undefined;
    }
    case "user": {
      const ids: string[] = [];
      for (const item of splitList(v)) {
        const s = typeof item === "object" && item !== null && "id" in item ? String((item as { id: string }).id) : String(item);
        const id = ctx.findUser ? ctx.findUser(s) : s;
        if (id && !ids.includes(id)) ids.push(id);
      }
      if (!ids.length) return undefined;
      return field.options.multiple ? ids : ids[0];
    }
    default:
      return undefined;
  }
}

function displayScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "checked" : "";
  if (Array.isArray(v)) return v.map(displayScalar).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.t === "string") return o.t;
    if (typeof o.name === "string") return o.name;
  }
  return JSON.stringify(v);
}

export function formatNumber(field: Field, n: number): string {
  const p = field.options.precision;
  const fmt = field.options.format ?? "number";
  if (fmt === "percent") return (n * 100).toFixed(p ?? 0) + "%";
  const s = p === undefined ? String(n) : n.toLocaleString("en-US", { minimumFractionDigits: p, maximumFractionDigits: p });
  if (fmt === "currency") return (n < 0 ? "-" : "") + (field.options.symbol ?? "$") + s.replace(/^-/, "");
  return s;
}

export interface DisplayContext {
  userName?: (id: string) => string;
}

/** Human-readable text for any cell value (CSV export, link titles, copy, type conversion). */
export function displayCell(field: Field, v: unknown, ctx: DisplayContext = {}): string {
  if (v === null || v === undefined) return "";
  switch (field.type) {
    case "number":
      return typeof v === "number" ? formatNumber(field, v) : displayScalar(v);
    case "singleSelect":
      return field.options.choices?.find(c => c.id === v)?.name ?? "";
    case "multiSelect":
      return (Array.isArray(v) ? v : [])
        .map(id => field.options.choices?.find(c => c.id === id)?.name)
        .filter(Boolean)
        .map(n => (String(n).includes(",") ? `"${String(n).replace(/"/g, '""')}"` : n))
        .join(", ");
    case "checkbox":
      return v ? "checked" : "";
    case "user":
      return (Array.isArray(v) ? v : [v]).map(id => ctx.userName?.(String(id)) ?? String(id)).join(", ");
    case "createdTime":
    case "modifiedTime":
      return typeof v === "number" ? new Date(v).toISOString() : String(v);
    case "formula":
    case "rollup":
      if (typeof v === "number" && field.options.format) return formatNumber(field, v);
      return displayScalar(v);
    default:
      return displayScalar(v);
  }
}

/** Value handed to formulas, lookups and rollups: select ids become names, links become titles. */
export function formulaValue(field: Field, v: unknown, ctx: DisplayContext = {}): Value {
  if (v === null || v === undefined) return null;
  switch (field.type) {
    case "singleSelect":
      return field.options.choices?.find(c => c.id === v)?.name ?? null;
    case "multiSelect":
      return (Array.isArray(v) ? v : []).map(id => field.options.choices?.find(c => c.id === id)?.name ?? null).filter((x): x is string => x !== null);
    case "link":
      return (Array.isArray(v) ? v : []).map(x => String((x as LinkValue).t ?? ""));
    case "attachment":
      return (Array.isArray(v) ? v : []).map(x => String((x as Attachment).name ?? ""));
    case "user":
      return Array.isArray(v) ? v.map(id => ctx.userName?.(String(id)) ?? String(id)) : ctx.userName?.(String(v)) ?? String(v);
    case "checkbox":
      return !!v;
    case "createdTime":
    case "modifiedTime":
      return typeof v === "number" ? new Date(v).toISOString() : String(v);
    default:
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
      if (Array.isArray(v)) return v as Value[];
      return displayScalar(v);
  }
}
