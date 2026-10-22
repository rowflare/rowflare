// Grid view on Glide Data Grid: virtual scrolling over the view's id list, lazy row loading,
// Excel-compatible copy / paste, fill handle, column and row drag, and collaborator cursors.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Highlight,
  type Item,
  type Rectangle,
  type Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import type { Cells, Field, SummaryFn, View } from "../../shared/types";
import { aiFieldProblem, type AiProgress, type AiServiceInfo } from "../../shared/ai";
import { listBaseServices } from "../ai/api";
import { COMPUTED_TYPES } from "../../shared/types";
import { BaseClient, useBase } from "./client";
import { buttonRenderer, chipsRenderer, DEFAULT_WIDTH, groupHeaderRenderer, HEADER_ICONS, POPOVER_TYPES, rawValue, toGridCell, valueFromCell, type GroupHeaderCell } from "./cells";
import { runButtonField } from "../auto/button";
import { AI_HEADER_ICONS, aiCell, aiRenderer } from "../ai/aiCell";
import { buildRows, existingPaths, groupCells, headerLabel, summaryOptions, summaryText, SUMMARY_LABELS, type HeaderRow } from "./gridGroups";
import { FieldValueEditor } from "./editors";
import { Icon, Menu, Popover, type MenuItem } from "../ui";
import { toast, toastError } from "../toast";
import { post } from "../api";

const ROW_HEIGHTS = { short: 34, medium: 60, tall: 96 } as const;

const theme: Partial<Theme> = {
  accentColor: "#c4421a",
  accentFg: "#ffffff",
  accentLight: "rgba(196, 66, 26, 0.09)",
  textDark: "#1d1b19",
  textMedium: "#57524c",
  textLight: "#8a847d",
  textHeader: "#3b3631",
  textHeaderSelected: "#ffffff",
  bgCell: "#ffffff",
  bgCellMedium: "#faf9f7",
  bgHeader: "#f7f5f2",
  bgHeaderHasFocus: "#efebe6",
  bgHeaderHovered: "#f0ece7",
  borderColor: "#e9e5e0",
  horizontalBorderColor: "#ece8e3",
  linkColor: "#a8370f",
  headerFontStyle: "600 12.5px",
  baseFontStyle: "13px",
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  cellHorizontalPadding: 10,
};

