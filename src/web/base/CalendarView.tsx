// Calendar view: month and week layouts, multi-day bars, drag to reschedule or resize, click to create.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Cells, Field, View } from "../../shared/types";
import { COMPUTED_TYPES } from "../../shared/types";
import { Button, Empty, Icon, Popover, Spinner } from "../ui";
import { type BaseClient, primaryText, useBase } from "./client";
import { isEmpty, valueOf } from "./cards";
import { DateSetup, dateFields } from "./DateSetup";
import { WEEKDAY_NAMES, addDays, queryWindow, addMonths, atMinutes, clip, dayLabel, diffDays, fmtMinutes, localDay, minutesOf, monthGrid, monthLabel, packRows, spanOf, weekDays, withDay, type Day, type Span } from "./dates";
import "./views.css";

const MORE_H = 18; // room for the "+N more" line under the bars
const BAR_H = 22;
const DAY_HEAD = 26;
const HOUR_H = 40;

interface Item extends Span {
  id: number;
  title: string;
  /** Start minutes of single-day records whose start has a time of day; null for all-day records. */
  minutes: number | null;
  endMinutes: number | null;
}

interface Drag {
  id: number;
  mode: "move" | "start" | "end";
  /** Days between the item's start and the day the pointer grabbed. */
  grab: number;
  /** Week view: minutes between a timed item's start and where the pointer grabbed it. */
  grabMinutes?: number;
}

type Seg = Span & { cutStart: boolean; cutEnd: boolean };

interface Props {
  client: BaseClient;
  view: View;
  search: string;
  onExpand: (rowId: number) => void;
}

export default function CalendarView(props: Props) {
  useBase(props.client);
  const view = props.client.view(props.view.id) ?? props.view;
  const options = dateFields(props.client, view.tableId);
  const start = options.find(f => f.id === view.config.dateFieldId);
  if (!start) return <DateSetup client={props.client} view={view} icon="calendar" title="Show records on a calendar" text="Choose the date field that places each record on the calendar." />;
  return <CalendarBody {...props} view={view} start={start} end={options.find(f => f.id === view.config.endDateFieldId && f.id !== start.id)} options={options} />;
}

