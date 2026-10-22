// The base workspace: header, table tabs, view sidebar, toolbar and the active view.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dashboard, View, ViewType } from "../../shared/types";
import { BaseClient, useBase } from "./client";
import { ViewToolbar } from "./Toolbar";
import GridView, { type GridHandlers } from "./GridView";
import FieldDialog from "./FieldDialog";
import RecordModal from "./RecordModal";
import { ImportAirtable, ImportCsv } from "./Imports";
import { Avatar, Button, Icon, Logo, Menu, Spinner, type MenuItem } from "../ui";
import { Link, navigate } from "../router";
import { patch } from "../api";
import { toast, toastError } from "../toast";
import { listAutomations } from "../auto/api";
import "./base.css";

const KanbanView = lazy(() => import("./KanbanView"));
const FormView = lazy(() => import("./FormView"));
const GalleryView = lazy(() => import("./GalleryView"));
const CalendarView = lazy(() => import("./CalendarView"));
const TimelineView = lazy(() => import("./TimelineView"));
const DashboardPage = lazy(() => import("../dash/DashboardPage"));
const AutomationsPage = lazy(() => import("../auto/AutomationsPage"));

const VIEW_ICONS: Record<ViewType, string> = { grid: "grid", kanban: "kanban", form: "form", calendar: "calendar", timeline: "timeline", gallery: "gallery" };
const VIEW_LABELS: Record<ViewType, string> = { grid: "Grid", kanban: "Kanban", form: "Form", calendar: "Calendar", timeline: "Timeline", gallery: "Gallery" };

export default function BasePage({ baseId, tableId, viewId, dashboardId, automations, automationId }: { baseId: string; tableId?: string; viewId?: string; dashboardId?: string; automations?: boolean; automationId?: string }) {
  const [client, setClient] = useState<BaseClient | null>(null);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);

  useEffect(() => {
    let c: BaseClient | null = null;
    let cancelled = false;
    BaseClient.open(baseId)
      .then(x => {
        if (cancelled) return x.close();
        c = x;
        setClient(x);
        document.title = `${x.info.base.name} - Rowflare`;
      })
      .catch(e => setError({ status: e.status, message: e.message }));
    return () => {
      cancelled = true;
      c?.close();
    };
  }, [baseId]);

  if (error) {
    if (error.status === 401) {
      navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
      return null;
    }
    return (
      <div className="center-page">
        <div className="card" style={{ padding: 24, maxWidth: 420, textAlign: "center" }}>
          <h2>Cannot open this base</h2>
          <p className="muted">{error.message}</p>
          <Link to="/" className="btn">Back to bases</Link>
        </div>
      </div>
    );
  }
  if (!client) return <div className="center-page"><Spinner size={24} /></div>;
  return <BaseShell client={client} tableId={tableId} viewId={viewId} dashboardId={dashboardId} automations={automations} automationId={automationId} />;
}

