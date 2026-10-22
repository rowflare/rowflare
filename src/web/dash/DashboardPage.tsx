// A dashboard: date range, layout editing, widgets on a 12-column grid, the widget editor and drill-down.
import { useEffect, useMemo, useState } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { Dashboard, Widget, WidgetType } from "../../shared/types";
import { WIDGET_TYPES } from "../../shared/widgets";
import { useBase, type BaseClient } from "../base/client";
import { localDay } from "../base/dates";
import { Button, Menu, type MenuItem } from "../ui";
import { toastError } from "../toast";
import { PRESET_LABELS, presetRange, type DayRange, type RangePreset } from "./dateRange";
import { DrillList, type Drill } from "./DrillList";
import { starterWidget, WIDGET_LABELS } from "./edit";
import { changedPositions, layoutOf, MOBILE_BREAK, ROW_H, stackOrder, type GridItem } from "./layout";
import { WidgetCard } from "./WidgetCard";
import { WidgetEditor } from "./WidgetEditor";
import "./dash.css";

interface RangeState {
  preset: RangePreset;
  custom?: DayRange;
}

const rangeKey = (id: string) => "rf-dash-range:" + id;

function loadRange(id: string): RangeState {
  try {
    const v = JSON.parse(localStorage.getItem(rangeKey(id)) ?? "null");
    if (v && typeof v.preset === "string" && v.preset in PRESET_LABELS) return v;
  } catch {
    // Storage can be unavailable (private mode); fall back to all time.
  }
  return { preset: "all" };
}

function saveRange(id: string, r: RangeState) {
  try {
    localStorage.setItem(rangeKey(id), JSON.stringify(r));
  } catch {
    // Not saved; the range still applies for this visit.
  }
}