function CalendarBody({ client, view, search, onExpand, start, end, options }: Props & { start: Field; end?: Field; options: Field[] }) {
  const tableId = view.tableId;
  const mode = view.config.calendarMode ?? "month";
  const [anchor, setAnchor] = useState<Day>(() => localDay());
  const [side, setSide] = useState(false);
  const [settings, setSettings] = useState<HTMLElement | null>(null);
  const [more, setMore] = useState<{ day: Day; anchor: HTMLElement } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const monthRef = useRef<HTMLDivElement>(null);
  const [weekH, setWeekH] = useState(96);
  // The grid is not on screen while a load error shows; layout is measured again after Retry.
  const failed = !!client.viewState(view.id)?.error;
  const weeks = mode === "month" ? monthGrid(anchor) : [weekDays(anchor)];
  const from = weeks[0]![0]!;
  const to = weeks[weeks.length - 1]![6]!;

  useEffect(() => {
    const w = queryWindow(from, to);
    client.setViewRange(view.id, w.from, w.to, search);
  }, [client, view.id, from, to, search]);

  useEffect(() => {
    if (body.current) body.current.scrollTop = 8 * HOUR_H;
  }, [mode, failed]);

  // Bars per week row that fit above the "+N more" line, from the measured row height.
  useEffect(() => {
    const el = monthRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const row = el.querySelector(".cal-week");
      if (row) setWeekH(row.getBoundingClientRect().height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, failed]);
  const lanes = Math.max(1, Math.floor((weekH - DAY_HEAD - MORE_H) / (BAR_H + 2)));

  const st = client.viewState(view.id);
  const ids = st?.ids ?? [];
  useEffect(() => {
    client.ensureRows(tableId, ids);
  });

  const editable = client.writable && !COMPUTED_TYPES.has(start.type) && (!end || !COMPUTED_TYPES.has(end.type));
  const timedStart = start.type !== "date" || !!start.options.includeTime;
  // Recomputed only when the view's rows or settings change, not on every update of the base (presence, cursors).
  const version = client.dataVersion(tableId);
  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const id of ids) {
      const row = client.row(tableId, id);
      if (!row) continue;
      const sv = valueOf(start, row);
      const ev = end ? valueOf(end, row) : undefined;
      const span = spanOf(sv, ev);
      if (!span) continue;
      const single = span.start === span.end;
      out.push({ id, ...span, title: primaryText(client, tableId, row) || "Unnamed record", minutes: single && timedStart ? minutesOf(sv) : null, endMinutes: single && end ? minutesOf(ev) : null });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, version, start, end, timedStart, client, tableId, client.schema.version]);

  const write = (id: number, next: Span, time?: { start: number; end: number | null }) => {
    const row = client.row(tableId, id);
    if (!row || !editable) return;
    const cells: Cells = {};
    cells[start.id] = time && start.options.includeTime ? atMinutes(next.start, time.start) : withDay(valueOf(start, row), next.start, !!start.options.includeTime);
    if (end && (!isEmpty(valueOf(end, row)) || next.end !== next.start)) {
      cells[end.id] = time && time.end !== null && end.options.includeTime ? atMinutes(next.end, time.end) : withDay(valueOf(end, row), next.end, !!end.options.includeTime);
    }
    // Records placed from the unscheduled list are not in this view's ids yet; own writes are not echoed back.
    void client.updateCells(tableId, [{ id, cells }], { label: "Reschedule" }).then(() => {
      if (!ids.includes(id)) void client.queryView(view.id, search);
    });
  };

  const dropOn = (day: Day, minutes?: number) => {
    const d = drag.current;
    drag.current = null;
    setOver(null);
    if (!d) return;
    const it = items.find(x => x.id === d.id);
    if (!it) return write(d.id, { start: day, end: day }, minutes === undefined ? undefined : { start: minutes, end: end ? minutes + 60 : null });
    if (d.mode === "start") return write(it.id, { start: day <= it.end ? day : it.end, end: it.end });
    if (d.mode === "end") return write(it.id, { start: it.start, end: day >= it.start ? day : it.start });
    const s = addDays(day, -d.grab);
    const at = minutes === undefined ? undefined : Math.max(0, minutes - (d.grabMinutes ?? 0));
    const time = at === undefined ? undefined : { start: at, end: it.minutes !== null && it.endMinutes !== null ? at + (it.endMinutes - it.minutes) : null };
    write(it.id, { start: s, end: addDays(s, diffDays(it.start, it.end)) }, time);
  };

  const create = async (day: Day, minutes?: number) => {
    if (!editable) return;
    const m = minutes ?? 9 * 60;
    const cells: Cells = { [start.id]: start.options.includeTime ? atMinutes(day, m) : day };
    if (end && minutes !== undefined && end.options.includeTime) cells[end.id] = atMinutes(day, m + 60);
    const rows = await client.createRows(tableId, [{ cells }]);
    if (rows[0]) onExpand(rows[0].id);
  };

  const startDrag = (e: React.DragEvent, d: Drag) => {
    e.stopPropagation();
    drag.current = d;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(d.id));
  };
  const endDrag = () => {
    drag.current = null;
    setOver(null);
  };
  const dropTarget = (key: string, onDrop: (e: React.DragEvent<HTMLElement>) => void) => ({
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!drag.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over !== key) setOver(key);
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => (o === key ? null : o));
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      onDrop(e);
    },
  });
  const slotMinutes = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(23 * 60 + 30, Math.max(0, Math.round((((e.clientY - r.top) / HOUR_H) * 60) / 30) * 30));
  };

  /** Enter or Space opens a record, the same as a click. */
  const openKey = (e: React.KeyboardEvent, id: number) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onExpand(id);
  };

  const bar = (it: Item, seg: Seg, style: React.CSSProperties) => (
    <div
      key={`${it.id}:${seg.start}`}
      className={"cal-bar" + (seg.cutStart ? " cut-start" : "") + (seg.cutEnd ? " cut-end" : "")}
      style={style}
      title={it.title}
      role="button" tabIndex={0} onKeyDown={e => openKey(e, it.id)}
      draggable={editable}
      onDragStart={e => {
        const r = e.currentTarget.getBoundingClientRect();
        const days = diffDays(seg.start, seg.end) + 1;
        const at = Math.min(days - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * days)));
        startDrag(e, { id: it.id, mode: "move", grab: diffDays(it.start, seg.start) + at });
      }}
      onDragEnd={endDrag}
      onClick={() => onExpand(it.id)}
    >
      {editable && end && !seg.cutStart && <span className="cal-handle start" draggable onDragStart={e => startDrag(e, { id: it.id, mode: "start", grab: 0 })} onDragEnd={endDrag} onClick={e => e.stopPropagation()} />}
      {it.minutes !== null && <span className="cal-time">{fmtMinutes(it.minutes)}</span>}
      <span className="cal-title">{it.title}</span>
      {editable && end && !seg.cutEnd && <span className="cal-handle end" draggable onDragStart={e => startDrag(e, { id: it.id, mode: "end", grab: 0 })} onDragEnd={endDrag} onClick={e => e.stopPropagation()} />}
    </div>
  );
  const barStyle = (origin: Day, p: Span, top: number): React.CSSProperties => ({
    left: `calc(${(diffDays(origin, p.start) / 7) * 100}% + 2px)`,
    width: `calc(${((diffDays(p.start, p.end) + 1) / 7) * 100}% - 4px)`,
    top,
  });

  const today = localDay();
  const month = anchor.slice(0, 7);
  const unscheduled = client.unscheduledIds(view.id);
  const step = (n: number) => setAnchor(a => (mode === "month" ? addMonths(a, n) : addDays(a, 7 * n)));
  const title = mode === "month" ? monthLabel(anchor) : `${dayLabel(from)} - ${dayLabel(to)}, ${to.slice(0, 4)}`;

  const monthBody = (
    <div className="cal-month" ref={monthRef}>
      <div className="cal-dow">{WEEKDAY_NAMES.map(d => <div key={d}>{d}</div>)}</div>
      {weeks.map(week => {
        const packed = packRows(items.flatMap(it => {
          const seg = clip(it, week[0]!, week[6]!);
          return seg ? [{ ...seg, it }] : [];
        }));
        return (
          <div key={week[0]} className="cal-week">
            {week.map(d => {
              const hiddenCount = packed.filter(p => p.row >= lanes && p.start <= d && p.end >= d).length;
              return (
                <div key={d} className={"cal-day" + (d.slice(0, 7) !== month ? " other" : "") + (over === d ? " over" : "")} data-day={d} {...dropTarget(d, () => dropOn(d))}>
                  <span className={"cal-num" + (d === today ? " today" : "")}>{+d.slice(8)}</span>
                  {editable && <button className="cal-add" aria-label={`New record on ${d}`} onClick={() => create(d)}><Icon name="plus" size={12} /></button>}
                  {hiddenCount > 0 && <button className="cal-more" style={{ top: DAY_HEAD + lanes * (BAR_H + 2) }} onClick={e => setMore({ day: d, anchor: e.currentTarget })}>+{hiddenCount} more</button>}
                </div>
              );
            })}
            <div className="cal-bars">{packed.filter(p => p.row < lanes).map(p => bar(p.it, p, barStyle(week[0]!, p, DAY_HEAD + p.row * (BAR_H + 2))))}</div>
          </div>
        );
      })}
    </div>
  );

  const week = weeks[0]!;
  const allDay = packRows(items.filter(it => it.minutes === null).flatMap(it => {
    const seg = clip(it, from, to);
    return seg ? [{ ...seg, it }] : [];
  }));
  const allRows = Math.max(1, ...allDay.map(p => p.row + 1));
  const weekBody = (
    <div className="cal-wk">
      <div className="cal-wk-head">
        <div className="cal-gutter" />
        {week.map(d => <div key={d} className={"cal-wk-day" + (d === today ? " today" : "")}>{dayLabel(d)}</div>)}
      </div>
      <div className="cal-wk-allday" style={{ height: allRows * (BAR_H + 2) + 6 }}>
        <div className="cal-gutter">All day</div>
        {week.map(d => <div key={d} className={"cal-wk-cell" + (over === d ? " over" : "")} data-day={d} {...dropTarget(d, () => dropOn(d))} onDoubleClick={() => create(d)} />)}
        <div className="cal-bars cal-wk-bars">{allDay.map(p => bar(p.it, p, barStyle(from, p, 3 + p.row * (BAR_H + 2))))}</div>
      </div>
      <div className="cal-wk-body" ref={body}>
        <div className="cal-wk-hours">{Array.from({ length: 24 }, (_, h) => <div key={h} style={{ height: HOUR_H }}>{h ? `${h}:00` : ""}</div>)}</div>
        {week.map(d => (
          <div key={d} className={"cal-wk-col" + (over === "t" + d ? " over" : "")} style={{ height: 24 * HOUR_H }} data-day={d} {...dropTarget("t" + d, e => dropOn(d, slotMinutes(e)))} onDoubleClick={e => create(d, slotMinutes(e))}>
            {items.filter(it => it.minutes !== null && it.start === d).map(it => {
              const len = it.endMinutes !== null && it.endMinutes > it.minutes! ? it.endMinutes - it.minutes! : 60;
              return (
                <div key={it.id} className="cal-event" role="button" tabIndex={0} onKeyDown={e => openKey(e, it.id)} style={{ top: (it.minutes! / 60) * HOUR_H, height: Math.max(HOUR_H / 2, (len / 60) * HOUR_H) - 2 }} title={it.title} draggable={editable} onDragStart={e => startDrag(e, { id: it.id, mode: "move", grab: 0, grabMinutes: Math.round(((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR_H) * 2) * 30 })} onDragEnd={endDrag} onClick={() => onExpand(it.id)}>
                  <span className="cal-time">{fmtMinutes(it.minutes!)}</span> {it.title}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="cal">
      <div className="kb-toolbar cal-toolbar">
        <div className="cal-nav">
          <Button small onClick={() => setAnchor(localDay())}>Today</Button>
          <button className="icon-btn" aria-label="Previous" onClick={() => step(-1)}><Icon name="back" size={16} /></button>
          <button className="icon-btn cal-next" aria-label="Next" onClick={() => step(1)}><Icon name="back" size={16} /></button>
          <strong className="cal-title-text">{title}</strong>
          {st?.loading && <Spinner size={14} />}
        </div>
        <div className="cal-nav">
          <div className="seg">
            {(["month", "week"] as const).map(m => (
              <button key={m} className={"seg-btn" + (mode === m ? " active" : "")} onClick={() => client.updateViewConfig(view.id, { calendarMode: m })}>{m === "month" ? "Month" : "Week"}</button>
            ))}
          </div>
          <button className={"btn btn-sm btn-ghost" + (side ? " active" : "")} onClick={() => setSide(s => !s)}>Unscheduled {unscheduled.length >= 200 ? "200+" : unscheduled.length}</button>
          <button className={"btn btn-sm btn-ghost" + (settings ? " active" : "")} onClick={e => setSettings(settings ? null : e.currentTarget)}><Icon name="settings" size={14} /> Settings</button>
        </div>
        {settings && (
          <Popover anchor={settings} onClose={() => setSettings(null)} width={280} align="end" className="kb-settings">
            <label className="field-label">Date field</label>
            <select className="input" disabled={!client.writable} value={start.id} onChange={e => client.updateViewConfig(view.id, { dateFieldId: e.target.value })}>
              {options.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <label className="field-label">End date (optional)</label>
            <select className="input" disabled={!client.writable} value={end?.id ?? ""} onChange={e => client.updateViewConfig(view.id, { endDateFieldId: e.target.value || undefined })}>
              <option value="">None</option>
              {options.filter(f => f.id !== start.id).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Popover>
        )}
      </div>
      {st?.error ? (
        <Empty title="Could not load records">
          <div className="muted">{st.error}</div>
          <Button small onClick={() => client.queryView(view.id, search)}>Retry</Button>
        </Empty>
      ) : (
        <div className="cal-main">
          {mode === "month" ? monthBody : weekBody}
          {side && (
            <aside className="cal-side">
              <div className="cal-side-head">Unscheduled</div>
              {unscheduled.length === 0 && <div className="muted small">Every record has a date.</div>}
              {unscheduled.map(id => {
                const row = client.row(tableId, id);
                return (
                  <div key={id} className="cal-side-item" role="button" tabIndex={0} onKeyDown={e => openKey(e, id)} draggable={editable} onDragStart={e => startDrag(e, { id, mode: "move", grab: 0 })} onDragEnd={endDrag} onClick={() => onExpand(id)}>
                    {row ? primaryText(client, tableId, row) || "Unnamed record" : "Loading..."}
                  </div>
                );
              })}
            </aside>
          )}
        </div>
      )}
      {more && (
        <Popover anchor={more.anchor} onClose={() => setMore(null)} width={260} className="menu">
          <div className="cal-more-title">{dayLabel(more.day)}</div>
          {items.filter(it => it.start <= more.day && it.end >= more.day).map(it => (
            <button key={it.id} className="menu-item" onClick={() => { setMore(null); onExpand(it.id); }}>
              {it.minutes !== null && <span className="cal-time">{fmtMinutes(it.minutes)}</span>} {it.title}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}
