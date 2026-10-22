import { fail, type Value } from "./types";
import { toStr } from "./values";

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86400000;

export type Unit = "ms" | "s" | "m" | "h" | "d" | "w" | "M" | "Q" | "y";

const UNITS: Record<string, Unit> = {
  ms: "ms", millisecond: "ms", milliseconds: "ms",
  s: "s", second: "s", seconds: "s",
  m: "m", minute: "m", minutes: "m",
  h: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
  w: "w", week: "w", weeks: "w",
  M: "M", month: "M", months: "M",
  Q: "Q", quarter: "Q", quarters: "Q",
  y: "y", year: "y", years: "y",
};
const UNIT_MS: Partial<Record<Unit, number>> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: DAY_MS, w: 7 * DAY_MS };

export function toUnit(v: Value): Unit {
  const s = toStr(v).trim();
  const u = UNITS[s] ?? (s.length > 1 ? UNITS[s.toLowerCase()] : undefined);
  if (!u) fail("bad unit");
  return u;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function parseIso(s: string): number {
  const m = ISO.exec(s);
  if (!m) return NaN;
  const ms = m[7] ? Math.round(Number("0." + m[7]) * 1000) : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms);
  const d = new Date(t);
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return NaN;
  if (m[8] && m[8] !== "Z") {
    const sign = m[8][0] === "-" ? -1 : 1;
    const z = m[8].slice(1).replace(":", "");
    t -= sign * (+z.slice(0, 2) * 60 + +z.slice(2)) * 60000;
  }
  return t;
}

const FALLBACK_FORMATS = [
  "M/D/YYYY h:mm:ss A", "M/D/YYYY h:mm A", "M/D/YYYY H:mm:ss", "M/D/YYYY H:mm", "M/D/YYYY",
  "YYYY/M/D H:mm:ss", "YYYY/M/D H:mm", "YYYY/M/D",
  "MMMM D, YYYY h:mm A", "MMMM D, YYYY", "MMMM D YYYY", "MMM D, YYYY", "MMM D YYYY",
  "D MMMM YYYY", "D MMM YYYY", "MMMM YYYY", "YYYY-MM",
];

export function parseDate(text: string, format?: string): Date {
  const s = text.trim();
  if (format) {
    const t = parseWithFormat(s, format);
    if (Number.isNaN(t)) fail("bad date");
    return new Date(t);
  }
  let t = parseIso(s);
  if (Number.isNaN(t)) {
    for (const f of FALLBACK_FORMATS) {
      t = parseWithFormat(s, f);
      if (!Number.isNaN(t)) break;
    }
  }
  if (Number.isNaN(t) && /^-?\d{9,}$/.test(s)) t = Number(s) * (s.length > 11 ? 1 : 1000);
  if (Number.isNaN(t)) fail("bad date");
  return new Date(t);
}

