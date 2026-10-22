// Grouped counts and totals over one table, computed inside the Durable Object so only the result leaves it.
// Rows are folded in batches; there is no SQL GROUP BY over the row JSON (see the no-expression-index rule in store.ts).
import type { AggFn, Attachment, DateBucket, Field, FilterSpec, LinkValue, Row } from "../../shared/types";
import { isValidTimeZone } from "../../shared/automations";
import { dayAtOffset, groupsByDay } from "../../shared/types";

export type { AggFn, DateBucket };

export interface AggMetric {
  fn: AggFn;
  fieldId?: string;
  as: string;
}

export interface AggGroupBy {
  fieldId: string;
  bucket?: DateBucket;
}

export interface AggregateInput {
  viewId?: string;
  filters?: FilterSpec;
  /** Same toolbar search as the view query, so grouped summaries match the rows shown. */
  search?: string;
  groupBy?: AggGroupBy[];
  metrics: AggMetric[];
  /** False groups multi-value cells by their whole value (grid grouping); default true counts each value. */
  fanOut?: boolean;
  /** Days (inclusive) on a date-like field, the same window rules as view ranges. */
  range?: { fieldId: string; from: string; to: string };
  /** "value" (default) orders by the first metric, largest first; "key" by group key, numbers and dates in order. */
  sort?: "value" | "key";
  /** Keep this many groups; with `other`, the rest fold into one group keyed OTHER_KEY. */
  limit?: number;
  other?: boolean;
  /** Grid grouping (fanOut false): minutes from UTC of the viewer, so values with a time group by the viewer's day like the grid's rows. */
  dayOffset?: number;
  /** Time zone for bucketing values that have a time (created time, date and time fields); UTC without it. */
  tz?: string;
}

export type GroupKey = string | boolean | null;

export interface AggregateGroup {
  key: GroupKey[];
  values: Record<string, number | string | null>;
}

export interface AggregateResult {
  groups: AggregateGroup[];
  total: number;
  truncated?: boolean;
}

export const MAX_GROUPS = 1000;
export const MAX_GROUP_BY = 2;
export const MAX_METRICS = 10;
export const OTHER_KEY = "__other__";

const isNumeric = (f: Field) => f.type === "number" || f.type === "autonumber" || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "number");
const isDateLike = (f: Field) => f.type === "date" || f.type === "createdTime" || f.type === "modifiedTime" || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "date");
const isBlank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Returns an error message, or null when the input is valid for these fields. */
export function validateAggregate(fields: Map<string, Field>, input: AggregateInput): string | null {
  if (!input.metrics?.length || input.metrics.length > MAX_METRICS) return `Ask for 1 to ${MAX_METRICS} metrics`;
  // Grid summaries (no fan-out) follow the grid's 3 group levels; fanned-out groups stay at 2 to bound the product.
  const maxLevels = input.fanOut === false ? 3 : MAX_GROUP_BY;
  if ((input.groupBy?.length ?? 0) > maxLevels) return `Group by at most ${maxLevels} fields`;
  for (const g of input.groupBy ?? []) {
    const f = fields.get(g.fieldId);
    if (!f) return `Unknown group field ${g.fieldId}`;
    if (g.bucket !== undefined && !isDateLike(f)) return `A date bucket needs a date field; "${f.name}" is ${f.type}`;
  }
  if (input.tz !== undefined && !isValidTimeZone(input.tz)) return `Unknown time zone ${String(input.tz)}`;
  if (input.dayOffset !== undefined && !(Number.isInteger(input.dayOffset) && Math.abs(input.dayOffset) <= 1440)) return "dayOffset must be whole minutes within a day";
  if (input.sort !== undefined && input.sort !== "value" && input.sort !== "key") return 'sort must be "value" or "key"';
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_GROUPS)) return `limit must be 1 to ${MAX_GROUPS}`;
  if (input.other && (input.limit === undefined || (input.groupBy?.length ?? 0) !== 1)) return "other needs a limit and exactly one group field";
  if (input.range) {
    const f = fields.get(input.range.fieldId);
    if (!f || !isDateLike(f)) return "The range field must be a date field";
  }

  const names = new Set<string>();
  for (const m of input.metrics) {
    if (names.has(m.as)) return `Duplicate metric name "${m.as}"`;
    names.add(m.as);
    if (m.fn === "count") continue;
    const f = m.fieldId ? fields.get(m.fieldId) : undefined;
    if (!f) return `Metric ${m.fn} needs a field`;
    if ((m.fn === "sum" || m.fn === "avg") && !isNumeric(f)) return `${m.fn} needs a number field; "${f.name}" is ${f.type}`;
    if ((m.fn === "min" || m.fn === "max") && !isNumeric(f) && !isDateLike(f)) return `${m.fn} needs a number or date field; "${f.name}" is ${f.type}`;
  }
  return null;
}

