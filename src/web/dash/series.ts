// Turns aggregate results into what dashboards draw: filled time buckets, labels, chart options, pivot cells and numbers.
import type { AggFn, DateBucket, Field, Widget, WidgetMetric } from "../../shared/types";
import { isDateField, isNumberField } from "../../shared/types";
import { displayCell } from "../../shared/cells";
import { bucketDate, compareKeys, OTHER_KEY, type AggregateResult, type GroupKey } from "../../worker/base/aggregate";
import { addDays, addMonths } from "../base/dates";
import type { DayRange } from "./dateRange";

export const CHART_COLORS = ["#c4421a", "#2f6fdf", "#22863a", "#b7791f", "#7c4dff", "#0f9d9a", "#d6336c", "#5c6b7a", "#8a6d3b", "#3b5bdb"];
const EMPTY_COLOR = "#b8b2ab";
const OTHER_COLOR = "#9a948d";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_BUCKETS = 5000;

export function nextBucket(key: string, bucket: DateBucket): string {
  if (bucket === "day") return addDays(key, 1);
  if (bucket === "week") return addDays(key, 7);
  if (bucket === "month") return addMonths(key + "-01", 1).slice(0, 7);
  return String(+key + 1);
}

/** Bucket keys from one key to another inclusive, at most 5,000. */
export function bucketsBetween(fromKey: string, toKey: string, bucket: DateBucket): string[] {
  const out: string[] = [];
  for (let k = fromKey; k <= toKey && out.length < MAX_BUCKETS; k = nextBucket(k, bucket)) out.push(k);
  return out;
}

export function keyLabel(k: GroupKey, bucket?: DateBucket): string {
  if (k === null) return "(empty)";
  if (k === OTHER_KEY) return "Other";
  if (typeof k === "boolean") return k ? "Checked" : "Unchecked";
  if (bucket === "month" && /^\d{4}-\d{2}$/.test(k)) return `${MONTHS[+k.slice(5) - 1]} ${k.slice(0, 4)}`;
  if (bucket === "week") return `Week of ${k}`;
  return k;
}

