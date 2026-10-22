// Client-side state for one open base: schema, a row cache per table, query results per view,
// realtime updates over WebSocket, optimistic edits and an undo / redo stack.
import { useSyncExternalStore } from "react";
import { get, post, type BaseInfo } from "../api";
import { toastError } from "../toast";
import { setLimitContext } from "../limits";
import type { Cells, Dashboard, Field, FieldOptions, FieldType, Member, Presence, Row, Schema, ServerMessage, Table, View, ViewConfig } from "../../shared/types";
import type { AiProgress } from "../../shared/ai";
import { COMPUTED_TYPES } from "../../shared/types";
import { displayCell } from "../../shared/cells";
import { validSummaries } from "./gridGroups";
import type { RowOp, SchemaOp } from "../../worker/base-do";
import type { AggregateInput, AggregateResult, GroupKey } from "../../worker/base/aggregate";

export interface ViewState {
  ids: number[];
  /** Row count of the view; larger than ids.length while the rest of the id list loads. */
  total?: number;
  groups?: (string | null)[];
  /** Grid grouping: per id, the key of each group level (JSON text for arrays), null when empty. */
  groupKeys?: (string | null)[][];
  /** Grid group summaries by group path (JSON of the key prefix), then field id. */
  summaries?: Map<string, Record<string, number | string | null>>;
  loading: boolean;
  error?: string;
}

interface MutationResult {
  changes: { tableId: string; rows: Row[] }[];
  deleted: { tableId: string; ids: number[] }[];
  schema?: Schema;
}

interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const FETCH_CHUNK = 500;

/** The browser's time zone, so dashboard day buckets match the clock people read. */
const localZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

export class BaseClient {
  info: BaseInfo;
  schema: Schema;
  members: Member[];
  readonly clientId = Math.random().toString(36).slice(2, 10);
  presence: Presence[] = [];
  connected = false;
  private rows = new Map<string, Map<number, Row>>();
  private inflight = new Map<string, Set<number>>();
  private views = new Map<string, ViewState>();
  private viewSeq = new Map<string, number>();
  private viewSearch = new Map<string, string>();
  private requeryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private dataListeners = new Set<(tableId: string) => void>();
  private autoListeners = new Set<() => void>();
  /** Button cells waiting for their automation ("fieldId:recordId"). */
  buttonBusy = new Set<string>();
  private version = 0;
  private ws?: WebSocket;
  private wsRetry = 0;
  private closed = false;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private viewSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Views whose local config has changes not yet confirmed by the server: change counter at the last edit. */
  private viewEdits = new Map<string, number>();
  private editSeq = 0;
  private viewRange = new Map<string, { from: string; to: string }>();
  private unscheduled = new Map<string, number[]>();

  constructor(info: BaseInfo) {
    this.info = info;
    setLimitContext(info.base.workspace_id, info.role);
    this.schema = info.schema;
    this.members = info.members;
  }

  static async open(baseId: string): Promise<BaseClient> {
    const info = await get<BaseInfo>(`/api/bases/${baseId}`);
    const c = new BaseClient(info);
    c.connect();
    return c;
  }

  get baseId() {
    return this.info.base.id;
  }
  get writable() {
    return this.info.writable;
  }

  // ---------- subscription ----------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  // ---------- schema helpers ----------

  table(id: string): Table | undefined {
    return this.schema.tables.find(t => t.id === id);
  }
  fields(tableId: string): Field[] {
    return this.schema.fields.filter(f => f.tableId === tableId);
  }
  field(id: string): Field | undefined {
    return this.schema.fields.find(f => f.id === id);
  }
  view(id: string): View | undefined {
    return this.schema.views.find(v => v.id === id);
  }
  viewsOf(tableId: string): View[] {
    return this.schema.views.filter(v => v.tableId === tableId).sort((a, b) => (a.ord < b.ord ? -1 : 1));
  }
  /** Fields in the view's order, primary first. Includes hidden fields. */
  orderedFields(view: View): Field[] {
    const t = this.table(view.tableId);
    const list = this.fields(view.tableId);
    const order = view.config.fieldOrder ?? [];
    const pos = new Map(order.map((id, i) => [id, i]));
    return [...list].sort((a, b) => {
      if (a.id === t?.primaryFieldId) return -1;
      if (b.id === t?.primaryFieldId) return 1;
      const pa = pos.get(a.id), pb = pos.get(b.id);
      if (pa !== undefined && pb !== undefined) return pa - pb;
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return a.ord < b.ord ? -1 : 1;
    });
  }
  visibleFields(view: View): Field[] {
    const hidden = new Set(view.config.hidden ?? []);
    const primary = this.table(view.tableId)?.primaryFieldId;
    return this.orderedFields(view).filter(f => f.id === primary || !hidden.has(f.id));
  }
  memberName(id: string): string {
    if (id.startsWith("auto:")) return "Automation";
    return this.members.find(m => m.id === id)?.name ?? "Unknown";
  }

