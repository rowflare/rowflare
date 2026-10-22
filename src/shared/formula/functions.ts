import { fail, type EvalContext, type Value, type ValueType } from "./types";
import { addUnits, DAYS, dayOfYear, diffUnits, formatDate, holidaySet, isoDay, parseDate, startOf, toDate, toUnit, workday, workdayDiff, type Unit } from "./dates";
import { flatten, flattenArgs, isBlank, isNumericString, toArray, toInt, toNum, toStr, truthy } from "./values";

export type Impl = (a: Value[], ctx: EvalContext) => Value;
export type TypeRule = ValueType | "branch" | "first";

export interface FnDef {
  min: number;
  max: number;
  type: TypeRule;
  fn?: Impl;
  now?: boolean;
}

const INF = Infinity;

function shift(n: number, e: number): number {
  const [m, x] = String(n).split("e");
  return Number(m + "e" + (Number(x ?? 0) + e));
}

function roundWith(x: number, places: number, mode: (n: number) => number): number {
  const s = x < 0 ? -1 : 1;
  return s * shift(mode(shift(Math.abs(x), places)), -places);
}

const clean = (n: number) => parseFloat(n.toPrecision(15));

function numbers(args: Value[]): number[] {
  const out: number[] = [];
  for (const v of flattenArgs(args)) {
    if (typeof v === "number") out.push(v);
    else if (typeof v === "string" && v.trim() !== "" && isNumericString(v)) out.push(Number(v));
    else if (typeof v === "boolean") out.push(v ? 1 : 0);
  }
  return out;
}

