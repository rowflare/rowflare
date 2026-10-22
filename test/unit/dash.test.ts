import { describe, expect, it } from "vitest";
import type { Field, Schema, Widget } from "../../src/shared/types";
import { presetRange, previousRange } from "../../src/web/dash/dateRange";
import { bucketsBetween, change, chartData, chartOption, deepen, drillKey, formatMetric, keyLabel, metricLabel, pivotData } from "../../src/web/dash/series";
import { changedPositions, layoutOf, stackOrder } from "../../src/web/dash/layout";
import { fieldsForFn, starterWidget, widgetPatch } from "../../src/web/dash/edit";
import { renderMarkdown } from "../../src/web/dash/markdown";

const fld = (id: string, name: string, type: Field["type"], options: Field["options"] = {}): Field => ({ id, tableId: "tblA", name, type, options, ord: "a" });
const stage = fld("fldStage", "Stage", "singleSelect", { choices: [{ id: "c1", name: "Won", color: "#dff5dc" }, { id: "c2", name: "Lost", color: "#ffe0e6" }] });
const amount = fld("fldAmount", "Amount", "number");
const closed = fld("fldClosed", "Closed", "date");
const w = (x: Partial<Widget>): Widget => ({ id: "wgt1", type: "bar", title: "", x: 0, y: 0, w: 6, h: 4, ...x });
const theme = { ink: "#111", muted: "#888", line: "#ddd" };
const fmt = (v: number) => String(v);

