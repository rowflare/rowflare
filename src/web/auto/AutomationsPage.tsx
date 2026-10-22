// The automations of a base: the list, the flow editor with its settings panels, test runs and the run log.
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { RECORD_SOURCES, triggerTableId, type Automation, type AutomationConfig, type AutomationRun } from "../../shared/automations";
import { useBase, type BaseClient } from "../base/client";
import { navigate } from "../router";
import { Button, Icon, Menu, Modal, Spinner, type MenuItem } from "../ui";
import { toast, toastError } from "../toast";
import { automationOp, listAutomations, testRun, webhookUrl, type AutomationList } from "./api";
import { defaultTrigger, localZone, PRESETS, schemaLite, toDisplayConfig, toStoredConfig, TRIGGER_ICONS } from "./flow";
import { FlowEditor } from "./FlowEditor";
import { RunsPanel, StatusDot } from "./RunsPanel";
import "./auto.css";

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

export default function AutomationsPage({ client, automationId }: { client: BaseClient; automationId?: string }) {
  useBase(client);
  const [data, setData] = useState<AutomationList | null>(null);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: (MenuItem | "sep")[] } | null>(null);
  const narrow = useNarrow();
  // Answers to list requests that started before a local change are stale and dropped.
  const seq = useRef(0);
  const load = useCallback(() => {
    const at = ++seq.current;
    return listAutomations(client.baseId)
      .then(d => {
        if (at === seq.current) setData(d);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [client.baseId]);
  useEffect(() => {
    load();
    // Runs finish in the background; refresh last runs and the month's count while the page is open.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10_000);
    const off = client.onAutomations(() => void load());
    return () => {
      clearInterval(t);
      off();
    };
  }, [client, load]);
  const go = useCallback((id?: string, replace = false) => navigate(`/base/${client.baseId}/automations${id ? "/" + id : ""}`, { replace }), [client.baseId]);
  const selected = data?.automations.find(a => a.id === automationId) ?? null;
  useEffect(() => {
    if (data && !selected && data.automations.length && !narrow) go(data.automations[0].id, true);
  }, [data, selected, narrow, go]);
  const setList = (automations: Automation[]) => {
    seq.current++;
    setData(d => (d ? { ...d, automations } : d));
  };

  const create = async (name: string, config: AutomationConfig) => {
    try {
      const r = await automationOp(client.baseId, { op: "create", name, config: toStoredConfig(config, client.schema.fields) });
      // The new URL renders synchronously; the list must already hold the automation, or the page falls back to the first one.
      flushSync(() => setList(r.automations));
      go(r.id);
    } catch (e) {
      toastError(e);
    }
  };
  const newMenu = (anchor: HTMLElement) =>
    setMenu({
      anchor,
      items: [
        { label: "Blank automation", icon: "plus", onClick: () => create("New automation", { trigger: defaultTrigger("recordCreated", schemaLite(client.schema), localZone()), steps: [] }) },
        "sep",
        ...PRESETS.map(p => ({
          label: p.name,
          icon: "bolt",
          onClick: () => {
            const cfg = p.build(schemaLite(client.schema), localZone());
            if (cfg) create(p.name, cfg);
            else toast("No table in this base fits this template", "error");
          },
        })),
      ],
    });
  const toggle = (a: Automation, enabled: boolean) => automationOp(client.baseId, { op: "setEnabled", id: a.id, enabled }).then(r => setList(r.automations)).catch(toastError);

  if (error) return <div className="center-page"><p className="muted">{error}</p></div>;
  if (!data) return <div className="center-page"><Spinner /></div>;
  return (
    <div className={"auto-page" + (narrow ? " narrow" : "")}>
      <aside className="auto-list" aria-label="Automations">
        <div className="auto-list-head">
          <span className="auto-list-title">Automations</span>
          {!narrow && client.writable && <Button small icon="plus" onClick={e => newMenu(e.currentTarget)}>New</Button>}
        </div>
        {data.automations.length === 0 && <p className="muted small auto-list-empty">No automations yet. They run steps when records change, at set times, when an app calls a webhook, or when someone clicks a button.</p>}
        {data.automations.map(a => (
          <div key={a.id} className={"auto-item" + (a.id === selected?.id ? " active" : "") + (a.disabledReason ? " broken" : "")}>
            <button className="auto-item-main" onClick={() => go(a.id)}>
              <Icon name={TRIGGER_ICONS[a.config.trigger.type]} size={15} />
              <span className="auto-item-text">
                <span className="auto-item-name">{a.name}</span>
                <span className="muted small">{a.lastRun ? <><StatusDot status={a.lastRun.status} /> {timeAgo(a.lastRun.at)}</> : "Never ran"}</span>
              </span>
            </button>
            <label className="switch" title={a.enabled ? "On" : "Off"}>
              <input type="checkbox" checked={a.enabled} disabled={narrow || !(client.writable || (a.enabled && client.info.role !== "viewer"))} onChange={e => toggle(a, e.target.checked)} aria-label={`${a.name} on`} />
              <span />
            </label>
          </div>
        ))}
        <div className="auto-usage muted small">{data.usage.limit ? `${data.usage.used.toLocaleString()} of ${data.usage.limit.toLocaleString()} runs this month${data.usage.per === "workspace" ? " in this workspace" : ""}` : `${data.usage.used.toLocaleString()} runs this month`}</div>
      </aside>
      <section className="auto-main">
        {selected ? (
          <AutomationEditor
            key={selected.id}
            client={client}
            automation={selected}
            data={data}
            readOnly={narrow || !client.writable}
            onList={setList}
            onDeleted={() => {
              load();
              go(undefined, true);
            }}
          />
        ) : (
          <div className="center-page"><p className="muted">{data.automations.length ? "Choose an automation." : "Create an automation to get started."}</p></div>
        )}
      </section>
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function AutomationEditor({ client, automation, data, readOnly, onList, onDeleted }: { client: BaseClient; automation: Automation; data: AutomationList; readOnly: boolean; onList: (list: Automation[]) => void; onDeleted: () => void }) {
  const fields = client.schema.fields;
  const shown = () => toDisplayConfig(automation.config, fields);
  const [name, setName] = useState(automation.name);
  const [draft, setDraft] = useState<AutomationConfig>(shown);
  const [saved, setSaved] = useState(() => JSON.stringify([automation.name, shown()]));
  const dirty = JSON.stringify([name, draft]) !== saved;
  /** A cloud trial ended: editors can only switch automations off or delete them. */
  const [tab, setTab] = useState<"editor" | "runs">("editor");
  const [selected, setSelected] = useState("trigger");
  const [test, setTest] = useState<AutomationRun | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  // Someone else saved this automation: take their version unless there are local edits.
  useEffect(() => {
    if (dirty) return;
    setName(automation.name);
    setDraft(shown());
    setSaved(JSON.stringify([automation.name, shown()]));
  }, [automation.updatedAt]);

  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await automationOp(client.baseId, { op: "update", id: automation.id, name, config: toStoredConfig(draft, fields) });
      setSaved(JSON.stringify([name, draft]));
      onList(r.automations);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const startTest = async () => {
    if (dirty && !(await save())) return;
    setTesting(true);
  };
  const t = automation.config.trigger;
  const hookUrl = t.type === "webhook" ? webhookUrl(data.origin, client.baseId, t.token) : null;
  const items: (MenuItem | "sep")[] = [
    {
      label: "Duplicate",
      icon: "copy",
      onClick: () =>
        automationOp(client.baseId, { op: "create", name: `${name} copy`, config: toStoredConfig(draft, fields) })
          .then(r => {
            onList(r.automations);
            navigate(`/base/${client.baseId}/automations/${r.id}`);
          })
          .catch(toastError),
    },
    ...(t.type === "webhook"
      ? [{ label: "New webhook URL", icon: "link", onClick: () => window.confirm("Make a new webhook URL? The old URL stops working.") && automationOp(client.baseId, { op: "regenerateWebhook", id: automation.id }).then(r => onList(r.automations)).catch(toastError) } as MenuItem]
      : []),
    "sep",
    { label: "Delete automation", icon: "trash", danger: true, onClick: () => window.confirm(`Delete the automation "${automation.name}" and its run history?`) && automationOp(client.baseId, { op: "delete", id: automation.id }).then(onDeleted).catch(toastError) },
  ];
  return (
    <div className="auto-editor">
      <div className="auto-bar">
        <input className="auto-name" value={name} disabled={readOnly} onChange={e => setName(e.target.value)} aria-label="Automation name" />
        <div className="auto-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "editor"} className={tab === "editor" ? "active" : ""} onClick={() => setTab("editor")}>Editor</button>
          <button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>Runs</button>
        </div>
        <div className="grow" />
        {!readOnly && (
          <>
            <Button small icon="play" onClick={startTest} disabled={busy}>Test run</Button>
            <Button small variant="primary" onClick={save} disabled={!dirty || busy}>{busy && <Spinner size={12} />} Save</Button>
          </>
        )}
        {!readOnly && <button className="icon-btn" onClick={e => setMenu(e.currentTarget)} aria-label="Automation options"><Icon name="dots" /></button>}
      </div>
      {automation.disabledReason && <div className="auto-banner error">Switched off after 20 failed runs in a row. Check the run log, fix the cause, then switch it on again.</div>}
      {data.usage.limit > 0 && data.usage.used >= data.usage.limit && <div className="auto-banner">This {data.usage.per === "workspace" ? "workspace" : "base"} used its {data.usage.limit.toLocaleString()} automation runs for this month. New runs are skipped until next month.</div>}
      {!automation.enabled && !automation.disabledReason && !readOnly && <div className="auto-banner quiet">This automation is off. Switch it on in the list when it is ready.</div>}
      {tab === "editor" ? (
        <FlowEditor client={client} config={draft} onChange={setDraft} selected={selected} onSelect={setSelected} test={test} readOnly={readOnly} webhookUrl={hookUrl} />
      ) : (
        <RunsPanel client={client} automation={automation} />
      )}
      {testing && (
        <TestDialog
          client={client}
          automation={automation}
          onClose={() => setTesting(false)}
          onDone={run => {
            setTest(run);
            setTab("editor");
            toast(run.status === "succeeded" ? "Test run finished" : `Test run failed: ${run.error}`, run.status === "succeeded" ? "info" : "error");
          }}
        />
      )}
      {menu && <Menu anchor={menu} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function TestDialog({ client, automation, onClose, onDone }: { client: BaseClient; automation: Automation; onClose: () => void; onDone: (run: AutomationRun) => void }) {
  const t = automation.config.trigger;
  const tableId = RECORD_SOURCES.has(t.type) ? triggerTableId(t) : undefined;
  const [records, setRecords] = useState<{ id: number; t: string }[] | null>(tableId ? null : []);
  const [recordId, setRecordId] = useState<number | null>(null);
  const [body, setBody] = useState('{\n  "name": "Ada Lovelace",\n  "email": "ada@example.com"\n}');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!tableId) return;
    client.searchRecords(tableId, "", 50).then(r => {
      setRecords(r);
      setRecordId(r[0]?.id ?? null);
    }).catch(toastError);
  }, [client, tableId]);
  const run = async () => {
    let parsed: unknown;
    if (t.type === "webhook") {
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return toastError(new Error("The sample body is not valid JSON"));
      }
    }
    setBusy(true);
    try {
      onDone(await testRun(client.baseId, automation.id, { recordId: recordId ?? undefined, body: parsed }));
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Test run"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={run} disabled={busy || (!!tableId && recordId === null)}>{busy && <Spinner size={12} />} Run test</Button>
        </>
      }
    >
      <p className="auto-warn">Test runs make real changes: records are created or updated, requests are sent and emails go out. They do not start other automations and do not count toward the monthly limit.</p>
      {tableId &&
        (records === null ? (
          <Spinner />
        ) : records.length === 0 ? (
          <p className="muted">The table has no records to test with.</p>
        ) : (
          <label className="auto-field">
            <span className="auto-field-label">Record</span>
            <select className="input" value={recordId ?? ""} onChange={e => setRecordId(Number(e.target.value))}>
              {records.map(r => <option key={r.id} value={r.id}>{r.t || `Record ${r.id}`}</option>)}
            </select>
          </label>
        ))}
      {t.type === "webhook" && (
        <label className="auto-field">
          <span className="auto-field-label">Sample body (JSON)</span>
          <textarea className="input tpl-area mono" rows={6} value={body} onChange={e => setBody(e.target.value)} />
        </label>
      )}
    </Modal>
  );
}