  // ---------- rows ----------

  private cache(tableId: string): Map<number, Row> {
    let m = this.rows.get(tableId);
    if (!m) this.rows.set(tableId, (m = new Map()));
    return m;
  }

  row(tableId: string, id: number): Row | undefined {
    return this.rows.get(tableId)?.get(id);
  }

  private putRows(tableId: string, rows: Row[]) {
    const m = this.cache(tableId);
    for (const r of rows) m.set(r.id, r);
    this.touchRows(tableId);
  }

  private rowsVersion = new Map<string, number>();
  private touchRows(tableId: string) {
    this.rowsVersion.set(tableId, (this.rowsVersion.get(tableId) ?? 0) + 1);
  }
  /** Changes whenever a cached row of the table changes, so views can skip work on other updates (presence, cursors). */
  dataVersion(tableId: string): number {
    return this.rowsVersion.get(tableId) ?? 0;
  }

  viewState(viewId: string): ViewState | undefined {
    return this.views.get(viewId);
  }

  async queryView(viewId: string, search = this.viewSearch.get(viewId) ?? "") {
    const view = this.view(viewId);
    if (!view) return;
    this.viewSearch.set(viewId, search);
    const dated = view.type === "calendar" || view.type === "timeline";
    const range = this.viewRange.get(viewId);
    const seq = (this.viewSeq.get(viewId) ?? 0) + 1;
    this.viewSeq.set(viewId, seq);
    const prev = this.views.get(viewId);
    if (dated && (!range || !view.config.dateFieldId)) {
      this.views.set(viewId, { ids: [], loading: false });
      this.emit();
      return;
    }
    const grouped = view.type === "grid" && !!view.config.groups?.length;
    this.views.set(viewId, { ...(prev ?? { ids: [] }), loading: true, error: undefined });
    this.emit();
    const body = {
      tableId: view.tableId,
      viewId,
      search,
      limit: dated ? 2000 : view.type === "kanban" ? 600 : 150,
      dayOffset: grouped ? -new Date().getTimezoneOffset() : undefined,
      range: dated ? { startFieldId: view.config.dateFieldId, endFieldId: view.config.endDateFieldId, durationFieldId: view.type === "timeline" ? view.config.durationFieldId : undefined, ...range } : undefined,
    };
    type Res = { ids: number[]; rows: Row[]; groups?: (string | null)[]; groupKeys?: (string | null)[][]; total: number; partial?: boolean };
    try {
      // First paint: only the first ids of a manually ordered view, then the full list.
      const fast = view.type === "grid" && !grouped && !prev && !search && !view.config.filters?.conditions.length && !view.config.sorts?.length;
      if (fast) {
        const first = await post<Res>(`/api/bases/${this.baseId}/query`, { ...body, idsLimit: 300 });
        if (this.viewSeq.get(viewId) !== seq) return;
        this.putRows(view.tableId, first.rows);
        this.views.set(viewId, { ids: first.ids, total: first.total, loading: !!first.partial });
        this.emit();
        if (!first.partial) return;
      }
      const res = await post<Res>(`/api/bases/${this.baseId}/query`, { ...body, limit: fast ? 0 : body.limit });
      if (this.viewSeq.get(viewId) !== seq) return;
      this.putRows(view.tableId, res.rows);
      this.views.set(viewId, { ids: res.ids, groups: res.groups, groupKeys: res.groupKeys, summaries: grouped ? prev?.summaries : undefined, total: res.total, loading: false });
      if (grouped) void this.loadSummaries(viewId, seq);
      if (dated) void this.loadUnscheduled(viewId);
    } catch (e) {
      if (this.viewSeq.get(viewId) !== seq) return;
      this.views.set(viewId, { ids: prev?.ids ?? [], loading: false, error: e instanceof Error ? e.message : String(e) });
    }
    this.emit();
  }