describe("date range presets", () => {
  it("computes presets from the local day", () => {
    const today = "2026-10-13";
    expect(presetRange("all", today)).toBeNull();
    expect(presetRange("week", today)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(presetRange("month", today)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("quarter", today)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(presetRange("year", today)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(presetRange("last7", today)).toEqual({ from: "2026-10-07", to: "2026-10-13" });
    expect(presetRange("last30", today)).toEqual({ from: "2026-09-14", to: "2026-10-13" });
    expect(presetRange("custom", today, { from: "2026-03-01", to: "2026-03-10" })).toEqual({ from: "2026-03-01", to: "2026-03-10" });
    expect(presetRange("custom", today, { from: "2026-03-10", to: "2026-03-01" })).toEqual({ from: "2026-03-01", to: "2026-03-10" });
    expect(presetRange("custom", today, { from: "2026-03-10", to: "" })).toBeNull();
  });

  it("handles year boundaries and leap years", () => {
    expect(presetRange("week", "2026-01-01")).toEqual({ from: "2025-12-29", to: "2026-01-04" });
    expect(presetRange("month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(presetRange("quarter", "2026-02-15")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("previous period: calendar periods for calendar presets, equal length otherwise", () => {
    expect(previousRange("week", { from: "2026-10-12", to: "2026-10-18" })).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(previousRange("month", { from: "2026-03-01", to: "2026-03-31" })).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousRange("quarter", { from: "2026-01-01", to: "2026-03-31" })).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(previousRange("year", { from: "2026-01-01", to: "2026-12-31" })).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(previousRange("custom", { from: "2026-03-01", to: "2026-03-10" })).toEqual({ from: "2026-02-19", to: "2026-02-28" });
    expect(previousRange("last7", { from: "2026-10-07", to: "2026-10-13" })).toEqual({ from: "2026-09-30", to: "2026-10-06" });
  });
});

describe("chart data", () => {
  it("fills missing time buckets with zero inside the range", () => {
    const res = { total: 3, groups: [{ key: ["2026-03"], values: { v: 2 } }, { key: ["2026-01"], values: { v: 1 } }] };
    const d = chartData(res, { twoLevels: false, bucket: "month", range: { from: "2026-01-01", to: "2026-04-30" } });
    expect(d.categories).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(d.series).toEqual([{ key: null, data: [1, 0, 2, 0] }]);
  });

  it("without a range fills between the first and last bucket and keeps empty last", () => {
    const res = { total: 3, groups: [{ key: ["2026-01-12"], values: { v: 1 } }, { key: [null], values: { v: 4 } }, { key: ["2026-01-26"], values: { v: 2 } }] };
    const d = chartData(res, { twoLevels: false, bucket: "week" });
    expect(d.categories).toEqual(["2026-01-12", "2026-01-19", "2026-01-26", null]);
    expect(d.series[0].data).toEqual([1, 0, 2, 4]);
  });

  it("caps bucket filling so years of days cannot hang the page", () => {
    expect(bucketsBetween("2000-01-01", "2030-01-01", "day")).toHaveLength(5000);
    expect(bucketsBetween("2026-11", "2027-02", "month")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(bucketsBetween("2026", "2028", "year")).toEqual(["2026", "2027", "2028"]);
  });

  it("fix: without fill, kept groups stay as returned (top N, pie Other)", () => {
    const res = { total: 9, groups: [{ key: ["2026-05"], values: { v: 5 } }, { key: ["2026-02"], values: { v: 3 } }, { key: ["__other__"], values: { v: 1 } }] };
    const d = chartData(res, { twoLevels: false, bucket: "month", range: { from: "2026-01-01", to: "2026-12-31" }, fill: false });
    expect(d.categories).toEqual(["2026-05", "2026-02", "__other__"]);
    expect(d.series[0].data).toEqual([5, 3, 1]);
  });

  it("two levels become one series per second key, in order of appearance", () => {
    const res = { total: 5, groups: [{ key: ["Q1", "Won"], values: { v: 3 } }, { key: ["Q2", "Lost"], values: { v: 1 } }, { key: ["Q1", "Lost"], values: { v: 1 } }] };
    const d = chartData(res, { twoLevels: true });
    expect(d.categories).toEqual(["Q1", "Q2"]);
    expect(d.series).toEqual([{ key: "Won", data: [3, 0] }, { key: "Lost", data: [1, 1] }]);
    expect(drillKey(d, true, 1, 0)).toEqual(["Q1", "Lost"]);
    expect(drillKey(d, false, 0, 1)).toEqual(["Q2"]);
  });

  it("labels keys", () => {
    expect(keyLabel(null)).toBe("(empty)");
    expect(keyLabel("__other__")).toBe("Other");
    expect(keyLabel(true)).toBe("Checked");
    expect(keyLabel("2026-03", "month")).toBe("Mar 2026");
    expect(keyLabel("2026-01-12", "week")).toBe("Week of 2026-01-12");
    expect(keyLabel("Won")).toBe("Won");
  });

  it("deepens pastel option colors keeping the hue", () => {
    const c = deepen("#d6ecff");
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    const [r, , b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r);
  });
});

describe("chart options", () => {
  const data = { categories: ["Won", "Lost"], series: [{ key: null, data: [3, 1] }] };
  it("horizontal bars swap the axes and color bars by select option", () => {
    const o = chartOption(w({ horizontal: true }), data, { xField: stage, label: "Count", theme, format: fmt }) as any;
    expect(o.xAxis.type).toBe("value");
    expect(o.yAxis).toMatchObject({ type: "category", data: ["Won", "Lost"], inverse: true });
    expect(o.series[0].data[0]).toEqual({ value: 3, itemStyle: { color: deepen("#dff5dc") } });
  });

  it("category axes show every label up to 12 categories, truncating long ones", () => {
    const six = { categories: ["Negotiation", "Qualified", "Lead", "Proposal", "Won", "Lost"], series: [{ key: null, data: [1, 2, 3, 4, 5, 6] }] };
    const o = chartOption(w({}), six, { xField: stage, label: "Count", theme, format: fmt }) as any;
    expect(o.xAxis.axisLabel).toMatchObject({ interval: 0, overflow: "truncate", hideOverlap: true });
    const many = { categories: Array.from({ length: 30 }, (_, i) => String(i)), series: [{ key: null, data: Array(30).fill(1) }] };
    expect((chartOption(w({}), many, { label: "Count", theme, format: fmt }) as any).xAxis.axisLabel.interval).toBe("auto");
  });

  it("option colors stay readable: deepened but not neon", () => {
    const c = deepen("#ffe0e6");
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(180);
  });

  it("stacked series, area lines and donuts", () => {
    const two = { categories: ["Q1"], series: [{ key: "Won", data: [3] }, { key: "Lost", data: [1] }] };
    const bar = chartOption(w({ stacked: true, seriesFieldId: "fldStage" }), two, { seriesField: stage, label: "Count", theme, format: fmt }) as any;
    expect(bar.series.map((s: any) => [s.name, s.stack])).toEqual([["Won", "total"], ["Lost", "total"]]);
    expect(bar.legend).toBeDefined();
    const line = chartOption(w({ type: "line", area: true }), data, { label: "Count", theme, format: fmt }) as any;
    expect(line.series[0]).toMatchObject({ type: "line", areaStyle: {}, data: [3, 1] });
    const pie = chartOption(w({ type: "pie", donut: true }), data, { xField: stage, label: "Count", theme, format: fmt }) as any;
    expect(pie.series[0].radius).toEqual(["45%", "70%"]);
    expect(pie.series[0].data[1]).toMatchObject({ name: "Lost", value: 1 });
  });
});

describe("pivot, numbers and labels", () => {
  it("pivot rows keep server order and columns sort by key", () => {
    const p = pivotData({ total: 3, groups: [{ key: ["A", "2026"], values: { v: 1 } }, { key: ["A", "2025"], values: { v: 2 } }, { key: ["B", null], values: { v: 3 } }] }, true);
    expect(p.rows).toEqual(["A", "B"]);
    expect(p.cols).toEqual(["2025", "2026", null]);
    expect([p.value("A", "2025"), p.value("B", null), p.value("B", "2026")]).toEqual([2, 3, null]);
    const one = pivotData({ total: 1, groups: [{ key: ["A"], values: { v: 5 } }] }, false);
    expect([one.cols, one.value("A", null)]).toEqual([[null], 5]);
  });

  it("formats metric values and changes", () => {
    expect(formatMetric(1234, "count")).toBe("1,234");
    expect(formatMetric(null, "sum", amount)).toBe("-");
    expect(formatMetric("2026-01-05T10:00:00.000Z", "min", closed)).toBe("2026-01-05");
    expect(formatMetric(10 / 3, "avg")).toBe("3.33");
    expect(change(120, 100)).toEqual({ pct: 20, dir: "up" });
    expect(change(50, 100)).toEqual({ pct: -50, dir: "down" });
    expect(change(5, 0)).toEqual({ pct: null, dir: "up" });
    expect(change(null, 3)).toEqual({ pct: null, dir: "flat" });
    expect(metricLabel({ fn: "count" })).toBe("Records");
    expect(metricLabel({ fn: "sum", fieldId: "fldAmount" }, amount)).toBe("Sum of Amount");
  });
});

describe("layout and editing", () => {
  const ws = [w({ id: "b", x: 6, y: 0 }), w({ id: "a", x: 0, y: 0 }), w({ id: "c", type: "text", x: 0, y: 4, h: 1 })];
  it("stacks widgets in reading order for phones", () => {
    expect(stackOrder(ws).map(x => x.id)).toEqual(["a", "b", "c"]);
  });
  it("builds grid items and finds moved widgets", () => {
    expect(layoutOf(ws)[2]).toEqual({ i: "c", x: 0, y: 4, w: 6, h: 1, minW: 2, minH: 1 });
    expect(layoutOf(ws)[0].minH).toBe(2);
    const moved = layoutOf(ws).map(l => (l.i === "a" ? { ...l, y: 4 } : l.i === "c" ? { ...l, y: 8 } : l));
    expect(changedPositions(ws, moved)).toEqual([{ id: "a", x: 0, y: 4, w: 6, h: 4 }, { id: "c", x: 0, y: 8, w: 6, h: 1 }]);
  });
  it("fix: editor patches never carry positions, so a save cannot undo another editor's move", () => {
    expect(widgetPatch(w({ x: 0, title: "A" }), w({ x: 6, y: 3, title: "B" }))).toEqual({ title: "B" });
  });
  it("diffs widgets into patches with null for removed settings", () => {
    expect(widgetPatch(w({ limit: 5, title: "A" }), w({ title: "B", stacked: true }))).toEqual({ limit: null, title: "B", stacked: true });
    expect(widgetPatch(w({}), w({}))).toEqual({});
  });
  it("offers fields that fit the metric", () => {
    const fields = [fld("fldName", "Name", "text"), amount, closed];
    expect(fieldsForFn("sum", fields).map(f => f.name)).toEqual(["Amount"]);
    expect(fieldsForFn("max", fields).map(f => f.name)).toEqual(["Amount", "Closed"]);
    expect(fieldsForFn("countFilled", fields)).toHaveLength(3);
    expect(fieldsForFn("count", fields)).toEqual([]);
  });
  it("starts new widgets on the first table with useful defaults", () => {
    const schema = { tables: [{ id: "tblA", name: "Deals", ord: "a", primaryFieldId: "fldName" }], fields: [fld("fldName", "Name", "text"), stage, closed], views: [], dashboards: [], baseId: "b", version: 1, jobs: [] } as Schema;
    expect(starterWidget("bar", schema)).toEqual({ type: "bar", tableId: "tblA", metric: { fn: "count" }, xFieldId: "fldStage" });
    expect(starterWidget("pie", schema)).toMatchObject({ groupFieldId: "fldStage" });
    expect(starterWidget("pivot", schema)).toMatchObject({ rowFieldId: "fldStage" });
    expect(starterWidget("text", schema)).toEqual({ type: "text", text: "## Title\n\nWrite notes in Markdown." });
  });
});

describe("markdown", () => {
  it("renders Markdown and neutralizes HTML and script links", () => {
    expect(renderMarkdown("# Hi\n\n**bold**")).toContain("<strong>bold</strong>");
    const evil = renderMarkdown('<img src=x onerror=alert(1)> and <script>alert(1)</script>\n\n[x](javascript:alert(1)) [ok](https://example.com)');
    expect(evil).not.toMatch(/<img|<script/);
    expect(evil).not.toContain('href="javascript');
    expect(evil).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>');
  });

  it("escapes link titles and image text once", () => {
    const html = renderMarkdown('[A & B](https://x.test "Tom & \\"Jerry\\" <b>") ![a & <b>](https://x.test/i.png)');
    expect(html).toContain('title="Tom &amp; &quot;Jerry&quot; &lt;b&gt;">A &amp; B</a>');
    expect(html).toContain("a &amp; &lt;b&gt;");
    expect(html).not.toContain("&amp;amp;");
    expect(html).not.toMatch(/<b>|<img/);
  });
});
