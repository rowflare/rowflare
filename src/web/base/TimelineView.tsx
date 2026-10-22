// Timeline view: bars from a start date and an end date (or a duration) on a scrollable time axis, in lanes.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Cells, Field, Row, View } from "../../shared/types";
import { COMPUTED_TYPES, isNumberField } from "../../shared/types";
import { Button, Empty, Icon, Popover, Spinner } from "../ui";
import { type BaseClient, primaryText, useBase } from "./client";
import { isEmpty, valueOf } from "./cards";
import { DateSetup, dateFields } from "./DateSetup";
import { laneKeys, lanesFor, NONE } from "./lanes";
import { PX_PER_DAY, WINDOW_DAYS, addDays, queryWindow, axisTicks, clip, dayToX, diffDays, localDay, monthLabel, packRows, spanOf, withDay, xToDay, type Day, type Scale, type Span } from "./dates";
import "./views.css";

const ROW_H = 30;
const LEFT_W = 200;

interface Bar extends Span {
  id: number;
  title: string;
  lane: string;
}

interface Drag {
  id: number;
  lane: string;
  mode: "move" | "start" | "end" | "place";
  x0: number;
  dx: number;
  overLane: string;
}

interface Props {
  client: BaseClient;
  view: View;
  search: string;
  onExpand: (rowId: number) => void;
}

const LANE_TYPES = new Set(["singleSelect", "user", "link"]);

export default function TimelineView(props: Props) {
  useBase(props.client);
  const view = props.client.view(props.view.id) ?? props.view;
  const options = dateFields(props.client, view.tableId);
  const start = options.find(f => f.id === view.config.dateFieldId);
  if (!start) return <DateSetup client={props.client} view={view} icon="timeline" title="Plan records on a timeline" text="Choose the date field where each bar starts." />;
  return <TimelineBody {...props} view={view} start={start} options={options} />;
}

