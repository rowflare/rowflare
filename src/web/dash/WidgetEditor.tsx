// Side panel that edits one widget with a live preview; Save sends only what changed.
import { useEffect, useState, type ReactNode } from "react";
import type { AggFn, DateBucket, Field, Widget, WidgetType } from "../../shared/types";
import { isDateField } from "../../shared/types";
import { WIDGET_TYPES } from "../../shared/widgets";
import { FilterEditor } from "../base/FilterEditor";
import type { BaseClient } from "../base/client";
import { Button, Icon } from "../ui";
import { toastError } from "../toast";
import type { DayRange, RangePreset } from "./dateRange";
import { FN_LABELS, fieldsForFn, groupable, widgetPatch, WIDGET_LABELS } from "./edit";
import { defaultTitle, WidgetCard } from "./WidgetCard";

const BUCKETS: DateBucket[] = ["day", "week", "month", "year"];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="dash-field">
      <span className="dash-field-label">{label}</span>
      {children}
    </label>
  );
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function WidgetEditor({ client, dashboardId, widget, range, preset, onClose }: { client: BaseClient; dashboardId: string; widget: Widget; range: DayRange | null; preset: RangePreset; onClose: () => void }) {
  // Diff against the widget as it was when the editor opened, so a save sends only this editor's changes
  // and does not undo what others changed meanwhile.
  const [opened] = useState<Widget>(widget);
  const [draft, setDraft] = useState<Widget>(widget);
  const preview = useDebounced(draft, 300);
  const set = (patch: Partial<Widget>) => setDraft(d => ({ ...d, ...patch }));
  const fields = draft.tableId ? client.fields(draft.tableId) : [];
  const groups = fields.filter(groupable);
  const dates = fields.filter(isDateField);
  const isDate = (id?: string) => !!id && dates.some(f => f.id === id);
  const save = () => {
    const patch = widgetPatch(opened, draft);
    if (!Object.keys(patch).length) return onClose();
    client.schemaOp({ op: "updateWidget", dashboardId, widgetId: widget.id, patch }).then(onClose).catch(toastError);
  };
  const fieldSelect = (value: string | undefined, onChange: (v: string | undefined) => void, options: Field[], empty?: string) => (
    <select className="input" value={value ?? ""} onChange={e => onChange(e.target.value || undefined)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {!value && empty === undefined && <option value="">Choose a field</option>}
      {options.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  );
  const bucketSelect = (fieldId: string | undefined, value: DateBucket | undefined, onChange: (b: DateBucket) => void) =>
    isDate(fieldId) && (
      <select className="input" value={value ?? "month"} onChange={e => onChange(e.target.value as DateBucket)} aria-label="Date bucket">
        {BUCKETS.map(b => <option key={b} value={b}>{`By ${b}`}</option>)}
      </select>
    );
  const fn = draft.metric?.fn ?? "count";
  const fnFields = fieldsForFn(fn, fields);
  const check = (key: "compare" | "stacked" | "horizontal" | "area" | "donut", label: string) => (
    <label className="dash-check"><input type="checkbox" checked={!!draft[key]} onChange={e => set({ [key]: e.target.checked || undefined })} /> {label}</label>
  );

  return (
    <aside className="dash-editor" role="dialog" aria-label="Edit widget">
      <div className="dash-editor-head">
        <strong>Edit widget</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div className="dash-editor-body">
        <div className="dash-editor-preview">
          <WidgetCard client={client} widget={preview} range={range} preset={preset} editable={false} preview onDrill={() => undefined} />
        </div>
        <Row label="Type">
          <select className="input" value={draft.type} onChange={e => set({ type: e.target.value as WidgetType })}>
            {WIDGET_TYPES.map(t => <option key={t} value={t}>{WIDGET_LABELS[t]}</option>)}
          </select>
        </Row>
        <Row label="Title">
          <input className="input" value={draft.title} placeholder={defaultTitle(draft, client)} onChange={e => set({ title: e.target.value })} />
        </Row>
        {draft.type === "text" ? (
          <Row label="Text (Markdown)">
            <textarea className="input" rows={12} value={draft.text ?? ""} onChange={e => set({ text: e.target.value })} />
          </Row>
        ) : (
          <>
            <Row label="Table">
              <select
                className="input"
                value={draft.tableId ?? ""}
                onChange={e => set({ tableId: e.target.value || undefined, viewId: undefined, filters: undefined, dateFieldId: undefined, metric: { fn: "count" }, xFieldId: undefined, seriesFieldId: undefined, groupFieldId: undefined, rowFieldId: undefined, colFieldId: undefined })}
              >
                {!draft.tableId && <option value="">Choose a table</option>}
                {client.schema.tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Row>
            {draft.tableId && (
              <>
                <Row label="Records">
                  <select className="input" value={draft.viewId ?? ""} onChange={e => set({ viewId: e.target.value || undefined })}>
                    <option value="">All records</option>
                    {client.viewsOf(draft.tableId).filter(v => v.type !== "form").map(v => <option key={v.id} value={v.id}>{`In view ${v.name}`}</option>)}
                  </select>
                </Row>
                <div className="dash-field">
                  <span className="dash-field-label">Filter</span>
                  <FilterEditor fields={fields} spec={draft.filters ?? { conjunction: "and", conditions: [] }} onChange={next => set({ filters: next.conditions.length ? next : undefined })} emptyText="No extra filters." />
                </div>
                <Row label="Date range applies to">{fieldSelect(draft.dateFieldId, v => set({ dateFieldId: v }), dates, "Not affected by the date range")}</Row>
                <Row label="Value">
                  <div className="dash-inline">
                    <select className="input" value={fn} onChange={e => {
                      const next = e.target.value as AggFn;
                      const ok = fieldsForFn(next, fields);
                      set({ metric: { fn: next, fieldId: next === "count" ? undefined : ok.some(f => f.id === draft.metric?.fieldId) ? draft.metric?.fieldId : ok[0]?.id } });
                    }}>
                      {(Object.keys(FN_LABELS) as AggFn[]).map(f => <option key={f} value={f}>{FN_LABELS[f]}</option>)}
                    </select>
                    {fn !== "count" && fieldSelect(draft.metric?.fieldId, v => set({ metric: { fn, fieldId: v } }), fnFields)}
                  </div>
                </Row>
                {draft.type === "metric" && check("compare", "Compare with the previous period")}
                {(draft.type === "bar" || draft.type === "line") && (
                  <>
                    <Row label={draft.type === "bar" && draft.horizontal ? "Bars" : "X axis"}>
                      <div className="dash-inline">{fieldSelect(draft.xFieldId, v => set({ xFieldId: v }), groups)}{bucketSelect(draft.xFieldId, draft.bucket, b => set({ bucket: b }))}</div>
                    </Row>
                    <Row label="Split into series by">{fieldSelect(draft.seriesFieldId, v => set({ seriesFieldId: v }), groups.filter(f => f.id !== draft.xFieldId), "No series")}</Row>
                    <Row label="Order">
                      <select className="input" value={draft.sort ?? (isDate(draft.xFieldId) ? "key" : "value")} onChange={e => set({ sort: e.target.value as "value" | "key" })}>
                        <option value="value">Largest first</option>
                        <option value="key">By label</option>
                      </select>
                    </Row>
                    {!draft.seriesFieldId && (
                      <Row label="Show at most">
                        <input className="input" type="number" min={1} max={1000} value={draft.limit ?? ""} placeholder="All groups" onChange={e => set({ limit: e.target.value ? Math.max(1, Math.min(1000, Math.round(+e.target.value))) : undefined })} />
                      </Row>
                    )}
                    {check("stacked", "Stacked")}
                    {draft.type === "bar" ? check("horizontal", "Horizontal") : check("area", "Fill area")}
                  </>
                )}
                {draft.type === "pie" && (
                  <>
                    <Row label="Slices by">
                      <div className="dash-inline">{fieldSelect(draft.groupFieldId, v => set({ groupFieldId: v }), groups)}{bucketSelect(draft.groupFieldId, draft.bucket, b => set({ bucket: b }))}</div>
                    </Row>
                    <Row label="Slices before Other">
                      <input className="input" type="number" min={1} max={1000} value={draft.limit ?? 10} onChange={e => set({ limit: e.target.value ? Math.max(1, Math.min(1000, Math.round(+e.target.value))) : undefined })} />
                    </Row>
                    {check("donut", "Donut")}
                  </>
                )}
                {draft.type === "pivot" && (
                  <>
                    <Row label="Rows">
                      <div className="dash-inline">{fieldSelect(draft.rowFieldId, v => set({ rowFieldId: v }), groups)}{bucketSelect(draft.rowFieldId, draft.rowBucket, b => set({ rowBucket: b }))}</div>
                    </Row>
                    <Row label="Columns">
                      <div className="dash-inline">{fieldSelect(draft.colFieldId, v => set({ colFieldId: v }), groups.filter(f => f.id !== draft.rowFieldId), "No columns")}{bucketSelect(draft.colFieldId, draft.colBucket, b => set({ colBucket: b }))}</div>
                    </Row>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      <div className="dash-editor-foot">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save}>Save</Button>
      </div>
    </aside>
  );
}