export function toDate(v: Value): Date {
  if (Array.isArray(v)) v = v.length === 1 ? v[0] : null;
  if (v === null || v === "" || typeof v === "boolean") fail("blank date");
  if (typeof v === "number") return new Date(v);
  return parseDate(v as string);
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const PARSE_TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|HH|H|hh|h|mm|m|ss|s|SSS|A|a|X|x|ZZ|Z|dddd|ddd/g;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const formatCache = new Map<string, { re: RegExp; keys: string[] }>();

function parseWithFormat(s: string, format: string): number {
  let c = formatCache.get(format);
  if (!c) {
    const keys: string[] = [];
    let src = "";
    let last = 0;
    for (const m of format.matchAll(PARSE_TOKENS)) {
      src += esc(format.slice(last, m.index)).replace(/\s+/g, "\\s+");
      last = m.index! + m[0].length;
      if (m[1] !== undefined) { src += esc(m[1]); continue; }
      const t = m[0];
      keys.push(t);
      if (t === "YYYY") src += "(\\d{4})";
      else if (t === "YY") src += "(\\d{2})";
      else if (t === "MMMM" || t === "MMM" || t === "dddd" || t === "ddd") src += "([A-Za-z]+)\\.?";
      else if (t === "Do") src += "(\\d{1,2})(?:st|nd|rd|th)";
      else if (t === "SSS") src += "(\\d{1,3})";
      else if (t === "A" || t === "a") src += "([AaPp][Mm])";
      else if (t === "X" || t === "x") src += "(-?\\d+(?:\\.\\d+)?)";
      else if (t === "Z" || t === "ZZ") src += "(Z|[+-]\\d{2}:?\\d{2})";
      else src += "(\\d{1,2})";
    }
    src += esc(format.slice(last)).replace(/\s+/g, "\\s+");
    c = { re: new RegExp("^" + src + "$", "i"), keys };
    formatCache.set(format, c);
  }
  const m = c.re.exec(s);
  if (!m) return NaN;
  let y = 1970, mo = 0, d = 1, h = 0, mi = 0, sec = 0, ms = 0, pm: boolean | null = null, off = 0;
  for (let i = 0; i < c.keys.length; i++) {
    const k = c.keys[i];
    const v = m[i + 1];
    switch (k) {
      case "YYYY": y = +v; break;
      case "YY": y = +v + (+v < 70 ? 2000 : 1900); break;
      case "MMMM": case "MMM": {
        const idx = MONTHS.findIndex((n) => n.toLowerCase().startsWith(v.toLowerCase()) && v.length >= 3);
        if (idx < 0) return NaN;
        mo = idx;
        break;
      }
      case "MM": case "M": mo = +v - 1; break;
      case "DD": case "D": case "Do": d = +v; break;
      case "HH": case "H": case "hh": case "h": h = +v; break;
      case "mm": case "m": mi = +v; break;
      case "ss": case "s": sec = +v; break;
      case "SSS": ms = +v.padEnd(3, "0"); break;
      case "A": case "a": pm = v.toLowerCase() === "pm"; break;
      case "X": return Number(v) * 1000;
      case "x": return Number(v);
      case "Z": case "ZZ":
        if (v.toUpperCase() !== "Z") {
          const z = v.slice(1).replace(":", "");
          off = (v[0] === "-" ? -1 : 1) * (+z.slice(0, 2) * 60 + +z.slice(2)) * 60000;
        }
        break;
    }
  }
  if (pm !== null) {
    if (h < 1 || h > 12) return NaN;
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (mo < 0 || mo > 11 || d < 1 || h > 23 || mi > 59 || sec > 59) return NaN;
  const t = Date.UTC(y, mo, d, h, mi, sec, ms);
  if (new Date(t).getUTCDate() !== d) return NaN;
  return t - off;
}

const FORMAT_TOKENS = /\[([^\]]*)\]|LLLL|LLL|LL|LT|L|YYYY|YY|MMMM|MMM|MM|M|Do|DDDD|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|X|x|ZZ|Z|Q/g;
const NAMED: Record<string, string> = {
  L: "MM/DD/YYYY",
  LL: "MMMM D, YYYY",
  LLL: "MMMM D, YYYY h:mm A",
  LLLL: "dddd, MMMM D, YYYY h:mm A",
  LT: "h:mm A",
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return n + "th";
  return n + (["th", "st", "nd", "rd"][n % 10] ?? "th");
}

export function formatDate(d: Date, format: string): string {
  return format.replace(FORMAT_TOKENS, (tok, lit: string | undefined) => {
    if (lit !== undefined) return lit;
    const h = d.getUTCHours();
    switch (tok) {
      case "YYYY": return String(d.getUTCFullYear());
      case "YY": return pad(d.getUTCFullYear() % 100);
      case "MMMM": return MONTHS[d.getUTCMonth()];
      case "MMM": return MONTHS[d.getUTCMonth()].slice(0, 3);
      case "MM": return pad(d.getUTCMonth() + 1);
      case "M": return String(d.getUTCMonth() + 1);
      case "Q": return String(Math.floor(d.getUTCMonth() / 3) + 1);
      case "DDDD": return pad(dayOfYear(d), 3);
      case "DD": return pad(d.getUTCDate());
      case "D": return String(d.getUTCDate());
      case "Do": return ordinal(d.getUTCDate());
      case "dddd": return DAYS[d.getUTCDay()];
      case "ddd": return DAYS[d.getUTCDay()].slice(0, 3);
      case "dd": return DAYS[d.getUTCDay()].slice(0, 2);
      case "d": return String(d.getUTCDay());
      case "HH": return pad(h);
      case "H": return String(h);
      case "hh": return pad(h % 12 || 12);
      case "h": return String(h % 12 || 12);
      case "mm": return pad(d.getUTCMinutes());
      case "m": return String(d.getUTCMinutes());
      case "ss": return pad(d.getUTCSeconds());
      case "s": return String(d.getUTCSeconds());
      case "SSS": return pad(d.getUTCMilliseconds(), 3);
      case "A": return h < 12 ? "AM" : "PM";
      case "a": return h < 12 ? "am" : "pm";
      case "X": return String(Math.floor(d.getTime() / 1000));
      case "x": return String(d.getTime());
      case "Z": return "+00:00";
      case "ZZ": return "+0000";
      default: return formatDate(d, NAMED[tok]);
    }
  });
}

export function dayOfYear(d: Date): number {
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
}

export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const r = new Date(d.getTime());
  r.setUTCFullYear(y, m, Math.min(d.getUTCDate(), last));
  return r;
}