function toDateString(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
  if (typeof raw === "string" && raw) return raw;
  return null;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
function localDay(iso: string, tz: string): string {
  let f = dayFormats.get(tz);
  if (!f) dayFormats.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : f.format(d);
}

/** Day buckets are YYYY-MM-DD, weeks are the Monday that starts the ISO week, months YYYY-MM, years YYYY. Values with a time fall on their day in `tz` (UTC without it); plain dates are used as they are. */
export function bucketDate(raw: unknown, bucket: DateBucket = "day", tz?: string): string | null {
  const s = toDateString(raw);
  if (!s) return null;
  const day = tz && s.length > 10 ? localDay(s, tz) : s.slice(0, 10);
  if (bucket === "year") return day.slice(0, 4);
  if (bucket === "month") return day.slice(0, 7);
  if (bucket === "week") {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return day;
}

const uniq = (keys: GroupKey[]): GroupKey[] => [...new Set(keys)];

/** The groups one cell belongs to. Multi-valued cells fan out: a record counts once in each of its values. */
export function groupKeys(f: Field, raw: unknown, bucket: DateBucket | undefined, userName: (id: string) => string, tz?: string): GroupKey[] {
  if (f.type === "checkbox" || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "boolean")) return [!!raw];
  if (isDateLike(f)) return [bucketDate(raw, bucket, tz)];
  if (isBlank(raw)) return [null];
  const choice = (id: unknown) => f.options.choices?.find(c => c.id === id)?.name ?? null;
  switch (f.type) {
    case "singleSelect":
      return [choice(raw)];
    case "multiSelect":
      return uniq((raw as unknown[]).map(choice));
    case "user":
      return uniq((Array.isArray(raw) ? raw : [raw]).map(id => userName(String(id))));
    case "link":
      return uniq((raw as LinkValue[]).map(x => x.t ?? String(x.id)));
    case "attachment":
      return uniq((raw as Attachment[]).map(a => a.name));
  }
  if (Array.isArray(raw)) return uniq(raw.map(v => (isBlank(v) ? null : String(v))));
  return [String(raw)];
}

/** A cell's whole value as the text SQL json_extract yields, so grid group keys and summaries line up. */
export function rawKey(raw: unknown): GroupKey {
  if (isBlank(raw)) return null;
  if (typeof raw === "boolean") return raw ? "1" : "0";
  if (typeof raw === "object") return JSON.stringify(raw);
  return String(raw);
}

function product(lists: GroupKey[][]): GroupKey[][] {
  return lists.reduce<GroupKey[][]>((acc, list) => acc.flatMap(a => list.map(k => [...a, k])), [[]]);
}

interface MetricAcc {
  count: number;
  sum: number;
  min: number | string | null;
  max: number | string | null;
  seen: Set<string>;
}

const newAcc = (): MetricAcc => ({ count: 0, sum: 0, min: null, max: null, seen: new Set() });

function finish(a: MetricAcc, m: AggMetric): number | string | null {
  switch (m.fn) {
    case "count":
    case "countEmpty":
    case "countFilled":
      return a.count;
    case "countUnique":
      return a.seen.size;
    case "sum":
      return a.sum;
    case "avg":
      return a.count ? a.sum / a.count : null;
    case "min":
      return a.min;
    case "max":
      return a.max;
  }
}

function desc(a: number | string | null | undefined, b: number | string | null | undefined): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? 1 : -1;
}

const collator = new Intl.Collator("en", { numeric: true });

function compareKey(a: GroupKey, b: GroupKey): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) - Number(b);
  const x = Number(a), y = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return collator.compare(a, b);
}

/** Orders group keys: numbers by value, text and dates naturally, booleans false first, empty last. */
export function compareKeys(a: GroupKey[], b: GroupKey[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = compareKey(a[i] ?? null, b[i] ?? null);
    if (c) return c;
  }
  return 0;
}

function merge(into: MetricAcc, a: MetricAcc) {
  into.count += a.count;
  into.sum += a.sum;
  if (a.min !== null && (into.min === null || a.min < into.min)) into.min = a.min;
  if (a.max !== null && (into.max === null || a.max > into.max)) into.max = a.max;
}


export class Aggregator {
  private groups = new Map<string, { key: GroupKey[]; m: MetricAcc[]; single: MetricAcc[] }>();
  private total = 0;
  /** With "Other", rows in several groups (multi-value fan-out), so "Other" counts each of them once. */
  private multi: { keys: string[]; r: Row }[] = [];

