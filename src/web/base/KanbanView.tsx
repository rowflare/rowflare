// Kanban board: one column per choice of a single select field, cards with drag and drop.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Field, View } from "../../shared/types";
import { COLORS } from "../../shared/types";
import { toastError } from "../toast";
import { Button, Empty, Icon, Menu, Spinner, type MenuItem } from "../ui";
import { type BaseClient, useBase } from "./client";
import { CardSettings, RecordCard, cardFields, coverField } from "./cards";
import { Chip } from "./editors";
import "./views.css";

const NONE = "__none";
const PAGE = 100;

interface Column {
  key: string;
  name: string;
  color: string;
  ids: number[];
}


export default function KanbanView({ client, view: viewProp, search, onExpand }: { client: BaseClient; view: View; search: string; onExpand: (rowId: number) => void }) {
  useBase(client);
  const view = client.view(viewProp.id) ?? viewProp;
  const tableId = view.tableId;
  const st = client.viewState(view.id);
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    client.queryView(view.id, search);
  }, [client, view.id, search]);

  const groupField = client.field(view.config.groupFieldId ?? "");
  const valid = !!groupField && groupField.tableId === tableId && groupField.type === "singleSelect";

  const settings = (
    <>
      <button className={"btn btn-sm btn-ghost" + (settingsAnchor ? " active" : "")} onClick={e => setSettingsAnchor(settingsAnchor ? null : e.currentTarget)}>
        <Icon name="settings" size={14} /> Customize cards
      </button>
      {settingsAnchor && <BoardSettings client={client} view={view} anchor={settingsAnchor} onClose={() => setSettingsAnchor(null)} />}
    </>
  );

  return (
    <div className="kb">
      <div className="kb-toolbar">
        <div className="kb-toolbar-info muted small">
          {valid && (
            <>
              Grouped by <strong>{groupField!.name}</strong>
              {st && !st.loading && <> · {st.ids.length} {st.ids.length === 1 ? "record" : "records"}</>}
            </>
          )}
          {st?.loading && <Spinner size={14} />}
        </div>
        {settings}
      </div>
      {!valid ? (
        <GroupSetup client={client} view={view} />
      ) : st?.error ? (
        <Empty title="Could not load records">
          <div className="muted">{st.error}</div>
          <Button small onClick={() => client.queryView(view.id, search)}>Retry</Button>
        </Empty>
      ) : (
        <Board client={client} view={view} groupField={groupField!} onExpand={onExpand} />
      )}
    </div>
  );
}