export function addUnits(d: Date, n: number, u: Unit): Date {
  const ms = UNIT_MS[u];
  if (ms) return new Date(d.getTime() + n * ms);
  const k = Math.trunc(n);
  return addMonths(d, u === "M" ? k : u === "Q" ? k * 3 : k * 12);
}

function monthDiff(a: Date, b: Date): number {
  let m = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + a.getUTCMonth() - b.getUTCMonth();
  const anchor = addMonths(b, m).getTime();
  if (m > 0 && anchor > a.getTime()) m--;
  else if (m < 0 && anchor < a.getTime()) m++;
  return m;
}

export function diffUnits(a: Date, b: Date, u: Unit): number {
  const ms = UNIT_MS[u];
  if (ms) return Math.trunc((a.getTime() - b.getTime()) / ms);
  const m = monthDiff(a, b);
  return u === "M" ? m : Math.trunc(m / (u === "Q" ? 3 : 12));
}

export function startOf(d: Date, u: Unit): number {
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate();
  switch (u) {
    case "y": return Date.UTC(y, 0, 1);
    case "Q": return Date.UTC(y, mo - (mo % 3), 1);
    case "M": return Date.UTC(y, mo, 1);
    case "w": return Date.UTC(y, mo, day - d.getUTCDay());
    case "d": return Date.UTC(y, mo, day);
    case "h": return Date.UTC(y, mo, day, d.getUTCHours());
    case "m": return Date.UTC(y, mo, day, d.getUTCHours(), d.getUTCMinutes());
    case "s": return Math.floor(d.getTime() / 1000) * 1000;
    default: return d.getTime();
  }
}

function dayNumber(d: Date): number {
  return Math.floor(d.getTime() / DAY_MS);
}

function isWeekend(day: number): boolean {
  const wd = (((day + 4) % 7) + 7) % 7;
  return wd === 0 || wd === 6;
}

export function holidaySet(v: Value | undefined): Set<number> {
  const set = new Set<number>();
  if (v === undefined || v === null) return set;
  const parts = Array.isArray(v) ? v.map(toStr) : toStr(v).split(",");
  for (const p of parts) if (p.trim()) set.add(dayNumber(parseDate(p)));
  return set;
}

export function workday(start: Date, n: number, holidays: Set<number>): Date {
  let day = dayNumber(start);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(Math.trunc(n));
  while (left > 0) {
    day += step;
    if (!isWeekend(day) && !holidays.has(day)) left--;
  }
  return new Date(day * DAY_MS);
}

export function workdayDiff(a: Date, b: Date, holidays: Set<number>): number {
  let s = dayNumber(a), e = dayNumber(b), sign = 1;
  if (e < s) { [s, e] = [e, s]; sign = -1; }
  const total = e - s + 1;
  const weeks = Math.floor(total / 7);
  let count = weeks * 5;
  for (let d = s + weeks * 7; d <= e; d++) if (!isWeekend(d)) count++;
  for (const h of holidays) if (h >= s && h <= e && !isWeekend(h)) count--;
  return sign * count;
}