  /** Calendar and timeline: the date window to load; queries only when the window or search changed. */
  setViewRange(viewId: string, from: string, to: string, search = "") {
    const cur = this.viewRange.get(viewId);
    if (cur?.from === from && cur.to === to && this.viewSearch.get(viewId) === search && this.views.has(viewId)) return;
    this.viewRange.set(viewId, { from, to });
    this.queryView(viewId, search);
  }

  /** Records of a calendar or timeline view that have no start date (first 200). */
  unscheduledIds(viewId: string): number[] {
    return this.unscheduled.get(viewId) ?? [];
  }

  private async loadUnscheduled(viewId: string) {
    const v = this.view(viewId);
    if (!v?.config.dateFieldId) return;
    try {
      const res = await post<{ ids: number[]; rows: Row[] }>(`/api/bases/${this.baseId}/query`, {
        tableId: v.tableId,
        viewId,
        search: this.viewSearch.get(viewId) ?? "",
        extraFilters: { conjunction: "and", conditions: [{ fieldId: v.config.dateFieldId, op: "empty" }] },
        limit: 200,
      });
      this.putRows(v.tableId, res.rows);
      this.unscheduled.set(viewId, res.ids.slice(0, 200));
      this.emit();
    } catch {
      // The main query reports errors; the sidebar just stays empty.
    }
  }

  /** Grid group summaries: one aggregate per level, keyed like the header paths. */
  private async loadSummaries(viewId: string, seq: number) {
    const v = this.view(viewId);
    const levels = v?.config.groups ?? [];
    const entries = Object.entries(v ? validSummaries(this.fields(v.tableId), v.config.summaries ?? {}) : {});
    if (!v || !levels.length || !entries.length) return;
    const metrics = entries.map(([fieldId, fn]) => ({ fn, fieldId, as: fieldId }));
    try {
      const map = new Map<string, Record<string, number | string | null>>();
      // One request per level, all at once.
      const results = await Promise.all(
        levels.map((_, i) =>
          post<{ groups: { key: (string | null)[]; values: Record<string, number | string | null> }[] }>(`/api/bases/${this.baseId}/aggregate`, {
            tableId: v.tableId,
            viewId,
            search: this.viewSearch.get(viewId) ?? "",
            groupBy: levels.slice(0, i + 1).map(g => ({ fieldId: g.fieldId })),
            fanOut: false,
            dayOffset: -new Date().getTimezoneOffset(),
            metrics,
          }),
        ),
      );
      for (const res of results) for (const g of res.groups) map.set(JSON.stringify(g.key), g.values);
      if (this.viewSeq.get(viewId) !== seq) return;
      const st = this.views.get(viewId);
      if (st) this.views.set(viewId, { ...st, summaries: map });
      this.emit();
    } catch (e) {
      toastError(e);
    }
  }

  /** Views on screen; only they are queried again after changes (the others query when they are opened). */
  private shown = new Map<string, number>();

  /** Marks a view as on screen until the returned function is called. */
  showView(viewId: string): () => void {
    this.shown.set(viewId, (this.shown.get(viewId) ?? 0) + 1);
    return () => {
      const n = (this.shown.get(viewId) ?? 1) - 1;
      if (n > 0) this.shown.set(viewId, n);
      else this.shown.delete(viewId);
    };
  }

  private scheduleRequery(tableId: string, delay = 250) {
    for (const [viewId] of this.views) {
      const v = this.view(viewId);
      if (!v || v.tableId !== tableId || !this.shown.has(viewId)) continue;
      clearTimeout(this.requeryTimers.get(viewId));
      this.requeryTimers.set(viewId, setTimeout(() => this.queryView(viewId), delay));
    }
  }