const regexCache = new Map<string, RegExp>();
function regex(pattern: Value, flags = ""): RegExp {
  const key = flags + "/" + toStr(pattern);
  let re = regexCache.get(key);
  if (!re) {
    try {
      re = new RegExp(toStr(pattern), flags);
    } catch {
      fail("bad regex");
    }
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}

const iso = (d: Date) => {
  if (Number.isNaN(d.getTime())) fail("bad date");
  return d.toISOString();
};
const unitArg = (v: Value | undefined, dflt: Unit) => (v === undefined || isBlank(v) ? dflt : toUnit(v));

function weekStart(v: Value | undefined): number {
  if (v === undefined || isBlank(v)) return 0;
  const s = toStr(v).trim().toLowerCase();
  const i = DAYS.findIndex((d) => d.toLowerCase() === s);
  if (i < 0) fail("bad start day");
  return i;
}

function slice1(s: string, start: number, count: number): string {
  if (count < 0) fail("negative count");
  return s.substr(Math.max(0, start - 1), count);
}

function def(min: number, max: number, type: TypeRule, fn?: Impl, now?: boolean): FnDef {
  return { min, max, type, fn, now };
}

export const FUNCTIONS: Record<string, FnDef> = {
  ABS: def(1, 1, "number", (a) => Math.abs(toNum(a[0]))),
  AVERAGE: def(1, INF, "number", (a) => {
    const n = numbers(a);
    return n.length ? n.reduce((s, x) => s + x, 0) / n.length : 0;
  }),
  CEILING: def(1, 2, "number", (a) => {
    const sig = a.length > 1 ? Math.abs(toNum(a[1])) : 1;
    return sig === 0 ? 0 : clean(Math.ceil(clean(toNum(a[0]) / sig)) * sig);
  }),
  COUNT: def(1, INF, "number", (a) => flattenArgs(a).filter((v) => typeof v === "number").length),
  COUNTA: def(1, INF, "number", (a) => flattenArgs(a).filter((v) => !isBlank(v)).length),
  COUNTALL: def(1, INF, "number", (a) => flattenArgs(a).length),
  EVEN: def(1, 1, "number", (a) => {
    const x = toNum(a[0]);
    const r = Math.ceil(Math.abs(x) / 2) * 2;
    return x < 0 ? -r : r;
  }),
  EXP: def(1, 1, "number", (a) => Math.exp(toNum(a[0]))),
  FLOOR: def(1, 2, "number", (a) => {
    const sig = a.length > 1 ? Math.abs(toNum(a[1])) : 1;
    return sig === 0 ? 0 : clean(Math.floor(clean(toNum(a[0]) / sig)) * sig);
  }),
  INT: def(1, 1, "number", (a) => Math.floor(toNum(a[0]))),
  LOG: def(1, 2, "number", (a) => {
    const x = toNum(a[0]);
    const base = a.length > 1 ? toNum(a[1]) : 10;
    if (x <= 0 || base <= 0 || base === 1) fail("log domain");
    return clean(Math.log(x) / Math.log(base));
  }),
  MAX: def(1, INF, "number", (a) => {
    const n = numbers(a);
    return n.length ? Math.max(...n) : 0;
  }),
  MIN: def(1, INF, "number", (a) => {
    const n = numbers(a);
    return n.length ? Math.min(...n) : 0;
  }),
  MOD: def(2, 2, "number", (a) => {
    const d = toNum(a[1]);
    if (d === 0) fail("division by zero");
    return clean(toNum(a[0]) % d);
  }),
  ODD: def(1, 1, "number", (a) => {
    const x = toNum(a[0]);
    let r = Math.ceil(Math.abs(x));
    if (r % 2 === 0) r++;
    return x < 0 ? -r : r;
  }),
  POWER: def(2, 2, "number", (a) => Math.pow(toNum(a[0]), toNum(a[1]))),
  ROUND: def(1, 2, "number", (a) => roundWith(toNum(a[0]), a.length > 1 ? toInt(a[1]) : 0, Math.round)),
  ROUNDDOWN: def(1, 2, "number", (a) => roundWith(toNum(a[0]), a.length > 1 ? toInt(a[1]) : 0, Math.floor)),
  ROUNDUP: def(1, 2, "number", (a) => roundWith(toNum(a[0]), a.length > 1 ? toInt(a[1]) : 0, Math.ceil)),
  SQRT: def(1, 1, "number", (a) => {
    const x = toNum(a[0]);
    if (x < 0) fail("sqrt domain");
    return Math.sqrt(x);
  }),
  SUM: def(1, INF, "number", (a) => clean(numbers(a).reduce((s, x) => s + x, 0))),
  VALUE: def(1, 1, "number", (a) => {
    if (typeof a[0] === "number") return a[0];
    const s = toStr(a[0]).trim();
    if (isNumericString(s)) return Number(s);
    const c = s.replace(/[^0-9.-]/g, "");
    if (!/\d/.test(c)) return null;
    const n = parseFloat(c);
    if (Number.isNaN(n)) fail("bad number");
    return /^\(.*\)$/.test(s) ? -Math.abs(n) : n;
  }),

  CONCATENATE: def(1, INF, "text", (a) => {
    let s = "";
    for (const v of a) s += toStr(v);
    return s;
  }),
  ENCODE_URL_COMPONENT: def(1, 1, "text", (a) => encodeURIComponent(toStr(a[0]))),
  FIND: def(2, 3, "number", (a) => {
    const needle = toStr(a[0]);
    if (needle === "") return 0;
    const start = a.length > 2 ? Math.max(0, toInt(a[2]) - 1) : 0;
    return toStr(a[1]).indexOf(needle, start) + 1;
  }),
  LEFT: def(2, 2, "text", (a) => {
    const n = toInt(a[1]);
    if (n < 0) fail("negative count");
    return toStr(a[0]).slice(0, n);
  }),
  LEN: def(1, 1, "number", (a) => toStr(a[0]).length),
  LOWER: def(1, 1, "text", (a) => toStr(a[0]).toLowerCase()),
  MID: def(3, 3, "text", (a) => slice1(toStr(a[0]), toInt(a[1]), toInt(a[2]))),
  REPLACE: def(4, 4, "text", (a) => {
    const s = toStr(a[0]);
    const start = Math.max(1, toInt(a[1]));
    const count = toInt(a[2]);
    if (count < 0) fail("negative count");
    return s.slice(0, start - 1) + toStr(a[3]) + s.slice(start - 1 + count);
  }),
  REPT: def(2, 2, "text", (a) => {
    const n = toInt(a[1]);
    if (n < 0 || n > 100000) fail("bad count");
    return toStr(a[0]).repeat(n);
  }),
  RIGHT: def(2, 2, "text", (a) => {
    const n = toInt(a[1]);
    if (n < 0) fail("negative count");
    const s = toStr(a[0]);
    return n === 0 ? "" : s.slice(-n);
  }),
  SEARCH: def(2, 3, "number", (a) => {
    const needle = toStr(a[0]).toLowerCase();
    if (needle === "") return 0;
    const start = a.length > 2 ? Math.max(0, toInt(a[2]) - 1) : 0;
    return toStr(a[1]).toLowerCase().indexOf(needle, start) + 1;
  }),
  SUBSTITUTE: def(3, 4, "text", (a) => {
    const s = toStr(a[0]);
    const from = toStr(a[1]);
    const to = toStr(a[2]);
    if (from === "") return s;
    if (a.length < 4 || isBlank(a[3])) return s.split(from).join(to);
    const idx = toInt(a[3]);
    let pos = -1;
    for (let i = 0; i < idx; i++) {
      pos = s.indexOf(from, pos + (i === 0 ? 1 : from.length));
      if (pos < 0) return s;
    }
    return s.slice(0, pos) + to + s.slice(pos + from.length);
  }),
  T: def(1, 1, "text", (a) => {
    const v = a[0];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? toStr(v) : "";
    return "";
  }),
  TRIM: def(1, 1, "text", (a) => toStr(a[0]).trim()),
  UPPER: def(1, 1, "text", (a) => toStr(a[0]).toUpperCase()),
  REGEX_MATCH: def(2, 2, "boolean", (a) => regex(a[1]).test(toStr(a[0]))),
  REGEX_EXTRACT: def(2, 2, "text", (a) => {
    const m = regex(a[1]).exec(toStr(a[0]));
    return m ? m[0] : null;
  }),
  REGEX_REPLACE: def(3, 3, "text", (a) => toStr(a[0]).replace(regex(a[1], "g"), toStr(a[2]))),

  AND: def(1, INF, "boolean", (a) => {
    for (const v of a) if (Array.isArray(v) ? !v.length || !flatten(v).every(truthy) : !truthy(v)) return false;
    return true;
  }),
  BLANK: def(0, 0, "text", () => null),
  ERROR: def(0, 1, "text", () => fail("ERROR()")),
  FALSE: def(0, 0, "boolean", () => false),
  IF: def(2, 3, "branch"),
  ISERROR: def(1, 1, "boolean"),
  NOT: def(1, 1, "boolean", (a) => !truthy(a[0])),
  OR: def(1, INF, "boolean", (a) => {
    for (const v of a) if (Array.isArray(v) ? flatten(v).some(truthy) : truthy(v)) return true;
    return false;
  }),
  SWITCH: def(2, INF, "branch"),
  TRUE: def(0, 0, "boolean", () => true),
  XOR: def(1, INF, "boolean", (a) => {
    let n = 0;
    for (const v of flattenArgs(a)) if (truthy(v)) n++;
    return n % 2 === 1;
  }),

  DATEADD: def(3, 3, "date", (a) => iso(addUnits(toDate(a[0]), toNum(a[1]), toUnit(a[2])))),
  DATESTR: def(1, 1, "text", (a) => isoDay(toDate(a[0]))),
  DATETIME_DIFF: def(2, 3, "number", (a) => diffUnits(toDate(a[0]), toDate(a[1]), unitArg(a[2], "s"))),
  DATETIME_FORMAT: def(1, 2, "text", (a) => {
    const d = toDate(a[0]);
    return a.length > 1 && !isBlank(a[1]) ? formatDate(d, toStr(a[1])) : iso(d);
  }),
  DATETIME_PARSE: def(1, 3, "date", (a) => {
    if (isBlank(a[0])) return null;
    return iso(parseDate(toStr(a[0]), a.length > 1 && !isBlank(a[1]) ? toStr(a[1]) : undefined));
  }),
  DAY: def(1, 1, "number", (a) => toDate(a[0]).getUTCDate()),
  HOUR: def(1, 1, "number", (a) => toDate(a[0]).getUTCHours()),
  IS_AFTER: def(2, 2, "boolean", (a) => toDate(a[0]).getTime() > toDate(a[1]).getTime()),
  IS_BEFORE: def(2, 2, "boolean", (a) => toDate(a[0]).getTime() < toDate(a[1]).getTime()),
  IS_SAME: def(2, 3, "boolean", (a) => {
    const u = unitArg(a[2], "ms");
    return startOf(toDate(a[0]), u) === startOf(toDate(a[1]), u);
  }),
  MINUTE: def(1, 1, "number", (a) => toDate(a[0]).getUTCMinutes()),
  MONTH: def(1, 1, "number", (a) => toDate(a[0]).getUTCMonth() + 1),
  NOW: def(0, 0, "date", (_a, ctx) => ctx.now.toISOString(), true),
  SECOND: def(1, 1, "number", (a) => toDate(a[0]).getUTCSeconds()),
  TODAY: def(0, 0, "date", (_a, ctx) => isoDay(ctx.now), true),
  TONOW: def(1, 1, "number", (a, ctx) => diffUnits(ctx.now, toDate(a[0]), "d"), true),
  FROMNOW: def(1, 1, "number", (a, ctx) => diffUnits(toDate(a[0]), ctx.now, "d"), true),
  WEEKDAY: def(1, 2, "number", (a) => (toDate(a[0]).getUTCDay() - weekStart(a[1]) + 7) % 7),
  WEEKNUM: def(1, 2, "number", (a) => {
    const d = toDate(a[0]);
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).getUTCDay();
    const offset = (jan1 - weekStart(a[1]) + 7) % 7;
    return Math.floor((dayOfYear(d) - 1 + offset) / 7) + 1;
  }),
  WORKDAY: def(2, 3, "date", (a) => iso(workday(toDate(a[0]), toNum(a[1]), holidaySet(a[2])))),
  WORKDAY_DIFF: def(2, 3, "number", (a) => workdayDiff(toDate(a[0]), toDate(a[1]), holidaySet(a[2]))),
  YEAR: def(1, 1, "number", (a) => toDate(a[0]).getUTCFullYear()),

  ARRAYCOMPACT: def(1, 1, "array", (a) => flatten(toArray(a[0])).filter((v) => v !== null && v !== "")),
  ARRAYFLATTEN: def(1, 1, "array", (a) => flatten(toArray(a[0]))),
  ARRAYJOIN: def(1, 2, "text", (a) => {
    const sep = a.length > 1 ? toStr(a[1]) : ", ";
    return flatten(toArray(a[0])).map(toStr).join(sep);
  }),
  ARRAYUNIQUE: def(1, 1, "array", (a) => {
    const seen = new Set<string>();
    const out: Value[] = [];
    for (const v of flatten(toArray(a[0]))) {
      const k = typeof v + ":" + toStr(v);
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    return out;
  }),
  ARRAYSLICE: def(2, 3, "array", (a) => {
    const arr = toArray(a[0]);
    const n = arr.length;
    const norm = (i: number) => (i < 0 ? n + i : i - 1);
    const s = Math.max(0, norm(toInt(a[1])));
    const e = a.length > 2 && !isBlank(a[2]) ? norm(toInt(a[2])) : n - 1;
    return arr.slice(s, e + 1);
  }),
  RECORD_ID: def(0, 0, "text", (_a, ctx) => String(ctx.recordId)),
  CREATED_TIME: def(0, 0, "date", (_a, ctx) => ctx.createdTime),
  LAST_MODIFIED_TIME: def(0, INF, "date", (_a, ctx) => ctx.modifiedTime),
};

export const FUNCTION_NAMES: string[] = Object.keys(FUNCTIONS).sort();
