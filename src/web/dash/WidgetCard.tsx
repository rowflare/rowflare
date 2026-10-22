// One dashboard widget: loads its numbers, refreshes when its table changes, and draws a number, chart, table or text.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Field, Widget } from "../../shared/types";
import { widgetProblem, widgetQuery } from "../../shared/widgets";
import type { AggregateInput, AggregateResult, GroupKey } from "../../worker/base/aggregate";
import { useBase, type BaseClient } from "../base/client";
import { Button, Icon, Spinner } from "../ui";
import { Chart } from "./Chart";
import { previousRange, type DayRange, type RangePreset } from "./dateRange";
import type { Drill } from "./DrillList";
import { renderMarkdown } from "./markdown";
import { change, chartData, chartOption, drillKey, formatMetric, keyLabel, metricLabel, pivotData, type ChartTheme } from "./series";

interface Props {
  client: BaseClient;
  widget: Widget;
  range: DayRange | null;
  preset: RangePreset;
  editable: boolean;
  preview?: boolean;
  onEdit?: () => void;
  onMenu?: (anchor: HTMLElement) => void;
  onDrill: (d: Drill) => void;
}

function theme(): ChartTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { ink: v("--ink", "#1d1b19"), muted: v("--muted", "#8a847d"), line: v("--line", "#e6e2dd") };
}

export function defaultTitle(w: Widget, client: BaseClient): string {
  if (w.type === "text") return "";
  const f = (id?: string) => (id ? client.field(id) : undefined);
  const base = w.metric ? metricLabel(w.metric, f(w.metric.fieldId)) : "New widget";
  const by = f(w.xFieldId ?? w.groupFieldId ?? w.rowFieldId);
  return by ? `${base} by ${by.name}` : base;
}