  /** Fetches rows that are not cached yet; safe to call on every scroll. */
  ensureRows(tableId: string, ids: number[]) {
    const m = this.cache(tableId);
    let flying = this.inflight.get(tableId);
    if (!flying) this.inflight.set(tableId, (flying = new Set()));
    const need = ids.filter(id => !m.has(id) && !flying!.has(id));
    if (!need.length) return;
    for (const id of need) flying.add(id);
    for (let i = 0; i < need.length; i += FETCH_CHUNK) {
      const chunk = need.slice(i, i + FETCH_CHUNK);
      post<Row[]>(`/api/bases/${this.baseId}/rows/get`, { tableId, ids: chunk })
        .then(rows => {
          this.putRows(tableId, rows);
          this.emit();
        })
        .catch(toastError)
        .finally(() => chunk.forEach(id => flying!.delete(id)));
    }
  }

  private applyResult(res: MutationResult) {
    for (const ch of res.changes) this.putRows(ch.tableId, ch.rows);
    for (const d of res.deleted) this.removeIds(d.tableId, d.ids);
    if (res.schema) this.schema = res.schema;
    this.emit();
    for (const t of new Set([...res.changes.map(c => c.tableId), ...res.deleted.map(d => d.tableId)])) this.dataChanged(t);
  }

  /** Called with a table id whenever rows of that table change: anyone's writes, recomputes, reloads. */
  onData(fn: (tableId: string) => void): () => void {
    this.dataListeners.add(fn);
    return () => {
      this.dataListeners.delete(fn);
    };
  }

  /** Called when automations of this base change (editors refetch their list). */
  onAutomations(fn: () => void): () => void {
    this.autoListeners.add(fn);
    return () => {
      this.autoListeners.delete(fn);
    };
  }

  private dataChanged(tableId: string) {
    for (const l of this.dataListeners) l(tableId);
  }

  dashboards(): Dashboard[] {
    return [...(this.schema.dashboards ?? [])].sort((a, b) => (a.ord < b.ord ? -1 : 1));
  }

  dashboard(id: string): Dashboard | undefined {
    return this.schema.dashboards?.find(d => d.id === id);
  }

  aggregate(tableId: string, input: AggregateInput): Promise<AggregateResult> {
    return post<AggregateResult>(`/api/bases/${this.baseId}/aggregate`, { tz: localZone(), ...input, tableId });
  }

  aggregateRecords(tableId: string, input: AggregateInput, key: GroupKey[]): Promise<{ ids: number[]; truncated: boolean }> {
    return post(`/api/bases/${this.baseId}/aggregate/records`, { tz: localZone(), ...input, tableId, key });
  }

  private removeIds(tableId: string, ids: number[]) {
    const gone = new Set(ids);
    const m = this.cache(tableId);
    for (const id of ids) m.delete(id);
    this.touchRows(tableId);
    for (const [viewId, st] of this.views) {
      if (this.view(viewId)?.tableId !== tableId) continue;
      const keep = st.ids.map((id, i) => [id, i] as const).filter(([id]) => !gone.has(id));
      this.views.set(viewId, {
        ...st,
        ids: keep.map(([id]) => id),
        total: st.total === undefined ? undefined : st.total - (st.ids.length - keep.length),
        groups: st.groups ? keep.map(([, i]) => st.groups![i]) : undefined,
        groupKeys: st.groupKeys ? keep.map(([, i]) => st.groupKeys![i]!) : undefined,
      });
    }
  }

  private async rowOp(op: RowOp): Promise<MutationResult> {
    const res = await post<MutationResult>(`/api/bases/${this.baseId}/rows`, { ...op, clientId: this.clientId });
    this.applyResult(res);
    // Own writes are not echoed back; grouped grids must requery to move rows between groups and refresh summaries.
    for (const [viewId] of this.views) {
      const v = this.view(viewId);
      if (v?.tableId === op.tableId && v.type === "grid" && v.config.groups?.length) {
        clearTimeout(this.requeryTimers.get(viewId));
        this.requeryTimers.set(viewId, setTimeout(() => this.queryView(viewId), 250));
      }
    }
    return res;
  }

