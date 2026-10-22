// Settings panels for the trigger and for each step type.
import { useEffect, useState, type ReactNode } from "react";
import type { AiServiceInfo } from "../../shared/ai";
import { listBaseServices } from "../ai/api";
import type { Field, FilterSpec } from "../../shared/types";
import { COMPUTED_TYPES } from "../../shared/types";
import { BRANCH_OPS, flatSteps, HTTP_METHODS, RECORD_SOURCES, TRIGGER_TYPES, triggerTableId, type AutomationConfig, type BranchCondition, type BranchOp, type DateTrigger, type ScheduleTrigger, type Step, type StepLog, type Trigger } from "../../shared/automations";
import { FilterEditor } from "../base/FilterEditor";
import type { BaseClient } from "../base/client";
import { Button, copyText, Icon } from "../ui";
import { BRANCH_LABELS, defaultTrigger, localZone, offsetText, scheduleText, schemaLite, STEP_LABELS, TRIGGER_LABELS, variablesFor, WEEKDAYS, withTable } from "./flow";
import { TemplateInput } from "./TemplateInput";
import { StepLogView } from "./RunsPanel";

const EMPTY: FilterSpec = { conjunction: "and", conditions: [] };
const usable = (fields: Field[]) => fields.filter(f => f.type !== "button");
const tzOf = (t: Trigger) => ("tz" in t ? t.tz : localZone());

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="auto-field">
      <span className="auto-field-label">{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

function TimeZoneSelect({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  const list = [...new Set(["UTC", localZone(), value, ...zones])];
  return (
    <select className="input" value={value} onChange={e => onChange(e.target.value)} aria-label="Time zone">
      {list.map(z => <option key={z} value={z}>{z}</option>)}
    </select>
  );
}

const clampInt = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

function ScheduleFields({ t, set }: { t: ScheduleTrigger; set: (t: Trigger) => void }) {
  const every = (v: ScheduleTrigger["every"]) =>
    set({ type: "schedule", every: v, at: t.at, tz: t.tz, ...(v === "hour" ? { interval: t.interval ?? 1 } : {}), ...(v === "week" ? { weekday: t.weekday ?? 1 } : {}), ...(v === "month" ? { monthday: t.monthday ?? 1 } : {}) });
  return (
    <>
      <Row label="Repeat">
        <select className="input" value={t.every} onChange={e => every(e.target.value as ScheduleTrigger["every"])}>
          <option value="hour">Every few hours</option>
          <option value="day">Every day</option>
          <option value="week">Every week</option>
          <option value="month">Every month</option>
        </select>
      </Row>
      {t.every === "hour" && <Row label="Hours between runs"><input className="input" type="number" min={1} max={24} value={t.interval ?? 1} onChange={e => set({ ...t, interval: clampInt(e.target.value, 1, 24) })} /></Row>}
      {t.every === "week" && (
        <Row label="Day">
          <select className="input" value={t.weekday ?? 1} onChange={e => set({ ...t, weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </Row>
      )}
      {t.every === "month" && <Row label="Day of the month" hint="Shorter months run on their last day."><input className="input" type="number" min={1} max={31} value={t.monthday ?? 1} onChange={e => set({ ...t, monthday: clampInt(e.target.value, 1, 31) })} /></Row>}
      <Row label={t.every === "hour" ? "Minutes past the hour (the hour part is ignored)" : "Time"}><input className="input" type="time" value={t.at} onChange={e => e.target.value && set({ ...t, at: e.target.value })} /></Row>
      <Row label="Time zone"><TimeZoneSelect value={t.tz} onChange={tz => set({ ...t, tz })} /></Row>
      <p className="muted small">{scheduleText(t)}</p>
    </>
  );
}

const UNITS: [string, number][] = [["minutes", 1], ["hours", 60], ["days", 1440]];

function DateFields({ t, set, fields }: { t: DateTrigger; set: (t: Trigger) => void; fields: Field[] }) {
  const abs = Math.abs(t.offsetMinutes);
  const unit = !abs || abs % 1440 === 0 ? 1440 : abs % 60 === 0 ? 60 : 1;
  const amount = abs / unit;
  const sign = t.offsetMinutes < 0 ? -1 : 1;
  const offset = (n: number, u: number, sg: number) => set({ ...t, offsetMinutes: Math.round(Math.max(0, n) * u) * sg });
  const dates = fields.filter(f => f.type === "date");
  return (
    <>
      <Row label="Date field">
        <select className="input" value={t.fieldId} onChange={e => set({ ...t, fieldId: e.target.value })}>
          {!dates.some(f => f.id === t.fieldId) && <option value="">Choose a date field</option>}
          {dates.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </Row>
      <Row label="When" hint={`${offsetText(t.offsetMinutes)} the date`}>
        <div className="auto-inline">
          <input className="input" type="number" min={0} value={amount} onChange={e => offset(Number(e.target.value) || 0, unit, sign)} aria-label="Amount" />
          <select className="input" value={unit} onChange={e => offset(amount, Number(e.target.value), sign)} aria-label="Unit">
            {UNITS.map(([l, u]) => <option key={u} value={u}>{l}</option>)}
          </select>
          <select className="input" value={sign} onChange={e => offset(amount, unit, Number(e.target.value))} aria-label="Before or after">
            <option value={-1}>before</option>
            <option value={1}>after</option>
          </select>
        </div>
      </Row>
      <Row label="Time for dates without a time"><input className="input" type="time" value={t.at ?? "09:00"} onChange={e => e.target.value && set({ ...t, at: e.target.value })} /></Row>
      <Row label="Time zone"><TimeZoneSelect value={t.tz} onChange={tz => set({ ...t, tz })} /></Row>
    </>
  );
}

export function TriggerPanel({ client, config, onChange, webhookUrl }: { client: BaseClient; config: AutomationConfig; onChange: (c: AutomationConfig) => void; webhookUrl: string | null }) {
  const s = schemaLite(client.schema);
  const t = config.trigger;
  const set = (next: Trigger) => onChange({ ...config, trigger: next });
  const tableId = triggerTableId(t);
  const fields = tableId ? usable(client.fields(tableId)) : [];
  return (
    <div className="auto-panel">
      <h3 className="auto-panel-title">Trigger</h3>
      <Row label="Run this automation">
        <select className="input" value={t.type} onChange={e => set(defaultTrigger(e.target.value as Trigger["type"], s, tzOf(t)))}>
          {TRIGGER_TYPES.map(x => <option key={x} value={x}>{TRIGGER_LABELS[x]}</option>)}
        </select>
      </Row>
      {tableId !== undefined && (
        <Row label="Table">
          <select className="input" value={tableId} onChange={e => set(withTable(t, e.target.value, s))}>
            {client.schema.tables.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Row>
      )}
      {t.type === "recordUpdated" && (
        <Row label="Only when one of these fields changes" hint="Leave all unchecked to run on any change.">
          <div className="auto-checks">
            {fields.map(f => (
              <label key={f.id} className="auto-check">
                <input type="checkbox" checked={!!t.fieldIds?.includes(f.id)} onChange={e => set({ ...t, fieldIds: e.target.checked ? [...(t.fieldIds ?? []), f.id] : (t.fieldIds ?? []).filter(x => x !== f.id) })} /> {f.name}
              </label>
            ))}
          </div>
        </Row>
      )}
      {(t.type === "recordCreated" || t.type === "recordUpdated" || t.type === "recordMatches" || t.type === "dateReached") && (
        <Row label={t.type === "recordMatches" ? "Conditions (runs when a record starts to match them)" : "Only records that match"}>
          <FilterEditor fields={fields} spec={t.conditions ?? EMPTY} onChange={spec => set({ ...t, conditions: spec } as Trigger)} emptyText={t.type === "recordMatches" ? "Add at least one condition." : "All records."} />
        </Row>
      )}
      {t.type === "schedule" && <ScheduleFields t={t} set={set} />}
      {t.type === "dateReached" && <DateFields t={t} set={set} fields={fields} />}
      {t.type === "webhook" &&
        (webhookUrl && t.token ? (
          <>
            <Row label="Webhook URL">
              <div className="auto-copy">
                <input className="input mono" readOnly value={webhookUrl} onFocus={e => e.target.select()} />
                <Button small onClick={() => copyText(webhookUrl)}>Copy</Button>
              </div>
            </Row>
            <p className="muted small">Send a POST request with a JSON or form body; steps can use its values, such as {"{{trigger.body.email}}"}. Anyone with this URL can start the automation; make a new URL from the menu if it leaks.</p>
            <pre className="auto-code">{`curl -X POST -H "Content-Type: application/json" \\\n  -d '{"email":"ada@example.com"}' \\\n  ${webhookUrl}`}</pre>
          </>
        ) : (
          <p className="muted small">Save the automation to get its webhook URL.</p>
        ))}
      {t.type === "button" && (
        <>
          <label className="auto-check"><input type="checkbox" checked={t.viewerCanRun} onChange={e => set({ ...t, viewerCanRun: e.target.checked })} /> Read-only members can run it</label>
          <p className="muted small">Add a field of type Button to this table and choose this automation in its settings.</p>
        </>
      )}
    </div>
  );
}

type Tpl = (value: string, set: (v: string) => void, opts?: { multiline?: boolean; placeholder?: string; label?: string }) => ReactNode;

function RecordStep({ client, config, step, onChange, tpl }: { client: BaseClient; config: AutomationConfig; step: Extract<Step, { type: "createRecord" | "updateRecords" }>; onChange: (s: Step) => void; tpl: Tpl }) {
  const fields = client.fields(step.tableId).filter(f => !COMPUTED_TYPES.has(f.type));
  const chosen = Object.keys(step.values);
  const flat = flatSteps(config.steps);
  const before = flat.slice(0, flat.findIndex(x => x.id === step.id));
  const sources: { value: string; label: string; tableId: string }[] =
    step.type === "updateRecords"
      ? [
          ...(RECORD_SOURCES.has(config.trigger.type) ? [{ value: "trigger", label: "The trigger record", tableId: triggerTableId(config.trigger)! }] : []),
          ...before.flatMap(x => (x.type === "findRecords" || x.type === "createRecord" ? [{ value: x.id, label: `Records from step ${x.id} (${STEP_LABELS[x.type]})`, tableId: x.tableId }] : [])),
        ]
      : [];
  return (
    <>
      {step.type === "createRecord" ? (
        <Row label="Table">
          <select className="input" value={step.tableId} onChange={e => onChange({ ...step, tableId: e.target.value, values: {} })}>
            {client.schema.tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Row>
      ) : (
        <Row label="Records to update" hint={sources.length ? undefined : "Add a Find records step first, or use a trigger that has a record."}>
          <select
            className="input"
            value={step.target}
            onChange={e => {
              const src = sources.find(x => x.value === e.target.value);
              if (src) onChange({ ...step, target: src.value, tableId: src.tableId, values: src.tableId === step.tableId ? step.values : {} });
            }}
          >
            {!sources.some(x => x.value === step.target) && <option value={step.target}>Choose</option>}
            {sources.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </Row>
      )}
      <div className="auto-field">
        <span className="auto-field-label">Field values</span>
        {chosen.map(fid => {
          const f = fields.find(x => x.id === fid);
          return (
            <div key={fid} className="auto-value">
              <span className="auto-value-name">{f?.name ?? "Deleted field"}</span>
              {tpl(step.values[fid], v => onChange({ ...step, values: { ...step.values, [fid]: v } }), { label: f?.name })}
              <button
                className="icon-btn"
                onClick={() => {
                  const rest = { ...step.values };
                  delete rest[fid];
                  onChange({ ...step, values: rest });
                }}
                aria-label="Remove field"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          );
        })}
        <select className="input" value="" onChange={e => e.target.value && onChange({ ...step, values: { ...step.values, [e.target.value]: "" } })} aria-label="Set a field">
          <option value="">Set a field...</option>
          {fields.filter(f => !chosen.includes(f.id)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <span className="muted small">Option and linked record names are matched, and created when missing. A value that is only a variable keeps its type, so {"{{trigger.record}}"} in a link field links the trigger record.</span>
      </div>
    </>
  );
}

function FindStep({ client, step, onChange }: { client: BaseClient; step: Extract<Step, { type: "findRecords" }>; onChange: (s: Step) => void }) {
  const fields = usable(client.fields(step.tableId));
  const sort = step.sort?.[0];
  return (
    <>
      <Row label="Table">
        <select className="input" value={step.tableId} onChange={e => onChange({ ...step, tableId: e.target.value, conditions: EMPTY, sort: undefined })}>
          {client.schema.tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Row>
      <Row label="Conditions" hint="Text values can use variables, such as {{trigger.body.email}}. A variable that comes out empty finds no records.">
        <FilterEditor fields={fields} spec={step.conditions ?? EMPTY} onChange={spec => onChange({ ...step, conditions: spec })} emptyText="All records." />
      </Row>
      <Row label="Sort">
        <div className="auto-inline">
          <select className="input" value={sort?.fieldId ?? ""} onChange={e => onChange({ ...step, sort: e.target.value ? [{ fieldId: e.target.value, dir: sort?.dir ?? "asc" }] : undefined })} aria-label="Sort field">
            <option value="">Table order</option>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {sort && (
            <select className="input" value={sort.dir} onChange={e => onChange({ ...step, sort: [{ fieldId: sort.fieldId, dir: e.target.value as "asc" | "desc" }] })} aria-label="Direction">
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          )}
        </div>
      </Row>
      <Row label="At most"><input className="input" type="number" min={1} max={100} value={step.limit} onChange={e => onChange({ ...step, limit: clampInt(e.target.value, 1, 100) })} /></Row>
    </>
  );
}

function AiStep({ client, step, onChange, tpl }: { client: BaseClient; step: Extract<Step, { type: "ai" }>; onChange: (s: Step) => void; tpl: Tpl }) {
  const [services, setServices] = useState<AiServiceInfo[] | null>(null);
  useEffect(() => {
    listBaseServices(client.baseId)
      .then(r => {
        setServices(r.services);
        if (!step.serviceId && r.services[0]) onChange({ ...step, serviceId: r.services[0].id });
      })
      .catch(() => setServices([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.baseId]);
  const service = services?.find(s => s.id === step.serviceId);
  return (
    <>
      <Row label="Service" hint={<>AI services are set up by a workspace owner in <a href={`/settings/ai?ws=${client.info.base.workspace_id}`}>Settings, AI services</a>.</>}>
        <select className="input" value={step.serviceId} onChange={e => onChange({ ...step, serviceId: e.target.value })}>
          {services && !service && <option value={step.serviceId}>Choose a service</option>}
          {services?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Row>
      <Row label="Model">
        <input className="input" value={step.model ?? ""} onChange={e => onChange({ ...step, model: e.target.value || undefined })} placeholder={service ? `Default: ${service.model}` : "Default model"} />
      </Row>
      <Row label="Prompt">{tpl(step.prompt, prompt => onChange({ ...step, prompt }), { multiline: true, placeholder: "Write a friendly welcome email for {{trigger.record.Name}}.", label: "Prompt" })}</Row>
      <Row label="Answer" hint={step.output === "json" ? `Ask for the keys you need; later steps use {{steps.${step.id}.json.key}}.` : `Later steps use {{steps.${step.id}.text}}.`}>
        <select className="input" value={step.output} onChange={e => onChange({ ...step, output: e.target.value as "text" | "json" })}>
          <option value="text">Text</option>
          <option value="json">JSON object</option>
        </select>
      </Row>
    </>
  );
}

export function StepPanel({ client, config, step, log, onChange, onMove, onRemove }: { client: BaseClient; config: AutomationConfig; step: Step; log?: StepLog; onChange: (s: Step) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  const vars = variablesFor(config, step.id, schemaLite(client.schema));
  const tpl: Tpl = (value, set, opts = {}) => <TemplateInput value={value} onChange={set} variables={vars} multiline={opts.multiline} placeholder={opts.placeholder} ariaLabel={opts.label} />;
  let body: ReactNode = null;
  switch (step.type) {
    case "createRecord":
    case "updateRecords":
      body = <RecordStep client={client} config={config} step={step} onChange={onChange} tpl={tpl} />;
      break;
    case "findRecords":
      body = <FindStep client={client} step={step} onChange={onChange} />;
      break;
    case "http": {
      const setHeader = (i: number, h: [string, string]) => onChange({ ...step, headers: step.headers.map((x, j) => (j === i ? h : x)) });
      body = (
        <>
          <Row label="Method">
            <select className="input" value={step.method} onChange={e => onChange({ ...step, method: e.target.value as typeof step.method })}>
              {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Row>
          <Row label="URL">{tpl(step.url, url => onChange({ ...step, url }), { placeholder: "https://example.com/hook", label: "URL" })}</Row>
          <Row label="Headers" hint="Everyone who can edit this base can see header values. Values of headers such as Authorization are hidden in the run log.">
            {step.headers.map(([k, v], i) => (
              <div key={i} className="auto-inline">
                <input className="input" value={k} placeholder="Name" onChange={e => setHeader(i, [e.target.value, v])} aria-label="Header name" />
                {tpl(v, val => setHeader(i, [k, val]), { placeholder: "Value", label: "Header value" })}
                <button className="icon-btn" onClick={() => onChange({ ...step, headers: step.headers.filter((_, j) => j !== i) })} aria-label="Remove header"><Icon name="x" size={14} /></button>
              </div>
            ))}
            <Button small variant="ghost" icon="plus" onClick={() => onChange({ ...step, headers: [...step.headers, ["", ""]] })}>Add header</Button>
          </Row>
          {step.method !== "GET" && <Row label="Body">{tpl(step.body ?? "", b => onChange({ ...step, body: b || undefined }), { multiline: true, placeholder: '{"name": "{{trigger.record.Name}}"}', label: "Body" })}</Row>}
        </>
      );
      break;
    }
    case "email":
      body = (
        <>
          <Row label="Send with" hint={<>Resend and SMTP are set up by a workspace owner in <a href={`/settings/email?ws=${client.info.base.workspace_id}`}>Settings, Email sending</a>.</>}>
            <select className="input" value={step.provider} onChange={e => onChange({ ...step, provider: e.target.value as typeof step.provider })}>
              <option value="system">System email (when this server has it)</option>
              <option value="resend">Resend</option>
              <option value="smtp">SMTP</option>
            </select>
          </Row>
          <Row label="To" hint="Separate addresses with commas.">{tpl(step.to, to => onChange({ ...step, to }), { placeholder: "ops@example.com", label: "To" })}</Row>
          <Row label="Cc">{tpl(step.cc ?? "", cc => onChange({ ...step, cc: cc || undefined }), { label: "Cc" })}</Row>
          <Row label="Subject">{tpl(step.subject, subject => onChange({ ...step, subject }), { label: "Subject" })}</Row>
          <Row label="Format">
            <select className="input" value={step.format} onChange={e => onChange({ ...step, format: e.target.value as "text" | "html" })}>
              <option value="text">Plain text</option>
              <option value="html">HTML</option>
            </select>
          </Row>
          <Row label="Message" hint={step.format === "html" ? "Values from records are escaped, so they show as text." : undefined}>{tpl(step.body, b => onChange({ ...step, body: b }), { multiline: true, label: "Message" })}</Row>
        </>
      );
      break;
    case "ai":
      body = <AiStep client={client} step={step} onChange={onChange} tpl={tpl} />;
      break;
    case "branch": {
      const setCond = (i: number, patch: Partial<BranchCondition>) => onChange({ ...step, conditions: step.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
      body = (
        <>
          <Row label="Take the first column when">
            <select className="input" value={step.match} onChange={e => onChange({ ...step, match: e.target.value as "all" | "any" })}>
              <option value="all">all conditions hold</option>
              <option value="any">any condition holds</option>
            </select>
          </Row>
          {step.conditions.map((c, i) => (
            <div key={i} className="auto-cond">
              {tpl(c.left, left => setCond(i, { left }), { placeholder: "{{trigger.record.Stage}}", label: "Value" })}
              <select className="input" value={c.op} onChange={e => setCond(i, { op: e.target.value as BranchOp })} aria-label="Comparison">
                {BRANCH_OPS.map(op => <option key={op} value={op}>{BRANCH_LABELS[op]}</option>)}
              </select>
              {c.op !== "empty" && c.op !== "notempty" && tpl(c.right ?? "", right => setCond(i, { right }), { label: "Compared with" })}
              <button className="icon-btn" disabled={step.conditions.length === 1} onClick={() => onChange({ ...step, conditions: step.conditions.filter((_, j) => j !== i) })} aria-label="Remove condition"><Icon name="x" size={14} /></button>
            </div>
          ))}
          <Button small variant="ghost" icon="plus" onClick={() => onChange({ ...step, conditions: [...step.conditions, { left: "", op: "eq", right: "" }] })}>Add condition</Button>
          <p className="muted small">Text comparisons ignore case. Greater and less than compare numbers when both sides are numbers.</p>
        </>
      );
      break;
    }
  }
  return (
    <div className="auto-panel">
      <div className="auto-panel-head">
        <h3 className="auto-panel-title">{STEP_LABELS[step.type]} <span className="step-id">{step.id}</span></h3>
        <button className="icon-btn" onClick={() => onMove(-1)} aria-label="Move up"><Icon name="chevron" size={14} className="flip" /></button>
        <button className="icon-btn" onClick={() => onMove(1)} aria-label="Move down"><Icon name="chevron" size={14} /></button>
        <button className="icon-btn" onClick={onRemove} aria-label="Delete step"><Icon name="trash" size={14} /></button>
      </div>
      {body}
      {log && <StepLogView log={log} title="Last test" />}
    </div>
  );
}