function loadCollapsed(viewId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("rf-collapsed:" + viewId) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(viewId: string, s: Set<string>) {
  try {
    localStorage.setItem("rf-collapsed:" + viewId, JSON.stringify([...s]));
  } catch {
    // Storage unavailable (private mode); collapse still works for this session.
  }
}


export interface GridHandlers {
  onExpand: (rowId: number) => void;
  onEditField: (fieldId: string, anchor: DOMRect) => void;
  onInsertField: (anchor: DOMRect, position: { afterFieldId?: string; beforeFieldId?: string }) => void;
}

interface PopoverEdit {
  rowId: number;
  field: Field;
  rect: DOMRect;
}

export default function GridView({ client, view, search, handlers }: { client: BaseClient; view: View; search: string; handlers: GridHandlers }) {
  useBase(client);
  const ref = useRef<DataEditorRef>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const tableId = view.tableId;
  const state = client.viewState(view.id);
  const ids = state?.ids ?? [];
  const levels = view.config.groups ?? [];
  const grouped = levels.length > 0;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(view.id));
  // Forget collapsed groups that no longer exist once the full group list is loaded.
  useEffect(() => {
    if (!grouped || !state || state.loading || state.error || !state.groupKeys || !collapsed.size) return;
    const keep = existingPaths(collapsed, state.groupKeys, levels.length);
    if (keep.size === collapsed.size) return;
    saveCollapsed(view.id, keep);
    setCollapsed(keep);
  }, [grouped, state, collapsed, levels.length, view.id]);
  const display = useMemo(() => (grouped ? buildRows(ids, state?.groupKeys ?? [], levels.length, collapsed) : null), [grouped, ids, state?.groupKeys, levels.length, collapsed]);
  /** Record id per display row; undefined for group header rows. */
  const rowIds: (number | undefined)[] = useMemo(() => (display ? display.map(r => (r.kind === "record" ? r.id : undefined)) : ids), [display, ids]);
  const levelFields = levels.map(l => client.field(l.fieldId));
  const fields = client.visibleFields(view);
  const writable = client.writable;
  const rowHeight = ROW_HEIGHTS[view.config.rowHeight ?? "short"];
  const wrapText = rowHeight > 40;
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  const [edit, setEdit] = useState<PopoverEdit | null>(null);
  const [menu, setMenu] = useState<{ anchor: DOMRect; items: (MenuItem | "sep")[] } | null>(null);
  const [hoverRow, setHoverRow] = useState<{ row: number; rect: Rectangle } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    client.queryView(view.id, search);
  }, [client, view.id, search]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // AI services of the workspace, to show a rejected key or a deleted service in AI column headers.
  const [aiServices, setAiServices] = useState<AiServiceInfo[] | null>(null);
  const hasAi = fields.some(f => f.options.ai);
  useEffect(() => {
    if (hasAi) listBaseServices(client.baseId).then(r => setAiServices(r.services), () => setAiServices(null));
  }, [hasAi, client.baseId]);
  const aiProblem = (f: Field): string | null => {
    if (!f.options.ai) return null;
    const p = aiFieldProblem(f, client.fields(tableId));
    if (p) return p;
    const svc = aiServices?.find(s => s.id === f.options.ai!.serviceId);
    if (aiServices && !svc) return "Its AI service was removed";
    if (svc?.keyRejected) return "The AI service's key was rejected";
    return null;
  };

  const columns: GridColumn[] = useMemo(
    () =>
      fields.map(f => ({
        id: f.id,
        title: aiTitle(f, client.aiProgress.get(f.id), aiProblem(f)),
        width: view.config.widths?.[f.id] ?? DEFAULT_WIDTH[f.type] ?? 180,
        icon: f.options.ai ? "ai" : HEADER_ICONS[f.type],
        hasMenu: true,
        themeOverride: COMPUTED_TYPES.has(f.type) ? { bgCell: "#fcfbfa" } : undefined,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(fields.map(f => [f.id, f.name, f.type, f.options.ai ?? null])), JSON.stringify(view.config.widths ?? {}), JSON.stringify([...client.aiProgress.values()]), aiServices],
  );

  const headerCell = useCallback(
    (h: HeaderRow, col: number): GridCell => {
      if (col === 0) {
        const label = headerLabel(levelFields[h.level], h.keys[h.level] ?? null, id => client.memberName(id));
        // copyData doubles as the accessible text; copying skips header rows (cellsForSelection).
        return { kind: GridCellKind.Custom, allowOverlay: false, readonly: true, copyData: `${label} (${h.count})`, data: { kind: "rf-group", label, count: h.count, level: h.level, collapsed: collapsed.has(h.path) } } as GroupHeaderCell;
      }
      const f = fields[col];
      const fn = f ? view.config.summaries?.[f.id] : undefined;
      const text = f && fn ? summaryText(f, fn, state?.summaries?.get(h.path)?.[f.id]) : "";
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, contentAlign: "right" };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, collapsed, view.config.summaries, state?.summaries, client, JSON.stringify(levels)],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const f = fields[col];
      const id = rowIds[row];
      const h = display?.[row];
      if (h?.kind === "header") return headerCell(h, col);
      if (!f || id === undefined) return { kind: GridCellKind.Loading, allowOverlay: false };
      const rec = client.row(tableId, id);
      const cell = toGridCell(f, rec, writable, client.members, wrapText, client.buttonBusy.has(`${f.id}:${id}`));
      const st = f.options.ai ? rec?.ai?.[f.id] : undefined;
      return st ? aiCell(cell, st) : cell;
    },
    // Recreated on every client version so the grid redraws changed rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, rowIds, display, headerCell, client, tableId, writable, wrapText, client.getVersion()],
  );

  const onVisibleRegionChanged = useCallback(
    (r: Rectangle) => {
      const from = Math.max(0, r.y - 60);
      client.ensureRows(tableId, rowIds.slice(from, r.y + r.height + 120).filter((x): x is number => x !== undefined));
    },
    [client, tableId, rowIds],
  );

  // Keep the visible window loaded after a requery replaces the id list.
  const lastRegion = useRef<Rectangle>({ x: 0, y: 0, width: 10, height: 40 });
  useEffect(() => onVisibleRegionChanged(lastRegion.current), [rowIds, onVisibleRegionChanged]);

  const toggleGroup = useCallback(
    (path: string) =>
      setCollapsed(prev => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        saveCollapsed(view.id, next);
        return next;
      }),
    [view.id],
  );

  const onCellClicked = useCallback(
    ([col, row]: Item) => {
      const h = display?.[row];
      if (h?.kind === "header") return toggleGroup(h.path);
      const f = fields[col];
      const id = rowIds[row];
      if (f?.type === "button" && id !== undefined) runButtonField(client, f, id);
      const st = f?.options.ai && id !== undefined ? client.row(tableId, id)?.ai?.[f.id] : undefined;
      if (st?.s === "error" && st.e) toast(st.e, "error");
    },
    [display, toggleGroup, fields, rowIds, client, tableId],
  );

  /** Copy skips group header rows. */
  const cellsForSelection = useCallback(
    (r: Rectangle) => {
      const out: GridCell[][] = [];
      for (let y = r.y; y < r.y + r.height; y++) {
        if (display?.[y]?.kind === "header") continue;
        out.push(Array.from({ length: r.width }, (_, i) => getCellContent([r.x + i, y])));
      }
      return out;
    },
    [display, getCellContent],
  );

  const setSummary = (fieldId: string, fn: SummaryFn | null) => {
    const next = { ...(view.config.summaries ?? {}) };
    if (fn) next[fieldId] = fn;
    else delete next[fieldId];
    client.updateViewConfig(view.id, { summaries: next });
  };

  const write = useCallback(
    (updates: { id: number; cells: Cells }[], typecast = false, label?: string) => {
      if (!writable || !updates.length) return;
      client.updateCells(tableId, updates, { typecast, label });
    },
    [client, tableId, writable],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, cell: EditableGridCell) => {
      const f = fields[col];
      const id = rowIds[row];
      if (!f || id === undefined || COMPUTED_TYPES.has(f.type)) return;
      const v = valueFromCell(cell);
      if (v === undefined) return;
      write([{ id, cells: { [f.id]: v } }]);
    },
    [fields, rowIds, write],
  );

  const onCellsEdited = useCallback(
    (list: readonly { location: Item; value: EditableGridCell }[]) => {
      const byRow = new Map<number, Cells>();
      for (const { location: [col, row], value } of list) {
        const f = fields[col];
        const id = rowIds[row];
        if (!f || id === undefined || COMPUTED_TYPES.has(f.type)) continue;
        const v = valueFromCell(value as GridCell);
        if (v === undefined) continue;
        const cells = byRow.get(id) ?? {};
        cells[f.id] = v;
        byRow.set(id, cells);
      }
      write([...byRow].map(([id, cells]) => ({ id, cells })), false, list.length > 1 ? "Fill" : "Edit");
      return true;
    },
    [fields, rowIds, write],
  );

  const onPaste = useCallback(
    (target: Item, values: readonly (readonly string[])[]) => {
      if (!writable) return false;
      const [col0, row0] = target;
      let data = values;
      // A single copied value fills the whole selected range, like Excel.
      const range = selection.current?.range;
      if (values.length === 1 && values[0].length === 1 && range && range.width * range.height > 1) {
        data = Array.from({ length: range.height }, () => Array.from({ length: range.width }, () => values[0][0]));
      }
      const updates: { id: number; cells: Cells }[] = [];
      const creates: { cells: Cells }[] = [];
      const targets: (number | undefined)[] = [];
      for (let y = row0; targets.length < data.length; y++) {
        if (y >= rowIds.length) targets.push(undefined);
        else if (display?.[y]?.kind !== "header") targets.push(rowIds[y]);
      }
      data.forEach((line, i) => {
        const cells: Cells = {};
        line.forEach((text, j) => {
          const f = fields[col0 + j];
          if (!f || COMPUTED_TYPES.has(f.type)) return;
          cells[f.id] = f.type === "attachment" ? undefined : text;
        });
        const id = targets[i];
        if (id === undefined) creates.push({ cells });
        else updates.push({ id, cells });
      });
      const apply = () => {
        if (updates.length) write(updates, true, "Paste");
        if (creates.length) client.createRows(tableId, creates, { typecast: true });
      };
      // A paste that adds records is checked against the plan first, so it is never half applied.
      if (creates.length) post(`/api/bases/${client.baseId}/rows/check`, { count: creates.length }).then(apply, toastError);
      else apply();
      return false;
    },
    [writable, selection, fields, rowIds, display, write, client, tableId],
  );

  const clearSelection = useCallback(
    (sel: GridSelection) => {
      if (sel.rows.length > 0) {
        const rows = sel.rows.toArray().map(i => rowIds[i]).filter((x): x is number => x !== undefined);
        if (rows.length) {
          client.deleteRows(tableId, rows);
          toast(rows.length === 1 ? "Record deleted" : `${rows.length} records deleted`, "info", { label: "Undo", run: () => client.undo() });
        }
        return false;
      }
      const rects = [sel.current?.range, ...(sel.current?.rangeStack ?? [])].filter((r): r is Rectangle => !!r);
      const byRow = new Map<number, Cells>();
      for (const r of rects) {
        for (let y = r.y; y < r.y + r.height; y++) {
          const id = rowIds[y];
          if (id === undefined) continue;
          for (let x = r.x; x < r.x + r.width; x++) {
            const f = fields[x];
            if (!f || COMPUTED_TYPES.has(f.type)) continue;
            const cells = byRow.get(id) ?? {};
            cells[f.id] = null;
            byRow.set(id, cells);
          }
        }
      }
      write([...byRow].map(([id, cells]) => ({ id, cells })), false, "Clear");
      return false;
    },
    [client, tableId, rowIds, fields, write],
  );

  const cellRect = useCallback((col: number, row: number): DOMRect | null => {
    const b = ref.current?.getBounds(col, row);
    return b ? new DOMRect(b.x, b.y, b.width, b.height) : null;
  }, []);

  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      // Enter on a group header row collapses or expands it, like a click.
      const h = display?.[row];
      if (h?.kind === "header") return toggleGroup(h.path);
      const f = fields[col];
      const id = rowIds[row];
      if (!f || id === undefined) return;
      if (COMPUTED_TYPES.has(f.type) || !writable) {
        if (f.type !== "checkbox") handlers.onExpand(id);
        return;
      }
      if (POPOVER_TYPES.has(f.type)) {
        const rect = cellRect(col, row);
        if (rect) setEdit({ rowId: id, field: f, rect });
      }
    },
    [fields, rowIds, writable, handlers, cellRect, display, toggleGroup],
  );

  const onGridSelectionChange = useCallback(
    (sel: GridSelection) => {
      setSelection(sel);
      const cell = sel.current?.cell;
      if (cell) client.sendCursor(tableId, rowIds[cell[1]], fields[cell[0]]?.id);
    },
    [client, tableId, rowIds, fields],
  );

  const highlightRegions: Highlight[] = useMemo(() => {
    const out: Highlight[] = [];
    for (const p of client.presence) {
      if (p.tableId !== tableId || p.rowId === undefined || !p.fieldId) continue;
      const x = fields.findIndex(f => f.id === p.fieldId);
      const y = rowIds.indexOf(p.rowId);
      if (x >= 0 && y >= 0) out.push({ color: p.color, range: { x, y, width: 1, height: 1 }, style: "solid-outline" });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.presence, tableId, fields, rowIds]);

  const onHeaderMenuClick = useCallback(
    (col: number, b: Rectangle) => {
      const f = fields[col];
      if (!f) return;
      const anchor = new DOMRect(b.x, b.y, b.width, b.height);
      const primary = client.table(tableId)?.primaryFieldId === f.id;
      const sorts = view.config.sorts ?? [];
      setMenu({
        anchor,
        items: [
          { label: "Edit field", icon: "edit", disabled: !writable, onClick: () => handlers.onEditField(f.id, anchor) },
          ...(f.options.ai ? aiHeaderItems(client, tableId, f, writable, aiProblem(f)) : []),
          { label: "Insert left", icon: "plus", disabled: !writable || primary, onClick: () => handlers.onInsertField(anchor, { beforeFieldId: f.id }) },
          { label: "Insert right", icon: "plus", disabled: !writable, onClick: () => handlers.onInsertField(anchor, { afterFieldId: f.id }) },
          "sep",
          { label: "Sort first to last", icon: "sort", onClick: () => client.updateViewConfig(view.id, { sorts: [{ fieldId: f.id, dir: "asc" }, ...sorts.filter(s => s.fieldId !== f.id)] }) },
          { label: "Sort last to first", icon: "sort", onClick: () => client.updateViewConfig(view.id, { sorts: [{ fieldId: f.id, dir: "desc" }, ...sorts.filter(s => s.fieldId !== f.id)] }) },
          {
            label: "Filter by this field",
            icon: "filter",
            onClick: () => {
              const filters = view.config.filters ?? { conjunction: "and" as const, conditions: [] };
              client.updateViewConfig(view.id, { filters: { ...filters, conditions: [...filters.conditions, { fieldId: f.id, op: f.type === "checkbox" ? "eq" : "notempty" }] } });
              toast("Filter added. Adjust it from the Filter button.");
            },
          },
          { label: "Hide field", icon: "eye", disabled: primary, onClick: () => client.updateViewConfig(view.id, { hidden: [...(view.config.hidden ?? []), f.id] }) },
          ...(grouped
            ? ([
                "sep",
                ...summaryOptions(f).map(fn => ({ label: `Summary: ${SUMMARY_LABELS[fn]}`, icon: view.config.summaries?.[f.id] === fn ? "check" : "rollup", onClick: () => setSummary(f.id, fn) })),
                { label: "No summary", disabled: !view.config.summaries?.[f.id], onClick: () => setSummary(f.id, null) },
              ] as (MenuItem | "sep")[])
            : []),
          "sep",
          {
            label: "Delete field",
            icon: "trash",
            danger: true,
            disabled: !writable || primary,
            onClick: () => {
              if (!window.confirm(`Delete the field "${f.name}"? This cannot be undone.`)) return;
              client.schemaOp({ op: "deleteField", fieldId: f.id }).catch(e => toast(String(e.message ?? e), "error"));
            },
          },
        ],
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, client, tableId, view, writable, handlers, aiServices],
  );

  const onCellContextMenu = useCallback(
    ([col, row]: Item, e: { preventDefault: () => void; bounds: Rectangle; localEventX: number; localEventY: number }) => {
      e.preventDefault();
      const h = display?.[row];
      if (h?.kind === "header") {
        const anchor = new DOMRect(e.bounds.x + e.localEventX, e.bounds.y + e.localEventY, 0, 0);
        setMenu({
          anchor,
          items: [
            { label: collapsed.has(h.path) ? "Expand group" : "Collapse group", icon: "chevron", onClick: () => toggleGroup(h.path) },
            {
              label: "Add record to this group",
              icon: "plus",
              disabled: !writable,
              onClick: async () => {
                // Place it after the group's last record so it shows inside the group before the requery confirms it.
                const at = display!.indexOf(h);
                let afterId: number | undefined;
                for (let k = at + 1; k < display!.length; k++) {
                  const r = display![k]!;
                  if (r.kind === "header" && r.level <= h.level) break;
                  if (r.kind === "record") afterId = r.id;
                }
                const created = await client.createRows(tableId, [{ cells: groupCells(levelFields.slice(0, h.level + 1), h.keys) }], { afterId });
                if (created[0]) handlers.onExpand(created[0].id);
              },
            },
            "sep",
            { label: "Collapse all", onClick: () => { const all = new Set(display!.filter((r): r is HeaderRow => r.kind === "header").map(r => r.path)); saveCollapsed(view.id, all); setCollapsed(all); } },
            { label: "Expand all", onClick: () => { saveCollapsed(view.id, new Set()); setCollapsed(new Set()); } },
          ],
        });
        return;
      }
      const id = rowIds[row];
      if (id === undefined) return;
      const anchor = new DOMRect(e.bounds.x + e.localEventX, e.bounds.y + e.localEventY, 0, 0);
      const selectedRows = selection.rows.toArray().map(i => rowIds[i]).filter((x): x is number => x !== undefined);
      const targets = selectedRows.includes(id) ? selectedRows : [id];
      const aiField = fields[col]?.options.ai ? fields[col] : undefined;
      setMenu({
        anchor,
        items: [
          ...(aiField
            ? ([
                {
                  label: targets.length > 1 ? `Regenerate ${targets.length} records` : "Regenerate",
                  icon: "refresh",
                  disabled: !writable,
                  onClick: () => client.aiGenerate(tableId, aiField.id, { rowIds: targets }).catch(e => toast(String(e.message ?? e), "error")),
                },
                "sep",
              ] as (MenuItem | "sep")[])
            : []),
          { label: "Expand record", icon: "expand", onClick: () => handlers.onExpand(id) },
          "sep",
          { label: "Insert record above", icon: "plus", disabled: !writable, onClick: () => client.createRows(tableId, [{}], { beforeId: id }) },
          { label: "Insert record below", icon: "plus", disabled: !writable, onClick: () => client.createRows(tableId, [{}], { afterId: id }) },
          {
            label: "Duplicate record",
            icon: "copy",
            disabled: !writable,
            onClick: () => {
              const r = client.row(tableId, id);
              if (!r) return;
              const cells: Cells = {};
              for (const f of client.fields(tableId)) if (!COMPUTED_TYPES.has(f.type) && r.cells[f.id] !== undefined) cells[f.id] = r.cells[f.id];
              client.createRows(tableId, [{ cells }], { afterId: id });
            },
          },
          "sep",
          {
            label: targets.length > 1 ? `Delete ${targets.length} records` : "Delete record",
            icon: "trash",
            danger: true,
            disabled: !writable,
            onClick: () => {
              client.deleteRows(tableId, targets);
              toast(targets.length === 1 ? "Record deleted" : `${targets.length} records deleted`, "info", { label: "Undo", run: () => client.undo() });
            },
          },
        ],
      });
    },
    [rowIds, selection, client, tableId, writable, handlers, display, collapsed, toggleGroup, levelFields, view.id, fields],
  );

  const onColumnResize = useCallback(
    (col: GridColumn, w: number) => {
      if (!col.id) return;
      client.updateViewConfig(view.id, { widths: { ...(view.config.widths ?? {}), [col.id]: Math.round(w) } }, 500);
    },
    [client, view],
  );

  const onColumnMoved = useCallback(
    (from: number, to: number) => {
      if (from === 0 || to === 0) return;
      const order = client.orderedFields(view).map(f => f.id);
      const moving = fields[from].id, target = fields[to].id;
      const without = order.filter(id => id !== moving);
      const at = without.indexOf(target) + (to > from ? 1 : 0);
      without.splice(at, 0, moving);
      client.updateViewConfig(view.id, { fieldOrder: without });
    },
    [client, view, fields],
  );

  const onRowMoved = useCallback(
    (from: number, to: number) => {
      if (view.config.sorts?.length) {
        toast("Remove sorts to reorder records by dragging.");
        return;
      }
      const id = rowIds[from];
      if (id === undefined || !writable) return;
      if (!display) return void client.moveRow(view.id, id, to);
      const target = rowIds[to] ?? rowIds[to - 1];
      const keysOf = (x: number) => JSON.stringify(state?.groupKeys?.[ids.indexOf(x)] ?? []);
      if (target === undefined || keysOf(target) !== keysOf(id)) {
        toast("Drag records within their group. To move one to another group, change its grouped field.");
        return;
      }
      client.moveRow(view.id, id, ids.indexOf(target));
    },
    [view, rowIds, display, ids, state?.groupKeys, client, writable],
  );

  const onRowAppended = useCallback(() => {
    if (!writable) return;
    client.createRows(tableId, [{}]);
  }, [client, tableId, writable]);

  const onItemHovered = useCallback(
    (args: { kind: string; location: Item }) => {
      if (args.kind !== "cell" || args.location[1] < 0) return setHoverRow(null);
      const b = ref.current?.getBounds(0, args.location[1]);
      if (b) setHoverRow({ row: args.location[1], rect: b });
    },
    [],
  );

  const wrapRect = wrap.current?.getBoundingClientRect();
  const expandBtn = hoverRow && wrapRect && rowIds[hoverRow.row] !== undefined && (
    <button
      className="grid-expand"
      style={{ left: hoverRow.rect.x - wrapRect.left + hoverRow.rect.width - 26, top: hoverRow.rect.y - wrapRect.top + Math.min(hoverRow.rect.height, 34) / 2 - 11 }}
      onClick={() => handlers.onExpand(rowIds[hoverRow.row]!)}
      title="Expand record (Shift+Space)"
      aria-label="Expand record"
    >
      <Icon name="expand" size={13} />
    </button>
  );

  const editRow = edit ? client.row(tableId, edit.rowId) : undefined;

  return (
    <div
      className="grid-wrap"
      ref={wrap}
      onMouseLeave={() => setHoverRow(null)}
      onKeyDown={e => {
        if (e.key === " " && e.shiftKey && selection.current) {
          const id = rowIds[selection.current.cell[1]];
          if (id !== undefined) {
            e.preventDefault();
            handlers.onExpand(id);
          }
        }
      }}
    >
      {state?.error && <div className="grid-error">{state.error}</div>}
      <DataEditor
        ref={ref}
        width={size.w}
        height={size.h}
        columns={columns}
        getCellContent={getCellContent}
        rows={display ? display.length : Math.max(ids.length, state?.total ?? 0)}
        customRenderers={[chipsRenderer, groupHeaderRenderer, buttonRenderer, aiRenderer]}
        headerIcons={AI_HEADER_ICONS}
        getCellsForSelection={grouped ? cellsForSelection : true}
        getRowThemeOverride={display ? row => (display[row]?.kind === "header" ? { bgCell: "#f3f0ec", bgCellMedium: "#f3f0ec" } : undefined) : undefined}
        onCellClicked={onCellClicked}
        rowMarkers={grouped ? { kind: "checkbox", width: 36 } : { kind: "both", width: Math.max(44, String(ids.length).length * 9 + 24) }}
        theme={theme}
        rowHeight={rowHeight}
        headerHeight={34}
        freezeColumns={1}
        smoothScrollX
        smoothScrollY
        fillHandle={writable}
        rangeSelect="multi-rect"
        columnSelect="multi"
        rowSelect="multi"
        onPaste={onPaste}
        onCellEdited={onCellEdited}
        onCellsEdited={onCellsEdited}
        onDelete={clearSelection}
        onCellActivated={onCellActivated}
        gridSelection={selection}
        onGridSelectionChange={onGridSelectionChange}
        onVisibleRegionChanged={r => {
          lastRegion.current = r;
          onVisibleRegionChanged(r);
        }}
        highlightRegions={highlightRegions}
        onHeaderMenuClick={onHeaderMenuClick}
        onHeaderContextMenu={(col, e) => {
          e.preventDefault();
          onHeaderMenuClick(col, e.bounds);
        }}
        onCellContextMenu={onCellContextMenu}
        onColumnResize={onColumnResize}
        onColumnMoved={writable ? onColumnMoved : undefined}
        onRowMoved={writable && !view.config.sorts?.length ? onRowMoved : undefined}
        onItemHovered={onItemHovered}
        trailingRowOptions={writable ? { hint: "Add record", sticky: true, tint: true } : undefined}
        onRowAppended={writable ? onRowAppended : undefined}
        rightElement={
          writable ? (
            <button className="grid-add-col" onClick={e => handlers.onInsertField(e.currentTarget.getBoundingClientRect(), {})} aria-label="Add field">
              <Icon name="plus" />
            </button>
          ) : undefined
        }
        rightElementProps={{ sticky: false, fill: false }}
        keybindings={{ search: false, selectAll: true, downFill: true, rightFill: true }}
      />
      {expandBtn}
      {edit && editRow && (
        <Popover anchor={edit.rect} onClose={() => setEdit(null)} width={edit.field.type === "longText" ? 360 : 300} className="cell-popover">
          <FieldValueEditor
            field={edit.field}
            value={rawValue(edit.field, editRow)}
            autoFocus
            ctx={{ members: client.members, searchLinked: (t, q) => client.searchRecords(t, q), upload: f => client.uploadAttachment(f) }}
            onChange={(v, opts) => client.updateCells(tableId, [{ id: edit.rowId, cells: { [edit.field.id]: v } }], { typecast: opts?.typecast })}
            onDone={() => {
              setEdit(null);
              ref.current?.focus();
            }}
          />
        </Popover>
      )}
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Column title of an AI field while it has queued cells. */
function aiTitle(f: Field, p: AiProgress | undefined, problem: string | null): string {
  if (problem) return `${f.name} (needs attention)`;
  return p ? `${f.name} (${p.done.toLocaleString()} of ${p.total.toLocaleString()})` : f.name;
}

function aiHeaderItems(client: BaseClient, tableId: string, f: Field, writable: boolean, problem: string | null): (MenuItem | "sep")[] {
  const queued = (n: number) => toast(n ? `Queued ${n.toLocaleString()} record${n === 1 ? "" : "s"}` : "Nothing to generate");
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), "error");
  return [
    "sep",
    ...(problem ? [{ label: `${problem}. Cells wait until it is fixed.`, icon: "x", disabled: true, onClick: () => undefined } as MenuItem] : []),
    {
      label: "Regenerate all",
      icon: "refresh",
      disabled: !writable,
      onClick: () => {
        const n = client.table(tableId)?.rowCount ?? 0;
        if (!window.confirm(`Regenerate all ${n.toLocaleString()} records of "${f.name}"? Cells edited by hand are replaced too.`)) return;
        client.aiGenerate(tableId, f.id).then(r => queued(r.queued), fail);
      },
    },
    { label: "Generate missing", icon: "sparkle", disabled: !writable, onClick: () => client.aiGenerate(tableId, f.id, { missingOnly: true }).then(r => queued(r.queued), fail) },
    { label: "Stop generating", icon: "x", disabled: !writable || !client.aiProgress.has(f.id), onClick: () => client.aiStop(tableId, f.id).then(() => toast("Stopped"), fail) },
  ];
}