function GroupSetup({ client, view }: { client: BaseClient; view: View }) {
  const options = client.fields(view.tableId).filter(f => f.type === "singleSelect");
  const [busy, setBusy] = useState(false);
  const createStatus = async () => {
    setBusy(true);
    try {
      const choices = ["Todo", "In progress", "Done"].map((name, i) => ({ id: "", name, color: COLORS[i]! }));
      const res = await client.schemaOp({ op: "createField", tableId: view.tableId, field: { name: "Status", type: "singleSelect", options: { choices } } });
      if (res.id) client.updateViewConfig(view.id, { groupFieldId: res.id });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kb-setup">
      <div className="kb-setup-card card">
        <div className="kb-setup-icon"><Icon name="kanban" size={22} /></div>
        <h3>Group records into columns</h3>
        {options.length ? (
          <>
            <p className="muted">Choose a single select field. Each of its options becomes a column on this board.</p>
            <select className="input" value="" disabled={!client.writable} onChange={e => e.target.value && client.updateViewConfig(view.id, { groupFieldId: e.target.value })}>
              <option value="">Select a field...</option>
              {options.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </>
        ) : (
          <>
            <p className="muted">This table has no single select field yet. A kanban board needs one to build its columns.</p>
            {client.writable && <Button variant="primary" icon="plus" disabled={busy} onClick={createStatus}>Add a Status field</Button>}
          </>
        )}
      </div>
    </div>
  );
}

function BoardSettings({ client, view, anchor, onClose }: { client: BaseClient; view: View; anchor: HTMLElement; onClose: () => void }) {
  const selects = client.orderedFields(view).filter(f => f.type === "singleSelect");
  return (
    <CardSettings client={client} view={view} anchor={anchor} onClose={onClose} exclude={view.config.groupFieldId ? [view.config.groupFieldId] : []}>
      <label className="field-label">Group by</label>
      <select className="input" disabled={!client.writable} value={view.config.groupFieldId ?? ""} onChange={e => client.updateViewConfig(view.id, { groupFieldId: e.target.value || undefined })}>
        <option value="">None</option>
        {selects.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </CardSettings>
  );
}

interface DropTarget {
  col: string;
  index: number;
}

function Board({ client, view, groupField, onExpand }: { client: BaseClient; view: View; groupField: Field; onExpand: (rowId: number) => void }) {
  const tableId = view.tableId;
  const st = client.viewState(view.id);
  const ids = st?.ids ?? [];
  const writable = client.writable;
  const sorted = !!view.config.sorts?.length;
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [dragId, setDragId] = useState<number | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; id: number } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const dragRef = useRef<number | null>(null);

  // Group values from the last query, keyed by id. Recomputed only when the server sends a new
  // groups array so local reorders (which keep the old array) cannot misalign it.
  const queried = useMemo(() => {
    const m = new Map<number, string | null>();
    st?.groups?.forEach((g, i) => m.set(st.ids[i]!, g));
    return m;
  }, [st?.groups]);

  const choices = groupField.options.choices ?? [];
  const choiceIds = new Set(choices.map(c => c.id));
  const groupOf = (id: number): string => {
    const r = client.row(tableId, id);
    const raw = r ? r.cells[groupField.id] : queried.get(id);
    return typeof raw === "string" && choiceIds.has(raw) ? raw : NONE;
  };

  const byKey = new Map<string, number[]>([[NONE, []], ...choices.map(c => [c.id, []] as [string, number[]])]);
  for (const id of ids) byKey.get(groupOf(id))!.push(id);
  const columns: Column[] = [
    { key: NONE, name: "Uncategorized", color: "var(--chip)", ids: byKey.get(NONE)! },
    ...choices.map(c => ({ key: c.id, name: c.name, color: c.color, ids: byKey.get(c.id)! })),
  ].filter(c => c.key !== NONE || c.ids.length > 0);

  const shown = (c: Column) => c.ids.slice(0, limits[c.key] ?? PAGE);
  const visibleIds = columns.flatMap(shown);
  useEffect(() => {
    client.ensureRows(tableId, visibleIds);
  });

  const fieldsOnCards = cardFields(client, view, [groupField.id]);
  const cover = coverField(client, view);

  /** Moves a card to `index` among the cards of column `col` (index counts the card itself if already there). */
  const moveCard = (id: number, col: string, index: number) => {
    const colIds = columns.find(c => c.key === col)?.ids ?? [];
    const before = colIds.slice(0, index).filter(x => x !== id);
    const after = colIds.slice(index).filter(x => x !== id);
    if (groupOf(id) !== col) client.updateCells(tableId, [{ id, cells: { [groupField.id]: col === NONE ? null : col } }], { label: "Move card" });
    if (sorted) return;
    const from = ids.indexOf(id);
    const rest = ids.filter(x => x !== id);
    let to = from;
    if (before.length) to = rest.indexOf(before[before.length - 1]!) + 1;
    else if (after.length) to = rest.indexOf(after[0]!);
    if (to >= 0 && to !== from) client.moveRow(view.id, id, to);
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragId(null);
    setDrop(null);
  };

  const onListDragOver = (e: React.DragEvent<HTMLElement>, col: Column) => {
    if (dragRef.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-card]")];
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i]!.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    // Cards past the shown limit keep their place: dropping at the end of a truncated list lands after the last shown card.
    if (!drop || drop.col !== col.key || drop.index !== index) setDrop({ col: col.key, index });
  };

  const onListDrop = (e: React.DragEvent<HTMLElement>, col: Column) => {
    e.preventDefault();
    const id = dragRef.current;
    const target = drop;
    endDrag();
    if (id === null || !target || target.col !== col.key) return;
    moveCard(id, col.key, target.index);
  };

  const create = async (col: Column) => {
    setCreating(col.key);
    const rows = await client.createRows(tableId, [{ cells: col.key === NONE ? {} : { [groupField.id]: col.key } }]);
    setCreating(null);
    if (rows[0]) onExpand(rows[0].id);
  };

  const menuItems = (id: number): (MenuItem | "sep")[] => {
    const cur = groupOf(id);
    const col = columns.find(c => c.key === cur);
    const pos = col?.ids.indexOf(id) ?? -1;
    const items: (MenuItem | "sep")[] = [{ label: "Expand record", icon: "expand", onClick: () => onExpand(id) }];
    if (!writable) return items;
    if (!sorted && col) {
      items.push(
        { label: "Move up", disabled: pos <= 0, onClick: () => moveCard(id, cur, pos - 1) },
        { label: "Move down", disabled: pos < 0 || pos >= col.ids.length - 1, onClick: () => moveCard(id, cur, pos + 2) },
      );
    }
    items.push("sep");
    const targets = [{ key: NONE, name: "Uncategorized" }, ...choices.map(c => ({ key: c.id, name: c.name }))].filter(c => c.key !== cur);
    for (const c of targets) items.push({ label: `Move to ${c.name}`, icon: "kanban", onClick: () => moveCard(id, c.key, columns.find(x => x.key === c.key)?.ids.length ?? 0) });
    return items;
  };

  if (!st || (st.loading && !ids.length && !st.groups)) {
    return <div className="kb-loading"><Spinner /></div>;
  }

  return (
    <div className="kb-board">
      {columns.map(col => {
        const list = shown(col);
        const over = drop?.col === col.key;
        return (
          <section
            key={col.key}
            className={"kb-col" + (over ? " over" : "")}
            aria-label={col.name}
            onDragOver={e => onListDragOver(e, col)}
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(d => (d?.col === col.key ? null : d));
            }}
            onDrop={e => onListDrop(e, col)}
          >
            <header className="kb-col-head">
              <Chip name={col.name} color={col.color} />
              <span className="kb-count">{col.ids.length}</span>
            </header>
            <div className={"kb-cards" + (over && list.length === 0 ? " drop-empty" : "")}>
              {list.map((id, i) => {
                const cls = (over && drop!.index === i ? " drop-before" : "") + (over && drop!.index === list.length && i === list.length - 1 ? " drop-after" : "");
                return (
                  <RecordCard
                    key={id}
                    client={client}
                    tableId={tableId}
                    id={id}
                    fields={fieldsOnCards}
                    cover={cover}
                    onOpen={onExpand}
                    onMenu={anchor => setMenu({ anchor, id })}
                    className={(dragId === id ? "dragging" : "") + cls}
                    draggable={writable}
                    onDragStart={e => {
                      dragRef.current = id;
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(id));
                      // Defer so the drag image is taken before the card fades.
                      setTimeout(() => setDragId(id), 0);
                    }}
                    onDragEnd={endDrag}
                  />
                );
              })}
              {col.ids.length > list.length && (
                <button className="kb-more" onClick={() => setLimits(l => ({ ...l, [col.key]: list.length + PAGE }))}>
                  Show more ({col.ids.length - list.length})
                </button>
              )}
            </div>
            {writable && (
              <button className="kb-add" disabled={creating === col.key} onClick={() => create(col)}>
                {creating === col.key ? <Spinner size={14} /> : <Icon name="plus" size={14} />} New record
              </button>
            )}
          </section>
        );
      })}
      {menu && <Menu anchor={menu.anchor} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  );
}