  private pushUndo(entry: UndoEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Edits cells. Values must already be in stored form unless typecast is set (paste, CSV),
   * in which case the server converts them and the cache waits for its answer.
   */
  async updateCells(tableId: string, updates: { id: number; cells: Cells }[], opts: { typecast?: boolean; undo?: boolean; label?: string } = {}) {
    if (!updates.length) return;
    const m = this.cache(tableId);
    const before = updates.map(u => {
      const r = m.get(u.id);
      const cells: Cells = {};
      for (const k of Object.keys(u.cells)) cells[k] = r?.cells[k] ?? null;
      return { id: u.id, cells };
    });
    if (!opts.typecast) {
      for (const u of updates) {
        const r = m.get(u.id);
        if (!r) continue;
        const cells = { ...r.cells };
        for (const [k, v] of Object.entries(u.cells)) {
          if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete cells[k];
          else cells[k] = v;
        }
        m.set(u.id, { ...r, cells });
      }
      this.touchRows(tableId);
      this.emit();
    }
    try {
      const res = await this.rowOp({ op: "update", tableId, updates, typecast: opts.typecast });
      if (opts.undo !== false) {
        const changed = res.changes.find(c => c.tableId === tableId)?.rows ?? [];
        const after = updates.map(u => {
          const r = changed.find(x => x.id === u.id);
          const cells: Cells = {};
          for (const k of Object.keys(u.cells)) cells[k] = r ? r.cells[k] ?? null : u.cells[k];
          return { id: u.id, cells };
        });
        this.pushUndo({
          label: opts.label ?? "Edit",
          undo: () => this.updateCells(tableId, before, { undo: false }),
          redo: () => this.updateCells(tableId, after, { undo: false }),
        });
      }
    } catch (e) {
      for (const b of before) {
        const r = m.get(b.id);
        if (r) m.set(b.id, { ...r, cells: { ...r.cells, ...Object.fromEntries(Object.entries(b.cells).filter(([, v]) => v !== null)) } });
      }
      this.touchRows(tableId);
      this.emit();
      toastError(e);
    }
  }

  /** Creates rows and places them in open views right after `afterId` (or at the end). */
  async createRows(tableId: string, rows: { cells?: Cells }[], opts: { afterId?: number; beforeId?: number; typecast?: boolean; undo?: boolean } = {}): Promise<Row[]> {
    try {
      const res = await this.rowOp({ op: "create", tableId, rows, afterId: opts.afterId, beforeId: opts.beforeId, typecast: opts.typecast });
      const created = (res.changes.find(c => c.tableId === tableId)?.rows ?? []).filter(r => !this.knownIds(tableId).has(r.id)).slice(0, rows.length);
      this.insertIds(tableId, created.map(r => r.id), opts.afterId ?? null, opts.beforeId ?? null);
      if (opts.undo !== false && created.length) {
        const snapshot = created.map(r => ({ id: r.id, ord: r.ord, createdAt: r.createdAt, cells: this.writableCells(tableId, r.cells) }));
        this.pushUndo({
          label: "Create",
          undo: () => this.deleteRows(tableId, snapshot.map(r => r.id), { undo: false }),
          redo: () => this.restoreRows(tableId, snapshot),
        });
      }
      this.emit();
      return created;
    } catch (e) {
      toastError(e);
      return [];
    }
  }

  private knownIds(tableId: string): Set<number> {
    const s = new Set<number>();
    for (const [viewId, st] of this.views) if (this.view(viewId)?.tableId === tableId) for (const id of st.ids) s.add(id);
    return s;
  }

  private insertIds(tableId: string, ids: number[], afterId: number | null, beforeId: number | null) {
    for (const [viewId, st] of this.views) {
      if (this.view(viewId)?.tableId !== tableId) continue;
      const list = st.ids.filter(id => !ids.includes(id));
      let at = list.length;
      if (afterId !== null && list.includes(afterId)) at = list.indexOf(afterId) + 1;
      else if (beforeId !== null && list.includes(beforeId)) at = list.indexOf(beforeId);
      list.splice(at, 0, ...ids);
      const groups = st.groups ? [...st.groups] : undefined;
      if (groups) groups.splice(at, 0, ...ids.map(() => null));
      const groupKeys = st.groupKeys ? [...st.groupKeys] : undefined;
      if (groupKeys) groupKeys.splice(at, 0, ...ids.map(() => (groupKeys[at - 1] ?? groupKeys[at] ?? []).slice()));
      this.views.set(viewId, { ...st, ids: list, total: st.total === undefined ? undefined : st.total + (list.length - st.ids.length), groups, groupKeys });
    }
  }

  private writableCells(tableId: string, cells: Cells): Cells {
    const out: Cells = {};
    for (const f of this.fields(tableId)) if (!COMPUTED_TYPES.has(f.type) && cells[f.id] !== undefined) out[f.id] = cells[f.id];
    return out;
  }

  private async restoreRows(tableId: string, rows: { id: number; ord: string; createdAt: number; cells: Cells }[]) {
    const res = await this.rowOp({ op: "create", tableId, rows: rows.map(r => ({ id: r.id, ord: r.ord, createdAt: r.createdAt, cells: r.cells })) });
    void res;
    this.scheduleRequery(tableId, 0);
  }

  async deleteRows(tableId: string, ids: number[], opts: { undo?: boolean } = {}) {
    if (!ids.length) return;
    const m = this.cache(tableId);
    const snapshot = ids.map(id => m.get(id)).filter((r): r is Row => !!r).map(r => ({ id: r.id, ord: r.ord, createdAt: r.createdAt, cells: this.writableCells(tableId, r.cells) }));
    this.removeIds(tableId, ids);
    this.emit();
    try {
      await this.rowOp({ op: "delete", tableId, ids });
      if (opts.undo !== false && snapshot.length) {
        this.pushUndo({
          label: ids.length === 1 ? "Delete record" : `Delete ${ids.length} records`,
          undo: () => this.restoreRows(tableId, snapshot),
          redo: () => this.deleteRows(tableId, ids, { undo: false }),
        });
      }
    } catch (e) {
      toastError(e);
      this.scheduleRequery(tableId, 0);
    }
  }

  async moveRow(viewId: string, id: number, toIndex: number) {
    const v = this.view(viewId);
    const st = this.views.get(viewId);
    if (!v || !st) return;
    const from = st.ids.indexOf(id);
    if (from < 0) return;
    const list = st.ids.filter(x => x !== id);
    list.splice(toIndex, 0, id);
    let groups = st.groups;
    if (groups) {
      groups = [...groups];
      const [g] = groups.splice(from, 1);
      groups.splice(toIndex, 0, g ?? null);
    }
    let groupKeys = st.groupKeys;
    if (groupKeys) {
      groupKeys = [...groupKeys];
      const [k] = groupKeys.splice(from, 1);
      groupKeys.splice(toIndex, 0, k ?? []);
    }
    const afterId = toIndex > 0 ? list[toIndex - 1] : null;
    const beforeId = toIndex < list.length - 1 ? list[toIndex + 1] : null;
    const prevAfter = from > 0 ? st.ids[from - 1] : null;
    const prevBefore = from < st.ids.length - 1 ? st.ids[from + 1] : null;
    this.views.set(viewId, { ...st, ids: list, groups, groupKeys });
    this.emit();
    try {
      await this.rowOp({ op: "move", tableId: v.tableId, id, afterId, beforeId });
      this.pushUndo({
        label: "Move",
        undo: async () => {
          await this.rowOp({ op: "move", tableId: v.tableId, id, afterId: prevAfter, beforeId: prevBefore });
          this.scheduleRequery(v.tableId, 0);
        },
        redo: async () => {
          await this.rowOp({ op: "move", tableId: v.tableId, id, afterId, beforeId });
          this.scheduleRequery(v.tableId, 0);
        },
      });
    } catch (e) {
      toastError(e);
      this.scheduleRequery(v.tableId, 0);
    }
  }

  async undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    try {
      await e.undo();
      this.redoStack.push(e);
    } catch (err) {
      toastError(err);
    }
  }

