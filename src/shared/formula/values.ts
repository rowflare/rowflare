import { ERROR_VALUE, fail, type Value } from "./types";

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function flatten(v: Value, out: Value[] = []): Value[] {
  if (Array.isArray(v)) for (const x of v) flatten(x, out);
  else out.push(v);
  return out;
}

export function flattenArgs(args: Value[]): Value[] {
  const out: Value[] = [];
  for (const a of args) flatten(a, out);
  return out;
}

export function isNumericString(s: string): boolean {
  return NUMERIC.test(s.trim());
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toPrecision(15)));
}

export function toStr(v: Value): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return v.map(toStr).join(", ");
}

export function toNumOrNaN(v: Value): number {
  if (typeof v === "number") return v;
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return 0;
    return NUMERIC.test(s) ? Number(s) : NaN;
  }
  const f = flatten(v);
  if (f.length === 0) return 0;
  if (f.length === 1) return toNumOrNaN(f[0]);
  return NaN;
}

export function toNum(v: Value): number {
  const n = toNumOrNaN(v);
  if (!Number.isFinite(n)) fail("not a number");
  return n;
}

export function toInt(v: Value): number {
  return Math.trunc(toNum(v));
}

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function isBlank(v: Value): boolean {
  return v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

export function toArray(v: Value): Value[] {
  if (Array.isArray(v)) return v;
  return v === null ? [] : [v];
}

export function isErrorValue(v: Value): boolean {
  return v === ERROR_VALUE;
}

function scalar(v: Value): Value {
  if (!Array.isArray(v)) return v;
  const f = flatten(v);
  if (f.length === 0) return null;
  if (f.length === 1) return f[0];
  return toStr(f);
}

function dateMs(s: string): number {
  let t = s.length > 10 ? s.replace(" ", "T") : s;
  if (t.length > 10 && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(t)) t += "Z";
  return Date.parse(t);
}

export function looseEquals(a: Value, b: Value): boolean {
  a = scalar(a);
  b = scalar(b);
  if (a === null || b === null) {
    const o = a === null ? b : a;
    return o === null || o === "" || o === 0 || o === false;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return true;
    if (ISO_DATE.test(a) && ISO_DATE.test(b)) return dateMs(a) === dateMs(b);
    return false;
  }
  if (typeof a === "string" || typeof b === "string") {
    const s = (typeof a === "string" ? a : b) as string;
    const o = typeof a === "string" ? b : a;
    if (isNumericString(s)) return Number(s) === toNumOrNaN(o);
    return s === toStr(o);
  }
  return toNumOrNaN(a) === toNumOrNaN(b);
}

export function compare(a: Value, b: Value): number {
  a = scalar(a);
  b = scalar(b);
  if (typeof a === "string" && typeof b === "string") {
    if (ISO_DATE.test(a) && ISO_DATE.test(b)) return dateMs(a) - dateMs(b);
    if (isNumericString(a) && isNumericString(b)) return Number(a) - Number(b);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if ((typeof a === "string" && ISO_DATE.test(a) && b === null) || (typeof b === "string" && ISO_DATE.test(b) && a === null)) return NaN;
  const x = toNumOrNaN(a);
  const y = toNumOrNaN(b);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    const s = toStr(a);
    const t = toStr(b);
    return s < t ? -1 : s > t ? 1 : 0;
  }
  return x - y;
}