  constructor(
    private fields: Map<string, Field>,
    private input: AggregateInput,
    private raw: (f: Field, r: Row) => unknown,
    private userName: (id: string) => string,
  ) {}

  /** Every group key combination a row belongs to (one, or several when multi-value cells fan out). */
  keysOf(r: Row): GroupKey[][] {
    const lists = (this.input.groupBy ?? []).map(g => {
      const f = this.fields.get(g.fieldId)!;
      const raw = this.raw(f, r);
      if (this.input.fanOut !== false) return groupKeys(f, raw, g.bucket, this.userName, this.input.tz);
      // The same keys as the grid query: a day for values with a time, "0" for unchecked and empty checkboxes.
      if (f.type === "checkbox") return [raw ? "1" : "0"];
      if (groupsByDay(f)) return [dayAtOffset(raw, this.input.dayOffset ?? 0)];
      return [rawKey(raw)];
    });
    return product(lists);
  }

  add(rows: Row[]) {
    for (const r of rows) {
      this.total++;
      const keys = this.keysOf(r);
      if (this.input.other && keys.length > 1) this.multi.push({ keys: keys.map(k => JSON.stringify(k)), r });
      for (const key of keys) {
        const k = JSON.stringify(key);
        let g = this.groups.get(k);
        if (!g) this.groups.set(k, (g = { key, m: this.input.metrics.map(newAcc), single: this.input.metrics.map(newAcc) }));
        this.input.metrics.forEach((m, i) => {
          this.addMetric(g!.m[i], m, r);
          if (keys.length === 1) this.addMetric(g!.single[i], m, r);
        });
      }
    }
  }


  private addMetric(a: MetricAcc, m: AggMetric, r: Row) {
    if (m.fn === "count") {
      a.count++;
      return;
    }
    const f = this.fields.get(m.fieldId!)!;
    const v = this.raw(f, r);
    const blank = isBlank(v) || (f.type === "checkbox" && !v);
    switch (m.fn) {
      case "countEmpty":
        if (blank) a.count++;
        return;
      case "countFilled":
        if (!blank) a.count++;
        return;
      case "countUnique":
        // The same values in another order are the same value.
        if (!blank) a.seen.add(JSON.stringify(Array.isArray(v) ? v.map(x => JSON.stringify(x)).sort() : v));
        return;
      case "sum":
      case "avg":
        if (typeof v === "number" && Number.isFinite(v)) {
          a.sum += v;
          a.count++;
        }
        return;
      case "min":
      case "max": {
        const x = isDateLike(f) ? toDateString(v) : typeof v === "number" && Number.isFinite(v) ? v : null;
        if (x === null) return;
        if (a.min === null || x < a.min) a.min = x;
        if (a.max === null || x > a.max) a.max = x;
        return;
      }
    }
  }

  result(): AggregateResult {
    if (!this.input.groupBy?.length && !this.groups.size) this.groups.set("[]", { key: [], m: this.input.metrics.map(newAcc), single: this.input.metrics.map(newAcc) });
    const metrics = this.input.metrics;
    const valuesOf = (m: MetricAcc[]) => Object.fromEntries(metrics.map((x, i) => [x.as, finish(m[i], x)]));
    const list = [...this.groups.values()].map(g => ({ key: g.key, m: g.m, single: g.single, values: valuesOf(g.m) }));
    const first = metrics[0].as;
    if (this.input.sort === "key") list.sort((x, y) => compareKeys(x.key, y.key));
    else list.sort((x, y) => desc(x.values[first], y.values[first]) || (JSON.stringify(x.key) < JSON.stringify(y.key) ? -1 : 1));
    const cap = Math.min(this.input.limit ?? MAX_GROUPS, MAX_GROUPS);
    const rest = list.slice(cap);
    const groups: AggregateGroup[] = list.slice(0, cap).map(g => ({ key: g.key, values: g.values }));
    const out: AggregateResult = { groups, total: this.total };
    if (rest.length && this.input.other) {
      // "Other" holds every record with a key outside the kept groups, each once, so its numbers match its drill list.
      const m = metrics.map(newAcc);
      for (const g of rest) g.single.forEach((a, i) => merge(m[i], a));
      const folded = new Set(rest.map(g => JSON.stringify(g.key)));
      for (const x of this.multi) if (x.keys.some(k => folded.has(k))) metrics.forEach((mm, i) => this.addMetric(m[i], mm, x.r));
      // Unique counts cannot be added up across groups without the values, so "Other" leaves them empty.
      groups.push({ key: [OTHER_KEY], values: Object.fromEntries(metrics.map((x, i) => [x.as, x.fn === "countUnique" ? null : finish(m[i], x)])) });
    } else if (rest.length) out.truncated = true;
    return out;
  }

}
