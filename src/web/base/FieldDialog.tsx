// Create or edit a field: name, type and the options each type needs.
import { useMemo, useState } from "react";
import type { Choice, Field, FieldOptions, FieldType } from "../../shared/types";
import { COLORS, FIELD_TYPES } from "../../shared/types";
import { compileFormula, FormulaError, FUNCTION_NAMES } from "../../shared/formula";
import { toDisplay } from "../../shared/formula";
import { ROLLUP_FNS, type RollupFn } from "../../shared/rollup";
import { newChoiceId } from "../../shared/ids";
import type { BaseClient } from "./client";
import { Button, FieldIcon, Icon, Popover } from "../ui";
import { toastError } from "../toast";
import { isAiOutputType, promptToDisplay, promptToStored } from "../../shared/ai";
import AiFieldOptions from "../ai/AiFieldOptions";

export interface FieldDialogProps {
  client: BaseClient;
  tableId: string;
  field?: Field;
  anchor: DOMRect;
  viewId?: string;
  position?: { afterFieldId?: string; beforeFieldId?: string };
  onClose: () => void;
}

export default function FieldDialog({ client, tableId, field, anchor, viewId, position, onClose }: FieldDialogProps) {
  const fields = client.fields(tableId);
  const refs = useMemo(() => fields.filter(f => f.id !== field?.id).map(f => ({ id: f.id, name: f.name })), [fields, field]);
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<FieldType>(field?.type ?? "text");
  const [opts, setOpts] = useState<FieldOptions>(() => {
    const o = { ...(field?.options ?? {}) };
    if (field?.type === "formula" && o.formula) o.formula = toDisplay(o.formula, fields.map(f => ({ id: f.id, name: f.name })));
    if (o.ai) o.ai = { ...o.ai, prompt: promptToDisplay(o.ai.prompt, fields) };
    return o;
  });
  const [aiOn, setAiOn] = useState(!!field?.options.ai);
  const [description, setDescription] = useState(field?.description ?? "");
  const [busy, setBusy] = useState(false);
  const isPrimary = client.table(tableId)?.primaryFieldId === field?.id;
  const set = (patch: Partial<FieldOptions>) => setOpts(o => ({ ...o, ...patch }));

  const formulaError = useMemo(() => {
    if (type !== "formula") return null;
    if (!opts.formula?.trim()) return "Enter a formula";
    try {
      compileFormula(opts.formula, refs);
      return null;
    } catch (e) {
      return e instanceof FormulaError ? e.message : String(e);
    }
  }, [type, opts.formula, refs]);

  const linkFields = fields.filter(f => f.type === "link" && f.id !== field?.id);
  const linkField = linkFields.find(f => f.id === opts.linkFieldId);
  const targetFields = linkField?.options.linkedTableId ? client.fields(linkField.options.linkedTableId) : [];
  const disallowed: FieldType[] = isPrimary ? ["link", "attachment", "checkbox", "lookup", "rollup"] : [];

  const save = async () => {
    const options: FieldOptions = { ...opts };
    if (aiOn && options.ai) {
      if (!options.ai.serviceId) return toastError(new Error("Choose an AI service"));
      if (!options.ai.prompt.trim()) return toastError(new Error("Write a prompt"));
      options.ai = { ...options.ai, prompt: promptToStored(options.ai.prompt, fields.filter(f => f.id !== field?.id)) };
    } else if (aiOn) return toastError(new Error("Write a prompt"));
    else delete options.ai;
    if (type === "lookup" || type === "rollup") {
      if (!options.linkFieldId || !options.targetFieldId) return toastError(new Error("Choose a link field and a field to look up"));
    }
    if (type === "link" && !options.linkedTableId) return toastError(new Error("Choose a table to link to"));
    if (type === "formula" && formulaError) return;
    setBusy(true);
    try {
      if (field) {
        const typeChanged = type !== field.type;
        if (typeChanged && !window.confirm(`Change "${field.name}" to ${FIELD_TYPES.find(t => t.type === type)?.label}? Existing values will be converted.`)) {
          setBusy(false);
          return;
        }
        await client.schemaOp({ op: "updateField", fieldId: field.id, patch: { name: name.trim() || field.name, type, options, description } });
        await offerGenerate(field.id, field.name);
      } else {
        const res = await client.schemaOp({ op: "createField", tableId, field: { name: name.trim() || defaultName(type), type, options, description } });
        if (res.id) await offerGenerate(res.id, name.trim() || defaultName(type));
        const view = viewId ? client.view(viewId) : undefined;
        if (view && res.id && (position?.afterFieldId || position?.beforeFieldId)) {
          const order = client.orderedFields(view).map(f => f.id).filter(id => id !== res.id);
          const anchorId = position.afterFieldId ?? position.beforeFieldId!;
          order.splice(order.indexOf(anchorId) + (position.afterFieldId ? 1 : 0), 0, res.id);
          client.updateViewConfig(view.id, { fieldOrder: order });
        }
      }
      onClose();
      async function offerGenerate(id: string, label: string) {
        const ai = options.ai;
        if (!ai) return;
        const old = field?.options.ai;
        const changed = !old || JSON.stringify([field!.type, old.prompt, old.serviceId, old.model ?? "", field!.options.choices ?? []]) !== JSON.stringify([type, ai.prompt, ai.serviceId, ai.model ?? "", options.choices ?? []]);
        const rows = client.table(tableId)?.rowCount ?? 0;
        if (!changed || rows === 0) return;
        if (!window.confirm(`Generate "${label}" for ${rows.toLocaleString()} existing records?`)) return;
        await client.aiGenerate(tableId, id);
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={aiOn ? 440 : 380} className="field-dialog">
      <div className="stack">
        <input className="input" placeholder="Field name" value={name} autoFocus onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && type !== "formula" && save()} />
        <select
          className="input"
          value={aiOn ? "ai" : type}
          onChange={e => {
            if (e.target.value === "ai") {
              setAiOn(true);
              if (!isAiOutputType(type)) setType("longText");
              return;
            }
            setAiOn(false);
            setType(e.target.value as FieldType);
          }}
          aria-label="Field type"
        >
          <option value="ai">AI</option>
          {FIELD_TYPES.filter(t => !disallowed.includes(t.type)).map(t => (
            <option key={t.type} value={t.type}>{t.label}</option>
          ))}
        </select>
        {aiOn && <AiFieldOptions client={client} tableId={tableId} field={field} type={type} setType={setType} opts={opts} set={set} viewId={viewId} />}
        <TypeOptions client={client} tableId={tableId} type={type} opts={opts} set={set} field={field} linkFields={linkFields} targetFields={targetFields} formulaError={formulaError} />
        <details>
          <summary className="muted small">Description</summary>
          <textarea className="input textarea" rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Help text shown in forms and the record view" />
        </details>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || (type === "formula" && !!formulaError)}>
            {field ? "Save" : "Create field"}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

function defaultName(type: FieldType): string {
  return FIELD_TYPES.find(t => t.type === type)?.label ?? "Field";
}

function TypeOptions({ client, tableId, type, opts, set, field, linkFields, targetFields, formulaError }: {
  client: BaseClient;
  tableId: string;
  type: FieldType;
  opts: FieldOptions;
  set: (p: Partial<FieldOptions>) => void;
  field?: Field;
  linkFields: Field[];
  targetFields: Field[];
  formulaError: string | null;
}) {
  switch (type) {
    case "button": {
      const choices = (client.schema.buttons ?? []).filter(b => b.tableId === tableId);
      return (
        <>
          <input className="input" value={opts.label ?? ""} placeholder="Button label, such as Approve" maxLength={40} onChange={e => set({ label: e.target.value })} aria-label="Button label" />
          <div className="row" role="radiogroup" aria-label="Button color">
            {COLORS.map(c => (
              <button key={c} type="button" role="radio" aria-checked={opts.color === c} aria-label={c} onClick={() => set({ color: c })} style={{ width: 22, height: 22, borderRadius: 6, background: c, border: opts.color === c ? "2px solid var(--accent)" : "1px solid var(--line-2)", cursor: "pointer" }} />
            ))}
          </div>
          <select className="input" value={opts.automationId ?? ""} onChange={e => set({ automationId: e.target.value || undefined })} aria-label="Automation">
            <option value="">Choose an automation</option>
            {choices.map(b => <option key={b.id} value={b.id}>{b.name}{b.enabled ? "" : " (off)"}</option>)}
          </select>
          {!choices.length && <p className="muted small">Create an automation with the trigger "When a button is clicked" for this table first.</p>}
        </>
      );
    }
    case "number":
      return (
        <div className="row">
          <select className="input" value={opts.format ?? "number"} onChange={e => set({ format: e.target.value as FieldOptions["format"] })} aria-label="Format">
            <option value="number">Number</option>
            <option value="currency">Currency</option>
            <option value="percent">Percent</option>
          </select>
          <select className="input" value={opts.precision ?? ""} onChange={e => set({ precision: e.target.value === "" ? undefined : Number(e.target.value) })} aria-label="Precision">
            <option value="">Any decimals</option>
            {[0, 1, 2, 3, 4].map(p => <option key={p} value={p}>{p === 0 ? "Integer" : `${p} decimal${p > 1 ? "s" : ""}`}</option>)}
          </select>
          {opts.format === "currency" && <input className="input" style={{ width: 70 }} value={opts.symbol ?? "$"} onChange={e => set({ symbol: e.target.value })} aria-label="Currency symbol" />}
        </div>
      );
    case "singleSelect":
    case "multiSelect":
      return <ChoicesEditor choices={opts.choices ?? []} onChange={choices => set({ choices })} />;
    case "date":
      return (
        <label className="row small">
          <input type="checkbox" checked={!!opts.includeTime} onChange={e => set({ includeTime: e.target.checked })} /> Include time
        </label>
      );
    case "user":
      return (
        <label className="row small">
          <input type="checkbox" checked={!!opts.multiple} onChange={e => set({ multiple: e.target.checked })} /> Allow multiple people
        </label>
      );
    case "link":
      return (
        <div>
          <label className="field-label">Link to table</label>
          <select className="input" value={opts.linkedTableId ?? ""} onChange={e => set({ linkedTableId: e.target.value })} disabled={field?.type === "link"}>
            <option value="">Choose a table</option>
            {client.schema.tables.map(t => <option key={t.id} value={t.id}>{t.name}{t.id === tableId ? " (this table)" : ""}</option>)}
          </select>
          <p className="muted small">A matching link field is added to the other table automatically.</p>
        </div>
      );
    case "lookup":
    case "rollup":
      if (!linkFields.length) return <p className="muted small">Add a "Link to another record" field first.</p>;
      return (
        <div className="stack">
          <div>
            <label className="field-label">Through link field</label>
            <select className="input" value={opts.linkFieldId ?? ""} onChange={e => set({ linkFieldId: e.target.value, targetFieldId: undefined })}>
              <option value="">Choose</option>
              {linkFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          {opts.linkFieldId && (
            <div>
              <label className="field-label">{type === "lookup" ? "Field to look up" : "Field to summarize"}</label>
              <select className="input" value={opts.targetFieldId ?? ""} onChange={e => set({ targetFieldId: e.target.value })}>
                <option value="">Choose</option>
                {targetFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}
          {type === "rollup" && (
            <div>
              <label className="field-label">Aggregation</label>
              <select className="input" value={opts.fn ?? "sum"} onChange={e => set({ fn: e.target.value as RollupFn })}>
                {ROLLUP_FNS.map(r => <option key={r.fn} value={r.fn}>{r.label} ({r.formula})</option>)}
              </select>
            </div>
          )}
          {type === "rollup" && <NumberFormat opts={opts} set={set} />}
        </div>
      );
    case "formula":
      return (
        <div className="stack">
          <FormulaInput value={opts.formula ?? ""} onChange={formula => set({ formula })} fields={client.fields(tableId).filter(f => f.id !== field?.id)} />
          {formulaError ? <div className="err">{formulaError}</div> : <div className="ok small">Formula is valid</div>}
          <NumberFormat opts={opts} set={set} />
        </div>
      );
    default:
      return null;
  }
}

function NumberFormat({ opts, set }: { opts: FieldOptions; set: (p: Partial<FieldOptions>) => void }) {
  return (
    <div className="row">
      <select className="input" value={opts.format ?? ""} onChange={e => set({ format: (e.target.value || undefined) as FieldOptions["format"] })} aria-label="Number format">
        <option value="">Default format</option>
        <option value="number">Number</option>
        <option value="currency">Currency</option>
        <option value="percent">Percent</option>
      </select>
      <select className="input" value={opts.precision ?? ""} onChange={e => set({ precision: e.target.value === "" ? undefined : Number(e.target.value) })} aria-label="Precision">
        <option value="">Any decimals</option>
        {[0, 1, 2, 3].map(p => <option key={p} value={p}>{p} decimals</option>)}
      </select>
    </div>
  );
}

function FormulaInput({ value, onChange, fields }: { value: string; onChange: (v: string) => void; fields: Field[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  const insert = (text: string) => {
    if (!el) return onChange(value + text);
    const start = el.selectionStart, end = el.selectionEnd;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  };
  return (
    <div className="formula-input">
      <textarea ref={setEl} className="input textarea mono" rows={3} value={value} onChange={e => onChange(e.target.value)} placeholder='IF({Status} = "Done", {Hours} * 2, 0)' spellCheck={false} />
      <div className="row">
        <Button small onClick={e => setAnchor(e.currentTarget)} icon="plus">Field</Button>
        <select className="input" style={{ height: 28 }} value="" onChange={e => e.target.value && insert(e.target.value + "(")} aria-label="Insert function">
          <option value="">Insert function</option>
          {[...FUNCTION_NAMES].sort().map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={240} className="menu">
          {fields.map(f => (
            <button key={f.id} className="menu-item" onClick={() => { insert(`{${f.name}}`); setAnchor(null); }}>
              <FieldIcon type={f.type} /> {f.name}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

function ChoicesEditor({ choices, onChange }: { choices: Choice[]; onChange: (c: Choice[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const name = draft.trim();
    if (!name || choices.some(c => c.name === name)) return;
    onChange([...choices, { id: newChoiceId(), name, color: COLORS[choices.length % COLORS.length] }]);
    setDraft("");
  };
  const move = (i: number, d: number) => {
    const next = [...choices];
    const [c] = next.splice(i, 1);
    next.splice(i + d, 0, c);
    onChange(next);
  };
  return (
    <div className="choices">
      {choices.map((c, i) => (
        <div key={c.id} className="choice-row">
          <label className="choice-color" style={{ background: c.color }} title="Color">
            <select value={c.color} onChange={e => onChange(choices.map(x => (x.id === c.id ? { ...x, color: e.target.value } : x)))} aria-label="Color">
              {COLORS.map(col => <option key={col} value={col}>{col}</option>)}
            </select>
          </label>
          <input className="input" value={c.name} onChange={e => onChange(choices.map(x => (x.id === c.id ? { ...x, name: e.target.value } : x)))} />
          <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="chevron" size={14} className="flip" /></button>
          <button className="icon-btn" disabled={i === choices.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="chevron" size={14} /></button>
          <button className="icon-btn" onClick={() => onChange(choices.filter(x => x.id !== c.id))} aria-label="Remove option"><Icon name="x" size={14} /></button>
        </div>
      ))}
      <div className="row">
        <input className="input" placeholder="Add an option" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <Button onClick={add} icon="plus">Add</Button>
      </div>
    </div>
  );
}