function hslToHex(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${ch(h + 1 / 3)}${ch(h)}${ch(h - 1 / 3)}`;
}

/** A select option's pastel chip color as a chart color of the same hue. */
export function deepen(hex: string): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    const l = (max + min) / 2;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  // Pastel chips are fully saturated at high lightness; a mid saturation keeps the hue without neon bars.
  return hslToHex(h, Math.min(Math.max(s, 0.45), 0.62), 0.52);
}

export function colorFor(field: Field | undefined, key: GroupKey, i: number): string {
  if (key === null) return EMPTY_COLOR;
  if (key === OTHER_KEY) return OTHER_COLOR;
  const choice = field?.type === "singleSelect" || field?.type === "multiSelect" ? field.options.choices?.find(c => c.name === key) : undefined;
  return choice ? deepen(choice.color) : CHART_COLORS[i % CHART_COLORS.length];
}

export interface ChartData {
  categories: GroupKey[];
  series: { key: GroupKey; data: number[] }[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Categories (first group level) and series (second level, or one series) with zeros where a combination has no records. */
/** fill (default true): replace the categories with every date bucket in the range; only right when all groups came back in key order. */
export function chartData(res: AggregateResult, opts: { twoLevels: boolean; bucket?: DateBucket; range?: DayRange | null; fill?: boolean }): ChartData {
  const cats: GroupKey[] = [];
  const sers: GroupKey[] = [];
  const seenC = new Set<string>(), seenS = new Set<string>();
  const cell = new Map<string, number>();
  for (const g of res.groups) {
    const c = g.key[0] ?? null;
    const s = opts.twoLevels ? g.key[1] ?? null : null;
    if (!seenC.has(JSON.stringify(c))) seenC.add(JSON.stringify(c)), cats.push(c);
    if (!seenS.has(JSON.stringify(s))) seenS.add(JSON.stringify(s)), sers.push(s);
    cell.set(JSON.stringify([c, s]), num(g.values.v));
  }
  let categories = cats;
  if (opts.bucket && opts.fill !== false) {
    const dated = cats.filter((k): k is string => typeof k === "string" && k !== OTHER_KEY).sort();
    const span = opts.range ? [bucketDate(opts.range.from, opts.bucket)!, bucketDate(opts.range.to, opts.bucket)!] : dated.length ? [dated[0], dated[dated.length - 1]] : null;
    categories = span ? bucketsBetween(span[0], span[1], opts.bucket) : [];
    if (!opts.range && cats.includes(null)) categories.push(null);
  }
  return { categories, series: sers.map(s => ({ key: s, data: categories.map(c => cell.get(JSON.stringify([c, s])) ?? 0) })) };
}

/** The aggregate group key behind one clicked chart element. */
export function drillKey(d: ChartData, twoLevels: boolean, seriesIndex: number, dataIndex: number): GroupKey[] {
  const c = d.categories[dataIndex] ?? null;
  return twoLevels ? [c, d.series[seriesIndex]?.key ?? null] : [c];
}

export interface ChartTheme {
  ink: string;
  muted: string;
  line: string;
}

export interface ChartCtx {
  xField?: Field;
  seriesField?: Field;
  bucket?: DateBucket;
  seriesBucket?: DateBucket;
  label: string;
  theme: ChartTheme;
  format: (v: number) => string;
}

/** ECharts option for a bar, line or pie widget (plain data, so it can be tested without ECharts). */
export function chartOption(w: Widget, d: ChartData, ctx: ChartCtx): Record<string, unknown> {
  const labels = d.categories.map(k => keyLabel(k, ctx.bucket));
  const { ink, muted, line } = ctx.theme;
  const two = !!w.seriesFieldId;
  const horizontal = w.type === "bar" && !!w.horizontal;
  if (w.type === "pie") {
    const values = d.series[0]?.data ?? [];
    return {
      tooltip: { trigger: "item", valueFormatter: ctx.format },
      legend: { type: "scroll", bottom: 0, textStyle: { color: ink } },
      series: [
        {
          type: "pie",
          radius: w.donut ? ["45%", "70%"] : "70%",
          center: ["50%", "45%"],
          label: { color: ink },
          data: d.categories.map((k, i) => ({ name: labels[i], value: values[i], itemStyle: { color: colorFor(ctx.xField, k, i) } })),
        },
      ],
    };
  }
  // Up to 12 categories every label is shown, cut to fit, unless the chart is too narrow for them; beyond that ECharts thins them out.
  const few = labels.length <= 12;
  const cat = { type: "category", data: labels, axisLabel: { color: muted, interval: few ? 0 : "auto", hideOverlap: true, width: horizontal ? 120 : 90, overflow: "truncate" }, axisLine: { lineStyle: { color: line } } };
  const val = { type: "value", axisLabel: { color: muted, formatter: ctx.format }, splitLine: { lineStyle: { color: line } } };
  return {
    grid: { left: 8, right: 16, top: two ? 32 : 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: ctx.format },
    legend: two ? { type: "scroll", top: 0, textStyle: { color: ink } } : undefined,
    xAxis: horizontal ? val : cat,
    yAxis: horizontal ? { ...cat, inverse: true } : val,
    series: d.series.map((s, si) => {
      const color = two ? colorFor(ctx.seriesField, s.key, si) : CHART_COLORS[0];
      const single = !two && w.type === "bar";
      return {
        type: w.type,
        name: two ? keyLabel(s.key, ctx.seriesBucket) : ctx.label,
        data: single ? s.data.map((v, i) => ({ value: v, itemStyle: { color: colorFor(ctx.xField, d.categories[i], 0) } })) : s.data,
        stack: w.stacked ? "total" : undefined,
        areaStyle: w.type === "line" && w.area ? {} : undefined,
        itemStyle: single ? undefined : { color },
        lineStyle: w.type === "line" ? { color } : undefined,
      };
    }),
  };
}

export interface PivotData {
  rows: GroupKey[];
  cols: GroupKey[];
  value(r: GroupKey, c: GroupKey): number | string | null;
}

export function pivotData(res: AggregateResult, twoLevels: boolean): PivotData {
  const rows: GroupKey[] = [], cols: GroupKey[] = [];
  const seenR = new Set<string>(), seenC = new Set<string>();
  const m = new Map<string, number | string | null>();
  for (const g of res.groups) {
    const r = g.key[0] ?? null;
    const c = twoLevels ? g.key[1] ?? null : null;
    if (!seenR.has(JSON.stringify(r))) seenR.add(JSON.stringify(r)), rows.push(r);
    if (!seenC.has(JSON.stringify(c))) seenC.add(JSON.stringify(c)), cols.push(c);
    m.set(JSON.stringify([r, c]), g.values.v ?? null);
  }
  cols.sort((a, b) => compareKeys([a], [b]));
  return { rows, cols: twoLevels ? cols : [null], value: (r, c) => m.get(JSON.stringify([r, c])) ?? null };
}

const COUNTS = new Set<AggFn>(["count", "countUnique", "countEmpty", "countFilled"]);

export function formatMetric(v: number | string | null | undefined, fn: AggFn, field?: Field): string {
  if (v === null || v === undefined) return "-";
  if (COUNTS.has(fn)) return Number(v).toLocaleString("en-US");
  if (field && isDateField(field)) return String(v).slice(0, 10);
  if (typeof v !== "number") return String(v);
  const rounded = Math.round(v * 100) / 100;
  if (field && isNumberField(field) && field.options.format) return displayCell(field, rounded);
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function change(cur: number | null, prev: number | null): { pct: number | null; dir: "up" | "down" | "flat" } {
  if (cur === null || prev === null) return { pct: null, dir: "flat" };
  const dir = cur > prev ? "up" : cur < prev ? "down" : "flat";
  return { pct: prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10, dir };
}

export function metricLabel(m: WidgetMetric, field?: Field): string {
  const n = field?.name ?? "field";
  switch (m.fn) {
    case "count":
      return "Records";
    case "countUnique":
      return `Unique ${n}`;
    case "countEmpty":
      return `Empty ${n}`;
    case "countFilled":
      return `Filled ${n}`;
    case "sum":
      return `Sum of ${n}`;
    case "avg":
      return `Average ${n}`;
    case "min":
      return `Min ${n}`;
    case "max":
      return `Max ${n}`;
  }
}