export default function DashboardPage({ client, dashboard, onExpand }: { client: BaseClient; dashboard: Dashboard; onExpand: (tableId: string, rowId: number) => void }) {
  useBase(client);
  const [rangeState, setRangeState] = useState(() => loadRange(dashboard.id));
  const range = useMemo(() => presetRange(rangeState.preset, localDay(), rangeState.custom), [rangeState]);
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: (MenuItem | "sep")[] } | null>(null);
  const [local, setLocal] = useState<GridItem[] | null>(null);
  const { width, containerRef, mounted } = useContainerWidth();
  const mobile = width > 0 && width < MOBILE_BREAK;
  const widgets = dashboard.widgets;
  useEffect(() => setLocal(null), [widgets]);
  useEffect(() => {
    if (mobile) setEditing(false);
  }, [mobile]);

  const setRange = (r: RangeState) => {
    setRangeState(r);
    saveRange(dashboard.id, r);
  };
  const run = (op: Parameters<BaseClient["schemaOp"]>[0]) => client.schemaOp(op);
  const add = (type: WidgetType) =>
    run({ op: "addWidget", dashboardId: dashboard.id, widget: starterWidget(type, client.schema) })
      .then(r => r.id && setEditor(r.id))
      .catch(toastError);
  const saveLayout = (layout: readonly GridItem[]) => {
    const items = changedPositions(widgets, layout);
    if (items.length) run({ op: "setLayout", dashboardId: dashboard.id, items }).catch(e => (setLocal(null), toastError(e)));
  };
  const widgetMenu = (anchor: HTMLElement, w: Widget) =>
    setMenu({
      anchor,
      items: [
        { label: "Edit", icon: "edit", onClick: () => setEditor(w.id) },
        {
          label: "Duplicate",
          icon: "copy",
          onClick: () => {
            const { id: _id, x: _x, y: _y, ...rest } = w;
            run({ op: "addWidget", dashboardId: dashboard.id, widget: rest }).catch(toastError);
          },
        },
        "sep",
        {
          label: "Delete",
          icon: "trash",
          danger: true,
          onClick: () => {
            if (window.confirm("Delete this widget?")) run({ op: "removeWidget", dashboardId: dashboard.id, widgetId: w.id }).catch(toastError);
          },
        },
      ],
    });
  const addMenu = (anchor: HTMLElement) => setMenu({ anchor, items: WIDGET_TYPES.map(t => ({ label: WIDGET_LABELS[t], onClick: () => add(t) })) });

  const card = (w: Widget) => (
    <WidgetCard client={client} widget={w} range={range} preset={rangeState.preset} editable={client.writable && !mobile} onEdit={() => setEditor(w.id)} onMenu={a => widgetMenu(a, w)} onDrill={setDrill} />
  );
  const editingWidget = editor ? widgets.find(w => w.id === editor) : undefined;

  return (
    <div className="dash-page">
      <div className="dash-bar">
        <h2 className="dash-title">{dashboard.name}</h2>
        <div className="grow" />
        <select className="input dash-range" value={rangeState.preset} onChange={e => setRange({ ...rangeState, preset: e.target.value as RangePreset })} aria-label="Date range">
          {(Object.keys(PRESET_LABELS) as RangePreset[]).map(p => <option key={p} value={p}>{PRESET_LABELS[p]}</option>)}
        </select>
        {rangeState.preset === "custom" && (
          <>
            <input className="input" type="date" aria-label="From" value={rangeState.custom?.from ?? ""} onChange={e => setRange({ ...rangeState, custom: { from: e.target.value, to: rangeState.custom?.to ?? e.target.value } })} />
            <input className="input" type="date" aria-label="To" value={rangeState.custom?.to ?? ""} onChange={e => setRange({ ...rangeState, custom: { from: rangeState.custom?.from ?? e.target.value, to: e.target.value } })} />
          </>
        )}
        {client.writable && !mobile && widgets.length > 0 && (
          <Button small variant={editing ? "primary" : "default"} icon={editing ? undefined : "edit"} onClick={() => setEditing(x => !x)}>{editing ? "Done" : "Edit layout"}</Button>
        )}
        {client.writable && !mobile && <Button small icon="plus" onClick={e => addMenu(e.currentTarget)}>Add widget</Button>}
      </div>
      <div className={"dash-canvas" + (editing ? " editing" : "")} ref={containerRef as React.RefObject<HTMLDivElement>}>
        {widgets.length === 0 && (
          <div className="dash-empty">
            <p className="muted">This dashboard has no widgets yet.</p>
            {client.writable && !mobile && <Button variant="primary" icon="plus" onClick={e => addMenu(e.currentTarget)}>Add widget</Button>}
          </div>
        )}
        {mounted && widgets.length > 0 && (mobile ? (
          <div className="dash-stack">
            {stackOrder(widgets).map(w => <div key={w.id} className="dash-stack-item" style={{ height: Math.max(2, w.h) * ROW_H }}>{card(w)}</div>)}
          </div>
        ) : (
          <ReactGridLayout
            layout={local ?? layoutOf(widgets)}
            width={width}
            gridConfig={{ cols: 12, rowHeight: ROW_H, margin: [12, 12] }}
            dragConfig={{ enabled: editing, cancel: ".widget-menu-btn" }}
            resizeConfig={{ enabled: editing }}
            onLayoutChange={l => editing && setLocal([...l] as GridItem[])}
            onDragStop={l => saveLayout(l as readonly GridItem[])}
            onResizeStop={l => saveLayout(l as readonly GridItem[])}
          >
            {widgets.map(w => <div key={w.id}>{card(w)}</div>)}
          </ReactGridLayout>
        ))}
      </div>
      {editingWidget && <WidgetEditor key={editingWidget.id} client={client} dashboardId={dashboard.id} widget={editingWidget} range={range} preset={rangeState.preset} onClose={() => setEditor(null)} />}
      {drill && <DrillList client={client} drill={drill} onClose={() => setDrill(null)} onOpen={onExpand} />}
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