  async redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    try {
      await e.redo();
      this.undoStack.push(e);
    } catch (err) {
      toastError(err);
    }
  }

  /** Records of a table matching a search, for link pickers. */
  async searchRecords(tableId: string, search: string, limit = 50): Promise<{ id: number; t: string }[]> {
    const t = this.table(tableId);
    if (!t) return [];
    const res = await post<{ ids: number[]; rows: Row[] }>(`/api/bases/${this.baseId}/query`, { tableId, search, limit });
    this.putRows(tableId, res.rows);
    return res.rows.map(r => ({ id: r.id, t: primaryText(this, tableId, r) }));
  }

  async uploadAttachment(file: File) {
    const { uploadFile } = await import("../api");
    return uploadFile(`/api/bases/${this.baseId}/attachments`, file);
  }

  // ---------- schema ----------

  async schemaOp(op: SchemaOp): Promise<{ schema: Schema; id?: string }> {
    const res = await post<{ schema: Schema; id?: string }>(`/api/bases/${this.baseId}/schema`, { ...op, clientId: this.clientId });
    this.setSchema(res.schema);
    return res;
  }

  /** Optimistically updates a view's config; widths and similar are saved with a short delay. */
  updateViewConfig(viewId: string, patch: Partial<ViewConfig>, delay = 0) {
    const v = this.view(viewId);
    if (!v) return;
    const next = { ...v, config: { ...v.config, ...patch } };
    const requery = ["filters", "sorts", "groupFieldId", "groups", "summaries", "dateFieldId", "endDateFieldId", "durationFieldId"].some(k => k in patch);
    this.schema = { ...this.schema, views: this.schema.views.map(x => (x.id === viewId ? next : x)) };
    this.emit();
    if (requery) this.queryView(viewId);
    if (!this.writable) return;
    const edit = ++this.editSeq;
    this.viewEdits.set(viewId, edit);
    clearTimeout(this.viewSaveTimers.get(viewId));
    this.viewSaveTimers.set(
      viewId,
      setTimeout(() => {
        const current = this.view(viewId);
        if (!current) return;
        post(`/api/bases/${this.baseId}/schema`, { op: "updateView", viewId, patch: { config: current.config, replace: true }, clientId: this.clientId })
          .catch(toastError)
          .finally(() => {
            // Later edits keep the view marked until their own save settles.
            if (this.viewEdits.get(viewId) === edit) this.viewEdits.delete(viewId);
          });
      }, delay),
    );
  }

  private setSchema(schema: Schema) {
    // Echoes of earlier saves must not overwrite view settings changed since; keep the local config until saved.
    if (this.viewEdits.size) {
      const local = new Map(this.schema.views.map(v => [v.id, v.config]));
      schema = { ...schema, views: schema.views.map(v => (this.viewEdits.has(v.id) && local.has(v.id) ? { ...v, config: local.get(v.id)! } : v)) };
    }
    const before = new Map(this.schema.views.map(v => [v.id, viewQueryKey(v)]));
    const fieldsBefore = JSON.stringify(this.schema.fields.map(f => [f.id, f.type, f.options]));
    this.schema = schema;
    for (const [viewId] of this.views) {
      const v = this.view(viewId);
      if (!v) this.views.delete(viewId);
      else if (before.get(viewId) !== viewQueryKey(v)) this.queryView(viewId);
    }
    if (fieldsBefore !== JSON.stringify(schema.fields.map(f => [f.id, f.type, f.options]))) {
      // Field changes can rewrite cells (conversions, recomputes); refresh what is on screen.
      for (const t of schema.tables) this.scheduleRequery(t.id, 50);
    }
    this.emit();
  }

  // ---------- realtime ----------

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/bases/${this.baseId}/ws`);
    this.ws = ws;
    let ping: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      const reconnect = this.wsRetry > 0;
      this.wsRetry = 0;
      this.connected = true;
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25000);
      if (reconnect) {
        // Missed messages while offline: reload schema and every open view.
        get<BaseInfo>(`/api/bases/${this.baseId}`)
          .then(info => {
            this.members = info.members;
            this.rows.clear();
            this.setSchema(info.schema);
            for (const [viewId] of this.views) this.queryView(viewId);
            for (const t of info.schema.tables) this.dataChanged(t.id);
          })
          .catch(() => undefined);
      }
      this.emit();
    };
    ws.onmessage = ev => {
      let msg: ServerMessage | { type: "pong" };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onMessage(msg as ServerMessage);
    };
    ws.onclose = () => {
      clearInterval(ping);
      this.connected = false;
      this.emit();
      if (this.closed) return;
      const delay = Math.min(15000, 500 * 2 ** this.wsRetry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "rows": {
        const own = msg.clientId === this.clientId;
        if (own) return;
        this.putRows(msg.tableId, msg.rows);
        const known = this.knownIds(msg.tableId);
        const hasNew = msg.rows.some(r => !known.has(r.id));
        const filtered = [...this.views.keys()].some(id => {
          const v = this.view(id);
          return v?.tableId === msg.tableId && (v.config.filters?.conditions.length || v.config.sorts?.length || v.type === "kanban" || v.type === "calendar" || v.type === "timeline" || v.config.groups?.length || this.viewSearch.get(id));
        });
        if (hasNew || filtered) this.scheduleRequery(msg.tableId);
        this.emit();
        this.dataChanged(msg.tableId);
        return;
      }
      case "deleted":
        if (msg.clientId === this.clientId) return;
        this.removeIds(msg.tableId, msg.ids);
        this.emit();
        this.dataChanged(msg.tableId);
        return;
      case "reload":
        this.rows.delete(msg.tableId);
        this.touchRows(msg.tableId);
        this.scheduleRequery(msg.tableId, 100);
        this.dataChanged(msg.tableId);
        return;
      case "schema":
        if (msg.clientId === this.clientId && msg.schema.version <= this.schema.version) return;
        this.setSchema(msg.schema);
        return;
      case "automations":
        for (const l of this.autoListeners) l();
        return;
      case "jobs":
        this.schema = { ...this.schema, jobs: msg.jobs };
        this.emit();
        return;
      case "aiProgress":
        this.aiProgress = new Map(msg.progress.map(p => [p.fieldId, p]));
        this.emit();
        return;
      case "presence":
        this.presence = msg.users;
        this.emit();
        return;
      case "cursor":
        this.presence = this.presence.map(p => (p.sid === msg.user.sid ? msg.user : p));
        if (!this.presence.some(p => p.sid === msg.user.sid)) this.presence = [...this.presence, msg.user];
        this.emit();
        return;
    }
  }

  // ---------- AI fields ----------

  /** Fields with queued AI cells, by field id. */
  aiProgress = new Map<string, AiProgress>();

  aiGenerate(tableId: string, fieldId: string, input: { rowIds?: number[]; missingOnly?: boolean } = {}) {
    return post<{ queued: number }>(`/api/bases/${this.baseId}/tables/${tableId}/ai/${fieldId}/generate`, input);
  }

  aiStop(tableId: string, fieldId: string) {
    return post(`/api/bases/${this.baseId}/tables/${tableId}/ai/${fieldId}/stop`, {});
  }

  aiStatus(tableId: string, fieldId: string) {
    return get<{ queued: number; done: number; total: number; errors: { rowId: number; error: string }[]; missing: number; broken: string | null }>(`/api/bases/${this.baseId}/tables/${tableId}/ai/${fieldId}`);
  }

  aiPreview(tableId: string, rowId: number, field: { type: FieldType; options: FieldOptions }) {
    return post<{ answer: string; value: unknown; error?: string; prompt: string; cut: boolean }>(`/api/bases/${this.baseId}/ai/preview`, { tableId, rowId, field });
  }

  sendCursor(tableId?: string, rowId?: number, fieldId?: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "cursor", tableId, rowId, fieldId }));
  }
}

export function primaryText(client: BaseClient, tableId: string, row: Row): string {
  const t = client.table(tableId);
  const f = t && client.field(t.primaryFieldId);
  if (!f) return "";
  const v = f.type === "autonumber" ? row.id : f.type === "createdTime" ? row.createdAt : f.type === "modifiedTime" ? row.updatedAt : row.cells[f.id];
  return displayCell(f, v, { userName: id => client.memberName(id) });
}

function viewQueryKey(v: View): string {
  const c = v.config;
  return JSON.stringify([c.filters ?? null, c.sorts ?? null, v.type === "kanban" ? c.groupFieldId ?? null : null, v.type === "grid" ? [c.groups ?? null, c.summaries ?? null] : null, c.dateFieldId ?? null, c.endDateFieldId ?? null, c.durationFieldId ?? null]);
}

export function useBase(client: BaseClient): number {
  return useSyncExternalStore(client.subscribe, client.getVersion);
}
