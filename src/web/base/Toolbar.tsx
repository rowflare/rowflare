// View toolbar: hide fields, filter, sort, row height, search, export.
import { useEffect, useRef, useState } from "react";
import type { FilterSpec, GroupLevel, SortSpec, View } from "../../shared/types";
import type { BaseClient } from "./client";
import { Button, FieldIcon, Icon, Popover } from "../ui";
import { FilterEditor } from "./FilterEditor";

export function ViewToolbar({ client, view, search, setSearch, onAddRecord }: { client: BaseClient; view: View; search: string; setSearch: (s: string) => void; onAddRecord?: () => void }) {
  const [open, setOpen] = useState<null | { kind: "hide" | "filter" | "sort" | "height" | "group"; anchor: HTMLElement }>(null);
  const filters = view.config.filters?.conditions.length ?? 0;
  const sorts = view.config.sorts?.length ?? 0;
  const hidden = view.config.hidden?.length ?? 0;
  const st = client.viewState(view.id);
  const count = st ? st.total ?? st.ids.length : undefined;
  const toggle = (kind: "hide" | "filter" | "sort" | "height" | "group") => (e: React.MouseEvent<HTMLButtonElement>) => setOpen(o => (o?.kind === kind ? null : { kind, anchor: e.currentTarget }));
  const showGridTools = view.type !== "form";
  return (
    <div className="toolbar">
      {showGridTools && (
        <>
          {onAddRecord && client.writable && <Button small variant="primary" icon="plus" onClick={onAddRecord}>Record</Button>}
          {view.type === "grid" && <Button small variant="ghost" icon="eye" className={hidden ? "active" : ""} onClick={toggle("hide")}>{hidden ? `${hidden} hidden` : "Hide fields"}</Button>}
          <Button small variant="ghost" icon="filter" className={filters ? "active" : ""} onClick={toggle("filter")}>{filters ? `${filters} filter${filters > 1 ? "s" : ""}` : "Filter"}</Button>
          <Button small variant="ghost" icon="sort" className={sorts ? "active" : ""} onClick={toggle("sort")}>{sorts ? `Sorted by ${sorts}` : "Sort"}</Button>
          {view.type === "grid" && <Button small variant="ghost" icon="table" className={view.config.groups?.length ? "active" : ""} onClick={toggle("group")}>{view.config.groups?.length ? `Grouped by ${view.config.groups.length}` : "Group"}</Button>}
          {view.type === "grid" && <Button small variant="ghost" icon="rowHeight" onClick={toggle("height")} aria-label="Row height" />}
          <div className="grow" />
          {count !== undefined && <span className="muted small toolbar-count">{count.toLocaleString()} record{count === 1 ? "" : "s"}</span>}
          <SearchBox value={search} onChange={setSearch} />
          <a className="btn btn-sm btn-ghost" href={`/api/bases/${client.baseId}/export.csv?tableId=${view.tableId}&viewId=${view.id}&name=${encodeURIComponent(client.table(view.tableId)?.name ?? "export")}`} title="Download CSV">
            <Icon name="download" size={14} />
          </a>
        </>
      )}
      {open?.kind === "hide" && <HidePanel client={client} view={view} anchor={open.anchor} onClose={() => setOpen(null)} />}
      {open?.kind === "filter" && <FilterPanel client={client} view={view} anchor={open.anchor} onClose={() => setOpen(null)} />}
      {open?.kind === "sort" && <SortPanel client={client} view={view} anchor={open.anchor} onClose={() => setOpen(null)} />}
      {open?.kind === "group" && <GroupPanel client={client} view={view} anchor={open.anchor} onClose={() => setOpen(null)} />}
      {open?.kind === "height" && (
        <Popover anchor={open.anchor} onClose={() => setOpen(null)} className="menu">
          {(["short", "medium", "tall"] as const).map(h => (
            <button key={h} className="menu-item" onClick={() => { client.updateViewConfig(view.id, { rowHeight: h }); setOpen(null); }}>
              {(view.config.rowHeight ?? "short") === h ? <Icon name="check" size={14} /> : <span style={{ width: 14 }} />} {h[0].toUpperCase() + h.slice(1)}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="search-box">
      <Icon name="search" size={14} />
      <input
        value={draft}
        placeholder="Search"
        onChange={e => {
          setDraft(e.target.value);
          clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => onChange(v), 250);
        }}
        onKeyDown={e => e.key === "Escape" && (setDraft(""), onChange(""))}
      />
    </label>
  );
}

function HidePanel({ client, view, anchor, onClose }: { client: BaseClient; view: View; anchor: HTMLElement; onClose: () => void }) {
  const primary = client.table(view.tableId)?.primaryFieldId;
  const hidden = new Set(view.config.hidden ?? []);
  const [q, setQ] = useState("");
  const list = client.orderedFields(view).filter(f => f.id !== primary && f.name.toLowerCase().includes(q.toLowerCase()));
  const set = (ids: string[]) => client.updateViewConfig(view.id, { hidden: ids }, 200);
  return (
    <Popover anchor={anchor} onClose={onClose} width={300}>
      <input className="input" placeholder="Find a field" value={q} onChange={e => setQ(e.target.value)} autoFocus />
      <div className="toggle-list">
        {list.map(f => (
          <label key={f.id} className="toggle-row">
            <input type="checkbox" checked={!hidden.has(f.id)} onChange={e => set(e.target.checked ? [...hidden].filter(id => id !== f.id) : [...hidden, f.id])} />
            <FieldIcon type={f.type} />
            <span className="grow">{f.name}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <Button small variant="ghost" onClick={() => set(client.fields(view.tableId).filter(f => f.id !== primary).map(f => f.id))}>Hide all</Button>
        <Button small variant="ghost" onClick={() => set([])}>Show all</Button>
      </div>
    </Popover>
  );
}

function FilterPanel({ client, view, anchor, onClose }: { client: BaseClient; view: View; anchor: HTMLElement; onClose: () => void }) {
  const [spec, setSpec] = useState<FilterSpec>(view.config.filters ?? { conjunction: "and", conditions: [] });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const update = (next: FilterSpec, delay = 0) => {
    setSpec(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => client.updateViewConfig(view.id, { filters: next }, 300), delay);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={560}>
      <FilterEditor fields={client.fields(view.tableId)} spec={spec} onChange={update} emptyText="No filters applied to this view." />
    </Popover>
  );
}

function SortPanel({ client, view, anchor, onClose }: { client: BaseClient; view: View; anchor: HTMLElement; onClose: () => void }) {
  const fields = client.fields(view.tableId);
  const sorts = view.config.sorts ?? [];
  const set = (next: SortSpec[]) => client.updateViewConfig(view.id, { sorts: next }, 200);
  return (
    <Popover anchor={anchor} onClose={onClose} width={420}>
      {sorts.length === 0 && <p className="muted small" style={{ margin: "4px 4px 10px" }}>Records are in manual order. Drag rows in the grid to reorder.</p>}
      {sorts.map((s, i) => (
        <div key={i} className="filter-row">
          <select className="input" value={s.fieldId} onChange={e => set(sorts.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)))}>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select className="input" value={s.dir} onChange={e => set(sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}>
            <option value="asc">First to last</option>
            <option value="desc">Last to first</option>
          </select>
          <button className="icon-btn" onClick={() => set(sorts.filter((_, j) => j !== i))} aria-label="Remove sort"><Icon name="x" size={14} /></button>
        </div>
      ))}
      <Button small variant="ghost" icon="plus" onClick={() => {
        const unused = fields.find(f => !sorts.some(s => s.fieldId === f.id)) ?? fields[0];
        set([...sorts, { fieldId: unused.id, dir: "asc" }]);
      }}>Add sort</Button>
    </Popover>
  );
}

const NOT_GROUPABLE = new Set(["attachment", "longText", "autonumber", "button"]);

function GroupPanel({ client, view, anchor, onClose }: { client: BaseClient; view: View; anchor: HTMLElement; onClose: () => void }) {
  const levels = view.config.groups ?? [];
  const options = client.orderedFields(view).filter(f => !NOT_GROUPABLE.has(f.type));
  const set = (groups: GroupLevel[]) => client.updateViewConfig(view.id, { groups: groups.length ? groups : undefined });
  return (
    <Popover anchor={anchor} onClose={onClose} width={340}>
      {levels.length === 0 && <div className="muted small" style={{ padding: "2px 2px 8px" }}>Group records by up to 3 fields.</div>}
      {levels.map((g, i) => (
        <div key={i} className="filter-row">
          <select className="input" value={g.fieldId} onChange={e => set(levels.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)))}>
            {options.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select className="input" value={g.dir} onChange={e => set(levels.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}>
            <option value="asc">First to last</option>
            <option value="desc">Last to first</option>
          </select>
          <button className="icon-btn" aria-label="Remove group" onClick={() => set(levels.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
        </div>
      ))}
      {levels.length < 3 && options.length > 0 && (
        <Button small variant="ghost" icon="plus" onClick={() => set([...levels, { fieldId: options.find(f => !levels.some(l => l.fieldId === f.id))?.id ?? options[0]!.id, dir: "asc" }])}>Add group</Button>
      )}
    </Popover>
  );
}