function TimelineBody({ client, view, search, onExpand, start, options }: Props & { start: Field; options: Field[] }) {
  const tableId = view.tableId;
  const cfg = view.config;
  const all = client.fields(tableId);
  const end = options.find(f => f.id === cfg.endDateFieldId && f.id !== start.id);
  const dur = end ? undefined : all.find(f => f.id === cfg.durationFieldId && isNumberField(f));
  const laneField = all.find(f => f.id === cfg.laneFieldId && LANE_TYPES.has(f.type));
  const scale: Scale = cfg.timelineScale ?? "week";
  const px = PX_PER_DAY[scale];
  const [viewW, setViewW] = useState(1200);
  // The loaded window spans at least three screens, so scrolling near one edge never puts the other edge in view too.
  const span = Math.max(WINDOW_DAYS[scale], Math.ceil((viewW * 3) / px));
  const [center, setCenter] = useState<Day>(() => localDay());
  const [jump, setJump] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<HTMLElement | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const shift = useRef(0);
  const from = addDays(center, -Math.floor(span / 2));
  const to = addDays(from, span - 1);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  useEffect(() => {
    const w = queryWindow(from, to);
    client.setViewRange(view.id, w.from, w.to, search);
  }, [client, view.id, from, to, search]);

  // The scroller is not on screen while a load error shows; it is measured and placed again after Retry.
  const failed = !!client.viewState(view.id)?.error;

  // Put today a third of the way in when the view opens, the scale changes or Today is clicked.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, dayToX(localDay(), from, px) - el.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, jump, failed]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [failed]);

  // After the window moved, keep the same dates under the viewport.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && shift.current) {
      el.scrollLeft += shift.current;
      shift.current = 0;
    }
  }, [from]);

  const st = client.viewState(view.id);
  const ids = st?.ids ?? [];
  useEffect(() => {
    client.ensureRows(tableId, ids);
  });

  const editable = client.writable && !COMPUTED_TYPES.has(start.type) && (!end || !COMPUTED_TYPES.has(end.type));
  // The end handle needs somewhere to write: an end date, or a duration that is not computed.
  const endEditable = !!end || (!!dur && !COMPUTED_TYPES.has(dur.type));
  const rows = ids.map(id => client.row(tableId, id)).filter((r): r is Row => !!r);
  const unscheduled = client.unscheduledIds(view.id).map(id => client.row(tableId, id)).filter((r): r is Row => !!r);
  const lanes = lanesFor(laneField, [...rows, ...unscheduled], client.members);
  const bars: Bar[] = [];
  for (const r of rows) {
    const s = spanOf(valueOf(start, r), end ? valueOf(end, r) : undefined, dur ? valueOf(dur, r) : undefined);
    if (!s) continue;
    const title = primaryText(client, tableId, r) || "Unnamed record";
    for (const lane of laneKeys(laneField, r, lanes)) bars.push({ id: r.id, title, lane, ...s });
  }

  const preview = (b: Bar): Span => {
    if (!drag || drag.id !== b.id || drag.lane !== b.lane || drag.mode === "place") return b;
    const days = Math.round(drag.dx / px);
    if (drag.mode === "move") return { start: addDays(b.start, days), end: addDays(b.end, days) };
    if (drag.mode === "start") {
      const s = addDays(b.start, days);
      return { start: s <= b.end ? s : b.end, end: b.end };
    }
    const e = addDays(b.end, days);
    return { start: b.start, end: e >= b.start ? e : b.start };
  };

  const write = (id: number, next: Span, extra: Cells = {}) => {
    const row = client.row(tableId, id);
    if (!row) return;
    const cells: Cells = { ...extra, [start.id]: withDay(valueOf(start, row), next.start, !!start.options.includeTime) };
    if (end) {
      if (!isEmpty(valueOf(end, row)) || next.end !== next.start) cells[end.id] = withDay(valueOf(end, row), next.end, !!end.options.includeTime);
    } else if (dur && !COMPUTED_TYPES.has(dur.type)) cells[dur.id] = diffDays(next.start, next.end) + 1;
    // Records placed from the unscheduled row are not in this view's ids yet; own writes are not echoed back.
    void client.updateCells(tableId, [{ id, cells }], { label: "Reschedule" }).then(() => {
      if (!ids.includes(id)) void client.queryView(view.id, search);
    });
  };

  /** Cells that move a record from one lane to another; null when the lane field cannot be reassigned. */
  const laneCells = (row: Row, fromLane: string, toLane: string): Cells | null => {
    if (!laneField || fromLane === toLane) return null;
    if (laneField.type === "singleSelect" || (laneField.type === "user" && !laneField.options.multiple)) return { [laneField.id]: toLane === NONE ? null : toLane };
    if (laneField.type === "user") {
      const cur = ((valueOf(laneField, row) as string[] | undefined) ?? []).filter(x => x !== fromLane);
      return { [laneField.id]: toLane === NONE ? cur : [...new Set([...cur, toLane])] };
    }
    return null; // link lanes do not reassign
  };

  /** Enter or Space opens a record, the same as a click. */
  const openKey = (e: React.KeyboardEvent, id: number) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onExpand(id);
  };

  const begin = (e: React.PointerEvent, id: number, lane: string, mode: Drag["mode"]) => {
    if (!editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag({ id, lane, mode, x0: e.clientX, dx: 0, overLane: lane });
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-lane]");
      const next = { ...d, dx: e.clientX - d.x0, overLane: el?.getAttribute("data-lane") ?? d.overLane };
      dragRef.current = next;
      // Bars move in whole days; render only when the day or the lane under the pointer changes.
      if (Math.round(next.dx / px) !== Math.round(d.dx / px) || next.overLane !== d.overLane) setDragState(next);
    };
    const cancel = () => setDrag(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      const row = client.row(tableId, d.id);
      if (!row) return;
      const lc = laneCells(row, d.lane, d.overLane);
      if (d.mode === "place") {
        const el = scroller.current;
        if (!el) return;
        const x = e.clientX - el.getBoundingClientRect().left + el.scrollLeft - LEFT_W;
        if (x < 0) return;
        const day = xToDay(x, from, px);
        return write(d.id, { start: day, end: day }, lc ?? {});
      }
      const moved = Math.abs(e.clientX - d.x0) > 3 || d.overLane !== d.lane;
      if (!moved) {
        if (d.mode === "move") onExpand(d.id);
        return;
      }
      const b = bars.find(x => x.id === d.id && x.lane === d.lane);
      if (!b) return;
      const next = preview(b);
      const laneChange = d.mode === "move" ? lc : null;
      if (next.start === b.start && next.end === b.end && !laneChange) return;
      write(d.id, next, laneChange ?? {});
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el || shift.current) return;
    const width = span * px;
    const edge = width * 0.15;
    const left = el.scrollLeft;
    const nearStart = left < edge;
    const nearEnd = left + el.clientWidth - LEFT_W > width - edge;
    if (nearStart === nearEnd) return;
    const days = Math.round(span / 3) * (nearStart ? -1 : 1);
    shift.current = -days * px;
    setCenter(c => addDays(c, days));
  };

  const toggleLane = (key: string) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const today = localDay();
  const ticks = axisTicks(from, to, scale);
  const width = span * px;
  const ro = !client.writable;
  const fieldSelect = (label: string, value: string, list: Field[], onChange: (v: string) => void, none?: string, disabled = false) => (
    <>
      <label className="field-label">{label}</label>
      <select className="input" disabled={ro || disabled} value={value} onChange={e => onChange(e.target.value)}>
        {none !== undefined && <option value="">{none}</option>}
        {list.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </>
  );

  return (
    <div className="tl">
      <div className="kb-toolbar cal-toolbar">
        <div className="cal-nav">
          <Button small onClick={() => { shift.current = 0; setCenter(localDay()); setJump(j => j + 1); }}>Today</Button>
          <strong className="cal-title-text">{monthLabel(center)}</strong>
          {st?.loading && <Spinner size={14} />}
        </div>
        <div className="cal-nav">
          <div className="seg">
            {(["day", "week", "month"] as const).map(s => (
              <button key={s} className={"seg-btn" + (scale === s ? " active" : "")} onClick={() => { setCenter(localDay()); client.updateViewConfig(view.id, { timelineScale: s }); }}>{s[0]!.toUpperCase() + s.slice(1)}</button>
            ))}
          </div>
          <button className={"btn btn-sm btn-ghost" + (settings ? " active" : "")} onClick={e => setSettings(settings ? null : e.currentTarget)}><Icon name="settings" size={14} /> Settings</button>
        </div>
        {settings && (
          <Popover anchor={settings} onClose={() => setSettings(null)} width={280} align="end" className="kb-settings">
            {fieldSelect("Start date", start.id, options, v => client.updateViewConfig(view.id, { dateFieldId: v }))}
            {fieldSelect("End date", end?.id ?? "", options.filter(f => f.id !== start.id), v => client.updateViewConfig(view.id, { endDateFieldId: v || undefined }), "None")}
            {fieldSelect("Duration in days (without an end date)", dur?.id ?? "", all.filter(isNumberField), v => client.updateViewConfig(view.id, { durationFieldId: v || undefined }), "None", !!end)}
            {fieldSelect("Lanes", laneField?.id ?? "", all.filter(f => LANE_TYPES.has(f.type)), v => client.updateViewConfig(view.id, { laneFieldId: v || undefined }), "No lanes")}
          </Popover>
        )}
      </div>
      {st?.error ? (
        <Empty title="Could not load records">
          <div className="muted">{st.error}</div>
          <Button small onClick={() => client.queryView(view.id, search)}>Retry</Button>
        </Empty>
      ) : (
        <div className={"tl-scroll" + (drag ? " dragging" : "")} ref={scroller} onScroll={onScroll}>
          <div className="tl-canvas" style={{ width: LEFT_W + width }}>
            <div className="tl-axis">
              <div className="tl-corner">{laneField ? laneField.name : "Records"}</div>
              {ticks.map(t => <div key={t.day} className={"tl-tick" + (t.major ? " major" : "")} style={{ left: LEFT_W + dayToX(t.day, from, px) }}>{t.label}</div>)}
            </div>
            {lanes.map(l => {
              const laneBars = bars.filter(b => b.lane === l.key);
              const laneUn = unscheduled.filter(r => laneKeys(laneField, r, lanes).includes(l.key));
              if (l.key === NONE && !laneBars.length && !laneUn.length) return null;
              const packed = packRows(laneBars.flatMap(b => {
                const seg = clip(preview(b), from, to);
                return seg ? [{ ...seg, id: b.id, title: b.title }] : [];
              }));
              const rowsN = Math.max(1, ...packed.map(p => p.row + 1));
              const open = !collapsed.has(l.key);
              return (
                <section key={l.key} className={"tl-lane" + (drag && drag.overLane === l.key && drag.lane !== l.key ? " over" : "")} data-lane={l.key}>
                  <div className="tl-lane-head">
                    <button className="tl-lane-name" onClick={() => toggleLane(l.key)}>
                      <Icon name="chevron" size={14} className={open ? "" : "tl-closed"} />
                      {l.color && <span className="tl-dot" style={{ background: l.color }} />}
                      <span className="grow">{l.name}</span>
                      <span className="kb-count">{laneBars.length}</span>
                    </button>
                  </div>
                  {open && (
                    <div className="tl-lane-body" style={{ height: rowsN * ROW_H + (laneUn.length ? ROW_H : 0) + 6 }}>
                      <div className="tl-gutter" />
                      {today >= from && today <= to && <div className="tl-today" style={{ left: LEFT_W + dayToX(today, from, px) + px / 2 }} />}
                      {packed.map(p => {
                        const w = (diffDays(p.start, p.end) + 1) * px - 2;
                        return (
                          <div
                            key={p.id}
                            className={"tl-bar" + (drag?.id === p.id && drag.lane === l.key ? " dragging" : "") + (p.cutStart ? " cut-start" : "") + (p.cutEnd ? " cut-end" : "")}
                            style={{ left: LEFT_W + dayToX(p.start, from, px), width: Math.max(w, 6), top: 3 + p.row * ROW_H, background: l.color }}
                            title={p.title}
                            data-id={p.id}
                            role="button" tabIndex={0} onKeyDown={e => openKey(e, p.id)}
                            onPointerDown={e => begin(e, p.id, l.key, "move")}
                            onClick={() => !editable && onExpand(p.id)}
                          >
                            {editable && !p.cutStart && <span className="tl-handle start" onPointerDown={e => begin(e, p.id, l.key, "start")} />}
                            <span className={"tl-label" + (w < 80 ? " outside" : "")}>{p.title}</span>
                            {editable && !p.cutEnd && endEditable && <span className="tl-handle end" onPointerDown={e => begin(e, p.id, l.key, "end")} />}
                          </div>
                        );
                      })}
                      {laneUn.length > 0 && (
                        <div className="tl-unscheduled" style={{ top: 3 + rowsN * ROW_H }}>
                          <div className="tl-unscheduled-inner">
                            <span className="muted small">Unscheduled</span>
                            {laneUn.slice(0, 20).map(r => (
                              <span key={r.id} className="tl-chip" role="button" tabIndex={0} onKeyDown={e => openKey(e, r.id)} onPointerDown={e => begin(e, r.id, l.key, "place")} onClick={() => !editable && onExpand(r.id)}>{primaryText(client, tableId, r) || "Unnamed record"}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