/** Re-queries when the request, the table's rows, or the table's fields and views change (not on other schema changes such as layout edits). */
function useWidgetData(client: BaseClient, tableId: string | undefined, q: AggregateInput | null, prevQ: AggregateInput | null, sourceKey: string) {
  const key = JSON.stringify([tableId, q, prevQ]);
  const [tick, setTick] = useState(0);
  const [st, setSt] = useState<{ result?: AggregateResult; prev?: AggregateResult; error?: string }>({});
  useEffect(() => {
    if (!tableId) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = client.onData(id => {
      if (id !== tableId) return;
      clearTimeout(t);
      t = setTimeout(() => setTick(x => x + 1), 1000);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [client, tableId]);
  useEffect(() => {
    if (!q || !tableId) return;
    let live = true;
    setSt(s => ({ ...s, error: undefined }));
    Promise.all([client.aggregate(tableId, q), prevQ ? client.aggregate(tableId, prevQ) : Promise.resolve(undefined)])
      .then(([result, prev]) => live && setSt({ result, prev }))
      .catch(e => live && setSt({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [key, tick, sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, retry: () => setTick(x => x + 1) };
}

export function WidgetCard({ client, widget: w, range, preset, editable, preview, onEdit, onMenu, onDrill }: Props) {
  useBase(client);
  const fields = w.tableId ? client.fields(w.tableId) : [];
  const sourceKey = JSON.stringify([fields, w.tableId ? client.viewsOf(w.tableId) : []]);
  const fmap = useMemo(() => new Map(fields.map(f => [f.id, f])), [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = widgetProblem(w, client.schema);
  const q = problem ? null : widgetQuery(w, fmap, range);
  const prevQ = !problem && w.type === "metric" && w.compare && range && preset !== "all" ? widgetQuery(w, fmap, previousRange(preset, range)) : null;
  const data = useWidgetData(client, w.tableId, q, prevQ, sourceKey);
  const title = w.title || defaultTitle(w, client);
  const field = (id?: string): Field | undefined => (id ? fmap.get(id) : undefined);
  const metricField = field(w.metric?.fieldId);
  const format = (v: number) => formatMetric(v, w.metric?.fn ?? "count", metricField);
  const drill = (key: GroupKey[], label: string) => q && w.tableId && onDrill({ tableId: w.tableId, query: q, key, title: label ? `${title}: ${label}` : title });
  const charted = w.type === "bar" || w.type === "line" || w.type === "pie";
  const rangeKey = JSON.stringify(range ?? null);
  // The widget re-renders on every client event (cursors, presence); the chart is rebuilt only when its data or settings change.
  const chart = useMemo(() => {
    if (!charted || problem || !data.result || !data.result.groups.length) return null;
    const xId = w.type === "pie" ? w.groupFieldId : w.xFieldId;
    const bucket = q?.groupBy?.[0]?.bucket;
    const two = !!w.seriesFieldId && w.type !== "pie";
    // Empty date buckets are filled only when every group came back in date order; a top N, a pie or a cut-off result is drawn as returned.
    const fill = w.type !== "pie" && q?.sort === "key" && !q.limit && !data.result.truncated;
    const cd = chartData(data.result, { twoLevels: two, bucket, range, fill });
    const option = chartOption(w, cd, { xField: field(xId), seriesField: field(w.seriesFieldId), bucket, seriesBucket: q?.groupBy?.[1]?.bucket, label: w.metric ? metricLabel(w.metric, metricField) : "", theme: theme(), format });
    return { cd, option, two, bucket };
  }, [data.result, w, rangeKey, sourceKey, charted, !!problem]); // eslint-disable-line react-hooks/exhaustive-deps

  let body: ReactNode;
  if (w.type === "text") body = <div className="widget-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(w.text ?? "") }} />;
  else if (problem)
    body = (
      <div className="widget-empty">
        <p>{problem.kind === "setup" ? "Set up this widget" : "The data source changed; pick another"}</p>
        {problem.kind === "changed" && <p className="muted small">{problem.message}</p>}
        {editable && onEdit && <Button small onClick={onEdit}>Settings</Button>}
      </div>
    );
  else if (data.error)
    body = (
      <div className="widget-empty">
        <p className="danger-text">{data.error}</p>
        <Button small onClick={data.retry}>Retry</Button>
      </div>
    );
  else if (!data.result) body = <div className="widget-empty"><Spinner /></div>;
  else if (w.type === "metric") {
    const v = data.result.groups[0]?.values.v ?? null;
    const p = data.prev?.groups[0]?.values.v ?? null;
    const ch = data.prev ? change(typeof v === "number" ? v : null, typeof p === "number" ? p : null) : null;
    body = (
      <button className="metric" onClick={() => drill([], "")} disabled={preview}>
        <span className="metric-value">{formatMetric(v, w.metric!.fn, metricField)}</span>
        {ch && (
          <span className={"metric-change " + ch.dir}>
            {ch.dir === "up" ? "▲" : ch.dir === "down" ? "▼" : ""} {ch.pct === null ? "" : `${Math.abs(ch.pct)}%`} vs previous period ({formatMetric(p, w.metric!.fn, metricField)})
          </span>
        )}
      </button>
    );
  } else if (!data.result.groups.length) body = <div className="widget-empty muted">No data</div>;
  else if (w.type === "pivot") {
    const two = !!w.colFieldId;
    const p = pivotData(data.result, two);
    body = (
      <div className="pivot-wrap">
        <table className="pivot">
          {two && (
            <thead>
              <tr><th />{p.cols.map(c => <th key={JSON.stringify(c)}>{keyLabel(c, w.colBucket)}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {p.rows.map(r => (
              <tr key={JSON.stringify(r)}>
                <th>{keyLabel(r, w.rowBucket)}</th>
                {p.cols.map(c => {
                  const v = p.value(r, c);
                  const label = two ? `${keyLabel(r, w.rowBucket)}, ${keyLabel(c, w.colBucket)}` : keyLabel(r, w.rowBucket);
                  return (
                    <td key={JSON.stringify(c)}>
                      {v === null ? "" : preview ? formatMetric(v, w.metric!.fn, metricField) : <button className="cell-link" onClick={() => drill(two ? [r, c] : [r], label)}>{formatMetric(v, w.metric!.fn, metricField)}</button>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (chart) {
    const { cd, option, two, bucket } = chart;
    body = (
      <Chart
        option={option}
        onPick={preview ? undefined : (si, di) => {
          const key = drillKey(cd, two, si, di);
          drill(key, key.map(k => keyLabel(k, bucket)).join(", "));
        }}
      />
    );
  }

  return (
    <div className="widget">
      <div className="widget-head">
        <span className="widget-title" title={title}>{title}</span>
        {editable && !preview && onMenu && (
          <button className="icon-btn widget-menu-btn" onClick={e => onMenu(e.currentTarget)} aria-label="Widget options"><Icon name="dots" size={14} /></button>
        )}
      </div>
      <div className="widget-body">{body}</div>
      {data.result?.truncated && <div className="widget-foot muted small">Showing the top {data.result.groups.length} groups</div>}
    </div>
  );
}
