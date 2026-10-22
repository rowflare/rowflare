// Date math for calendar and timeline views. Days are YYYY-MM-DD strings computed in UTC, so no DST drift;
// only reading datetime values and building new ones uses the browser's time zone.
export type Day = string;

const MS = 86400000;
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const parseDay = (d: Day): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

export function toDay(ms: number): Day {
  const x = new Date(ms);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

export const addDays = (d: Day, n: number): Day => toDay(parseDay(d) + n * MS);
export const diffDays = (a: Day, b: Day): number => Math.round((parseDay(b) - parseDay(a)) / MS);
export const minDay = (a: Day, b: Day): Day => (a < b ? a : b);
export const maxDay = (a: Day, b: Day): Day => (a > b ? a : b);

/** Weeks start on Monday. */
export function startOfWeek(d: Day): Day {
  return addDays(d, -((new Date(parseDay(d)).getUTCDay() + 6) % 7));
}

export const startOfMonth = (d: Day): Day => d.slice(0, 8) + "01";

export function addMonths(d: Day, n: number): Day {
  const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + n, day = +d.slice(8, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toDay(Date.UTC(y, m, Math.min(day, last)));
}

export function monthGrid(d: Day): Day[][] {
  const start = startOfWeek(startOfMonth(d));
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)));
}

export const weekDays = (d: Day): Day[] => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(d), i));

export const localDay = (date: Date = new Date()): Day => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The calendar day of a stored value: date-only strings as-is, datetimes and timestamps in the browser's time zone. */
export function dayOf(v: unknown): Day | null {
  if (typeof v === "number") return Number.isFinite(v) ? localDay(new Date(v)) : null;
  if (typeof v !== "string" || !v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : localDay(new Date(t));
}

/** Minutes after local midnight for datetime values; null for date-only values. */
export function minutesOf(v: unknown): number | null {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

/** An ISO datetime for a local day and time. */
export function atMinutes(day: Day, minutes: number): string {
  return new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), Math.floor(minutes / 60), minutes % 60).toISOString();
}

/** A new stored value on `day`, keeping the time of day of a datetime value (9:00 when there was none). */
export function withDay(old: unknown, day: Day, includeTime: boolean): string {
  if (!includeTime) return day;
  return atMinutes(day, minutesOf(old) ?? 9 * 60);
}

export interface Span {
  start: Day;
  end: Day;
}

/** A record's span; a missing or earlier end means a single day. Duration counts days including the start. */
export function spanOf(start: unknown, end: unknown, durationDays?: unknown): Span | null {
  const s = dayOf(start);
  if (!s) return null;
  let e = dayOf(end);
  if (!e && typeof durationDays === "number" && durationDays >= 1) e = addDays(s, Math.floor(durationDays) - 1);
  return { start: s, end: e && e > s ? e : s };
}

export const overlaps = (s: Span, from: Day, to: Day): boolean => s.start <= to && s.end >= from;

export function clip(s: Span, from: Day, to: Day): (Span & { cutStart: boolean; cutEnd: boolean }) | null {
  if (!overlaps(s, from, to)) return null;
  return { start: maxDay(s.start, from), end: minDay(s.end, to), cutStart: s.start < from, cutEnd: s.end > to };
}

/** Greedy packing: by start (longer first on ties), each span takes the first row whose last span ended before it. */
export function packRows<T extends Span>(items: T[]): (T & { row: number })[] {
  const sorted = [...items].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : diffDays(b.start, b.end) - diffDays(a.start, a.end)));
  const ends: Day[] = [];
  return sorted.map(it => {
    let row = ends.findIndex(e => e < it.start);
    if (row < 0) {
      row = ends.length;
      ends.push(it.end);
    } else ends[row] = it.end;
    return { ...it, row };
  });
}

export type Scale = "day" | "week" | "month";
export const PX_PER_DAY: Record<Scale, number> = { day: 40, week: 16, month: 4 };
export const WINDOW_DAYS: Record<Scale, number> = { day: 90, week: 364, month: 1095 };

export const dayToX = (d: Day, origin: Day, px: number): number => diffDays(origin, d) * px;
export const xToDay = (x: number, origin: Day, px: number): Day => addDays(origin, Math.floor(x / px));

export interface Tick {
  day: Day;
  label: string;
  major: boolean;
}

/** Day scale: every day, major on Mondays. Week scale: Mondays, major at a new month. Month scale: first days, major in January. */
export function axisTicks(from: Day, to: Day, scale: Scale): Tick[] {
  const out: Tick[] = [];
  const mon = (d: Day) => MONTHS[+d.slice(5, 7) - 1];
  if (scale === "month") {
    for (let d = startOfMonth(from); d <= to; d = addMonths(d, 1)) {
      if (d < from) continue;
      const jan = d.slice(5, 7) === "01";
      out.push({ day: d, label: jan ? `${mon(d)} ${d.slice(0, 4)}` : mon(d), major: jan });
    }
    return out;
  }
  if (scale === "week") {
    let d = startOfWeek(from);
    if (d < from) d = addDays(d, 7);
    let prev = "";
    for (; d <= to; d = addDays(d, 7)) {
      const m = d.slice(0, 7);
      out.push({ day: d, label: m !== prev ? `${mon(d)} ${+d.slice(8)}` : String(+d.slice(8)), major: m !== prev });
      prev = m;
    }
    return out;
  }
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ day: d, label: String(+d.slice(8)), major: new Date(parseDay(d)).getUTCDay() === 1 });
  return out;
}

export const monthLabel = (d: Day): string => `${FULL_MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
export const dayLabel = (d: Day): string => `${WEEKDAYS[(new Date(parseDay(d)).getUTCDay() + 6) % 7]} ${+d.slice(8)}`;
export const WEEKDAY_NAMES = WEEKDAYS;
export const fmtMinutes = (m: number): string => `${Math.floor(m / 60)}:${pad(m % 60)}`;

/**
 * The window to ask the server for: one extra day on each side. The server splits datetimes into days in UTC,
 * the browser in local time, so records near midnight could otherwise fall just outside; clip() trims locally.
 */
export const queryWindow = (from: Day, to: Day): { from: Day; to: Day } => ({ from: addDays(from, -1), to: addDays(to, 1) });
