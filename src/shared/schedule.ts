// Time zone arithmetic for schedule and date triggers, with Intl only (no time zone data is bundled).
import { parseHm, type DateTrigger, type ScheduleTrigger } from "./automations";

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  /** 0 is Sunday. */
  wd: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formats.set(tz, f);
  }
  return f;
}

export function zonedParts(ms: number, tz: string): ZonedParts {
  const p = Object.fromEntries(format(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute), wd: WEEKDAYS.indexOf(p.weekday) };
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetAt(ms: number, tz: string): number {
  const z = zonedParts(ms, tz);
  return (Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm) - Math.floor(ms / 60000) * 60000) / 60000;
}

function shows(ms: number, tz: string, y: number, m: number, d: number, hh: number, mm: number): boolean {
  const z = zonedParts(ms, tz);
  return z.y === y && z.m === m && z.d === d && z.hh === hh && z.mm === mm;
}

/**
 * The instant of a local wall clock time. A time skipped by a DST change maps to the same clock time
 * after the change (02:30 on a spring-forward day becomes 03:30); a repeated time takes its first occurrence.
 */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offsetAt(wall, tz);
  let t = wall - o1 * 60000;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) {
    const t2 = wall - o2 * 60000;
    if (shows(t2, tz, y, m, d, hh, mm)) t = t2;
  }
  if (shows(t - 3_600_000, tz, y, m, d, hh, mm)) t -= 3_600_000;
  return t;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const hoursOf = (n: number) => Array.from({ length: 24 }, (_, i) => i).filter(i => i % n === 0);

/** The next run strictly after `after`. */
export function nextScheduleTime(t: ScheduleTrigger, after: number): number {
  const [h, m] = parseHm(t.at) ?? [9, 0];
  const start = zonedParts(after, t.tz);
  // Walking local days from the day of `after`; 400 days covers every monthly schedule.
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (t.every === "week" && day.getUTCDay() !== t.weekday) continue;
    if (t.every === "month" && d !== Math.min(t.monthday ?? 1, daysIn(y, mo))) continue;
    for (const hh of t.every === "hour" ? hoursOf(t.interval ?? 1) : [h]) {
      const ms = zonedToUtc(y, mo, d, hh, m, t.tz);
      if (ms > after) return ms;
    }
  }
  return after + 86_400_000;
}

/** When a date cell fires a dateReached trigger: its instant (or its day at `at`, 09:00 by default, in the trigger's zone) plus the offset. */
export function dateDue(value: unknown, t: Pick<DateTrigger, "offsetMinutes" | "at" | "tz">): number | null {
  if (typeof value !== "string") return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  let base: number;
  if (day) {
    const [h, m] = parseHm(t.at) ?? [9, 0];
    base = zonedToUtc(Number(day[1]), Number(day[2]), Number(day[3]), h, m, t.tz);
  } else {
    base = Date.parse(value);
    if (!Number.isFinite(base)) return null;
  }
  return base + t.offsetMinutes * 60000;
}

/** Days (YYYY-MM-DD) of cells that can fall due within (from, to]: a superset, so callers check dateDue exactly. */
export function dueDayWindow(from: number, to: number, offsetMinutes: number): [string, string] {
  // A zone and the `at` time move a day's instant by less than two days.
  const pad = 2 * 86_400_000;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [day(from - offsetMinutes * 60000 - pad), day(to - offsetMinutes * 60000 + pad)];
}