function BaseShell({ client, tableId: tableParam, viewId: viewParam, dashboardId, automations, automationId }: { client: BaseClient; tableId?: string; viewId?: string; dashboardId?: string; automations?: boolean; automationId?: string }) {
  useBase(client);
  const schema = client.schema;
  const table = schema.tables.find(t => t.id === tableParam) ?? schema.tables[0];
  const views = table ? client.viewsOf(table.id) : [];
  const view = views.find(v => v.id === viewParam) ?? views[0];
  const dash = dashboardId ? client.dashboard(dashboardId) : undefined;
  const [dashRecord, setDashRecord] = useState<{ tableId: string; id: number } | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(() => {
    const r = Number(new URLSearchParams(location.search).get("record"));
    return Number.isInteger(r) && r > 0 ? r : null;
  });
  const [fieldDialog, setFieldDialog] = useState<{ anchor: DOMRect; fieldId?: string; position?: { afterFieldId?: string; beforeFieldId?: string } } | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement | DOMRect; items: (MenuItem | "sep")[] } | null>(null);
  const [dialog, setDialog] = useState<"csv" | "airtable" | null>(() => (new URLSearchParams(location.search).get("import") === "airtable" ? "airtable" : null));
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 900);
  const [baseName, setBaseName] = useState(client.info.base.name);

  // Keep the URL pointing at the current table and view.
  useEffect(() => {
    if (automations) return;
    if (dashboardId) {
      if (!dash) navigate(`/base/${client.baseId}`, { replace: true });
      return;
    }
    if (!table || !view) return;
    const want = `/base/${client.baseId}/${table.id}/${view.id}`;
    if (location.pathname !== want) navigate(want, { replace: true });
  }, [client.baseId, table, view, dashboardId, dash, automations]);

  useEffect(() => setSearch(""), [view?.id]);
  // Only the view on screen is queried again when its table changes.
  const onScreen = !automations && !dashboardId ? view?.id : undefined;
  useEffect(() => (onScreen ? client.showView(onScreen) : undefined), [client, onScreen]);
  const shownTable = useRef(table?.id);
  useEffect(() => {
    if (shownTable.current !== table?.id) setExpanded(null);
    shownTable.current = table?.id;
  }, [table?.id]);

  const [autoAlert, setAutoAlert] = useState(false);
  useEffect(() => {
    if (client.info.role === "viewer") return;
    const check = () => listAutomations(client.baseId).then(d => setAutoAlert(d.automations.some(a => !!a.disabledReason))).catch(() => undefined);
    check();
    return client.onAutomations(check);
  }, [client]);

  // Undo / redo outside of text inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]") && !t.closest(".gdg-wrapper")) return;
      if (document.querySelector("#portal .gdg-overlay-editor, .gdg-growing-entry")) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        client.undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        client.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);

  const handlers: GridHandlers = useMemo(
    () => ({
      onExpand: id => setExpanded(id),
      onEditField: (fieldId, anchor) => setFieldDialog({ anchor, fieldId }),
      onInsertField: (anchor, position) => setFieldDialog({ anchor, position }),
    }),
    [],
  );

  const go = useCallback((tId: string, vId?: string) => navigate(`/base/${client.baseId}/${tId}${vId ? "/" + vId : ""}`), [client.baseId]);

  const goDash = (id: string) => navigate(`/base/${client.baseId}/dash/${id}`);

  const addDashboard = () =>
    client
      .schemaOp({ op: "createDashboard", name: "Dashboard" })
      .then(r => r.id && goDash(r.id))
      .catch(toastError);

  const dashMenu = (anchor: HTMLElement, d: Dashboard) =>
    setMenu({
      anchor,
      items: [
        {
          label: "Rename dashboard",
          icon: "edit",
          disabled: !client.writable,
          onClick: () => {
            const name = window.prompt("Dashboard name", d.name);
            if (name?.trim()) client.schemaOp({ op: "updateDashboard", dashboardId: d.id, name }).catch(toastError);
          },
        },
        "sep",
        {
          label: "Delete dashboard",
          icon: "trash",
          danger: true,
          disabled: !client.writable,
          onClick: () => {
            if (!window.confirm(`Delete the dashboard "${d.name}"? Records are not deleted.`)) return;
            client.schemaOp({ op: "deleteDashboard", dashboardId: d.id }).then(() => go(schema.tables[0].id)).catch(toastError);
          },
        },
      ],
    });

  const addTable = async () => {
    try {
      const res = await client.schemaOp({ op: "createTable", name: "Table" });
      if (res.id) go(res.id);
    } catch (e) {
      toastError(e);
    }
  };

  const addView = async (type: ViewType) => {
    if (!table) return;
    const names: Record<ViewType, string> = { grid: "Grid view", kanban: "Kanban", form: "Form", calendar: "Calendar", timeline: "Timeline", gallery: "Gallery" };
    try {
      const res = await client.schemaOp({ op: "createView", tableId: table.id, view: { name: names[type], type } });
      if (res.id) go(table.id, res.id);
    } catch (e) {
      toastError(e);
    }
  };

  const tableMenu = (anchor: HTMLElement, tId: string) => {
    const t = schema.tables.find(x => x.id === tId)!;
    setMenu({
      anchor,
      items: [
        {
          label: "Rename table",
          icon: "edit",
          disabled: !client.writable,
          onClick: () => {
            const name = window.prompt("Table name", t.name);
            if (name?.trim()) client.schemaOp({ op: "updateTable", tableId: t.id, name }).catch(toastError);
          },
        },
        { label: "Export CSV", icon: "download", onClick: () => (location.href = `/api/bases/${client.baseId}/export.csv?tableId=${t.id}&name=${encodeURIComponent(t.name)}`) },
        "sep",
        {
          label: "Delete table",
          icon: "trash",
          danger: true,
          disabled: !client.writable || schema.tables.length <= 1,
          onClick: () => {
            if (!window.confirm(`Delete the table "${t.name}" and all of its records? This cannot be undone.`)) return;
            client.schemaOp({ op: "deleteTable", tableId: t.id }).then(() => go(schema.tables.find(x => x.id !== t.id)!.id)).catch(toastError);
          },
        },
      ],
    });
  };

  const viewMenu = (anchor: HTMLElement, v: View) =>
    setMenu({
      anchor,
      items: [
        {
          label: "Rename view",
          icon: "edit",
          disabled: !client.writable,
          onClick: () => {
            const name = window.prompt("View name", v.name);
            if (name?.trim()) client.schemaOp({ op: "updateView", viewId: v.id, patch: { name } }).catch(toastError);
          },
        },
        {
          label: "Duplicate view",
          icon: "copy",
          disabled: !client.writable,
          onClick: () => client.schemaOp({ op: "createView", tableId: v.tableId, view: { name: v.name + " copy", type: v.type, config: v.config } }).then(r => r.id && go(v.tableId, r.id)).catch(toastError),
        },
        "sep",
        {
          label: "Delete view",
          icon: "trash",
          danger: true,
          disabled: !client.writable || views.length <= 1,
          onClick: () => {
            if (!window.confirm(`Delete the view "${v.name}"? Records are not deleted.`)) return;
            client.schemaOp({ op: "deleteView", viewId: v.id }).then(() => go(v.tableId)).catch(toastError);
          },
        },
      ],
    });

  const others = client.presence.filter(p => p.userId !== client.info.me.id).reduce<typeof client.presence>((acc, p) => (acc.some(x => x.userId === p.userId) ? acc : [...acc, p]), []);
  const jobs = schema.jobs ?? [];

  return (
    <div className="base-page">
      <header className="base-header" style={{ ["--base-color" as string]: client.info.base.color }}>
        <Link to="/" className="icon-btn home-btn" aria-label="All bases"><Logo size={20} /></Link>
        <input
          className="base-name"
          value={baseName}
          disabled={!client.writable}
          onChange={e => setBaseName(e.target.value)}
          onBlur={() => {
            if (baseName.trim() && baseName !== client.info.base.name) {
              patch(`/api/bases/${client.baseId}`, { name: baseName.trim() }).then(() => (client.info.base.name = baseName.trim())).catch(toastError);
            }
          }}
          onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="Base name"
        />
        {!client.writable && <span className="badge">Read only</span>}
        <div className="grow" />
        {jobs.length > 0 && (
          <span className="job-pill" title={jobs.map(j => j.label).join(", ")}>
            <Spinner size={12} /> {jobs[0].label}{jobs[0].total > 0 ? ` ${Math.min(100, Math.round((jobs[0].done / jobs[0].total) * 100))}%` : ""}
          </span>
        )}
        <span className={"conn-dot" + (client.connected ? " on" : "")} title={client.connected ? "Live" : "Reconnecting"} />
        <div className="presence">
          {others.slice(0, 5).map(p => <Avatar key={p.sid} name={p.name} color={p.color} size={26} />)}
        </div>
        <button className="icon-btn" onClick={() => client.undo()} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
        <button className="icon-btn" onClick={() => client.redo()} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" /></button>
        {client.info.role !== "viewer" && (
          <Link to={`/base/${client.baseId}/automations`} className={"btn btn-sm auto-link" + (automations ? " active" : "")}>
            <Icon name="bolt" size={14} /> Automations
            {autoAlert && <span className="alert-dot" title="An automation was switched off after repeated failures" />}
          </Link>
        )}
        <Link to={`/settings/members?ws=${client.info.base.workspace_id}`} className="btn btn-sm">Share</Link>
      </header>

      <nav className="table-tabs" aria-label="Tables">
        {!dash && !automations && <button className="icon-btn sidebar-toggle" onClick={() => setSidebar(s => !s)} aria-label="Toggle views"><Icon name="menu" /></button>}
        {schema.tables.map(t => (
          <div key={t.id} className={"table-tab" + (!dash && !automations && t.id === table?.id ? " active" : "")}>
            <button onClick={() => go(t.id)} onContextMenu={e => { e.preventDefault(); tableMenu(e.currentTarget, t.id); }}>{t.name}</button>
            {!dash && !automations && t.id === table?.id && (
              <button className="tab-menu" onClick={e => tableMenu(e.currentTarget, t.id)} aria-label="Table options"><Icon name="chevron" size={12} /></button>
            )}
          </div>
        ))}
        {client.dashboards().map(d => (
          <div key={d.id} className={"table-tab dash-tab" + (d.id === dash?.id ? " active" : "")}>
            <button onClick={() => goDash(d.id)} onContextMenu={e => { e.preventDefault(); dashMenu(e.currentTarget, d); }}><Icon name="chart" size={13} /> {d.name}</button>
            {d.id === dash?.id && (
              <button className="tab-menu" onClick={e => dashMenu(e.currentTarget, d)} aria-label="Dashboard options"><Icon name="chevron" size={12} /></button>
            )}
          </div>
        ))}
        {client.writable && (
          <button
            className="table-add"
            onClick={e =>
              setMenu({
                anchor: e.currentTarget,
                items: [
                  { label: "New dashboard", icon: "chart", onClick: addDashboard },
                  { label: "Blank table", icon: "table", onClick: addTable },
                  { label: "Import CSV", icon: "upload", onClick: () => setDialog("csv") },
                  { label: "Import from Airtable", icon: "import", onClick: () => setDialog("airtable") },
                ],
              })
            }
          >
            <Icon name="plus" size={14} /> Add or import
          </button>
        )}
      </nav>

      {automations ? (
        <div className="base-body">
          <main className="view-main">
            <Suspense fallback={<div className="center-page"><Spinner /></div>}>
              <AutomationsPage client={client} automationId={automationId} />
            </Suspense>
          </main>
        </div>
      ) : dash ? (
        <div className="base-body">
          <main className="view-main">
            <Suspense fallback={<div className="center-page"><Spinner /></div>}>
              <DashboardPage key={dash.id} client={client} dashboard={dash} onExpand={(tableId, id) => setDashRecord({ tableId, id })} />
            </Suspense>
          </main>
        </div>
      ) : (
        <div className="base-body">
          {sidebar && table && (
            <aside className="view-sidebar">
              <div className="sidebar-title">Views</div>
              {views.map(v => (
                <div key={v.id} className={"view-item" + (v.id === view?.id ? " active" : "")}>
                  <button className="view-link" onClick={() => { go(v.tableId, v.id); if (window.innerWidth <= 900) setSidebar(false); }}>
                    <Icon name={VIEW_ICONS[v.type]} size={15} /> <span>{v.name}</span>
                  </button>
                  <button className="icon-btn view-menu" onClick={e => viewMenu(e.currentTarget, v)} aria-label="View options"><Icon name="dots" size={14} /></button>
                </div>
              ))}
              {client.writable && (
                <>
                  <div className="sidebar-title">Create</div>
                  {(["grid", "kanban", "calendar", "timeline", "gallery", "form"] as ViewType[]).map(t => (
                    <button key={t} className="view-create" onClick={() => addView(t)}>
                      <Icon name={VIEW_ICONS[t]} size={15} /> {VIEW_LABELS[t]} <Icon name="plus" size={13} className="push" />
                    </button>
                  ))}
                </>
              )}
            </aside>
          )}

          <main className="view-main">
            {view && table ? (
              <>
                {view.type !== "form" && <ViewToolbar
                  client={client}
                  view={view}
                  search={search}
                  setSearch={setSearch}
                  onAddRecord={async () => {
                    const created = await client.createRows(table.id, [{}]);
                    if (created[0]) setExpanded(created[0].id);
                  }}
                />}
                <div className="view-content">
                  <Suspense fallback={<div className="center-page"><Spinner /></div>}>
                    {view.type === "grid" && <GridView key={view.id} client={client} view={view} search={search} handlers={handlers} />}
                    {view.type === "kanban" && <KanbanView key={view.id} client={client} view={view} search={search} onExpand={setExpanded} />}
                    {view.type === "gallery" && <GalleryView key={view.id} client={client} view={view} search={search} onExpand={setExpanded} />}
                    {view.type === "calendar" && <CalendarView key={view.id} client={client} view={view} search={search} onExpand={setExpanded} />}
                    {view.type === "timeline" && <TimelineView key={view.id} client={client} view={view} search={search} onExpand={setExpanded} />}
                    {view.type === "form" && <FormView key={view.id} client={client} view={view} />}
                  </Suspense>
                </div>
              </>
            ) : (
              <div className="center-page"><Spinner /></div>
            )}
          </main>
        </div>
      )}

      {dashRecord && client.viewsOf(dashRecord.tableId)[0] && (
        <RecordModal client={client} view={client.viewsOf(dashRecord.tableId)[0]} rowId={dashRecord.id} onClose={() => setDashRecord(null)} onNavigate={id => setDashRecord({ ...dashRecord, id })} />
      )}
      {expanded !== null && view && <RecordModal client={client} view={view} rowId={expanded} onClose={() => setExpanded(null)} onNavigate={setExpanded} />}
      {fieldDialog && table && (
        <FieldDialog
          client={client}
          tableId={table.id}
          viewId={view?.id}
          anchor={fieldDialog.anchor}
          field={fieldDialog.fieldId ? client.field(fieldDialog.fieldId) : undefined}
          position={fieldDialog.position}
          onClose={() => setFieldDialog(null)}
        />
      )}
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog === "csv" && <ImportCsv client={client} onClose={() => setDialog(null)} />}
      {dialog === "airtable" && <ImportAirtable client={client} onClose={() => { setDialog(null); if (location.search) navigate(location.pathname, { replace: true }); }} />}
      <ToastOnJobs client={client} />
    </div>
  );
}

/** Tells the user when background work (imports, recomputes) finishes. */
function ToastOnJobs({ client }: { client: BaseClient }) {
  useBase(client);
  const count = client.schema.jobs?.length ?? 0;
  const [prev, setPrev] = useState(count);
  useEffect(() => {
    if (prev > 0 && count === 0) toast("Background update finished");
    setPrev(count);
  }, [count, prev]);
  return null;
}
