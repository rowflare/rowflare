// AI settings in the field dialog: template, service, model, prompt, output type, images, automatic updates and a preview.
import { useEffect, useRef, useState } from "react";
import type { Choice, Field, FieldOptions, FieldType } from "../../shared/types";
import { COLORS, FIELD_TYPES } from "../../shared/types";
import { AI_LIMITS, AI_OUTPUT_TYPES, AI_TEMPLATES, promptToStored, type AiConfig, type AiServiceInfo } from "../../shared/ai";
import { displayCell } from "../../shared/cells";
import { newChoiceId } from "../../shared/ids";
import type { BaseClient } from "../base/client";
import { Button, FieldIcon, Popover, Spinner } from "../ui";
import { Link } from "../router";
import { listBaseServices } from "./api";

export interface AiFieldOptionsProps {
  client: BaseClient;
  tableId: string;
  field?: Field;
  type: FieldType;
  setType: (t: FieldType) => void;
  opts: FieldOptions;
  set: (p: Partial<FieldOptions>) => void;
  viewId?: string;
}

type Preview = { answer: string; value: unknown; error?: string; cut: boolean } | { failed: string };

export default function AiFieldOptions({ client, tableId, field, type, setType, opts, set, viewId }: AiFieldOptionsProps) {
  const [services, setServices] = useState<AiServiceInfo[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const ai: AiConfig = opts.ai ?? { serviceId: "", prompt: "", autoUpdate: true };
  const setAi = (p: Partial<AiConfig>) => set({ ai: { ...ai, ...p } });
  const fields = client.fields(tableId).filter(f => f.id !== field?.id);
  const images = fields.filter(f => f.type === "attachment");

  useEffect(() => {
    listBaseServices(client.baseId)
      .then(r => {
        setServices(r.services);
        if (!ai.serviceId && r.services[0]) setAi({ serviceId: r.services[0].id });
      })
      .catch(() => setServices([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.baseId]);

  const service = services?.find(s => s.id === ai.serviceId);

  const applyTemplate = (id: string) => {
    const t = AI_TEMPLATES.find(x => x.id === id);
    if (!t) return;
    const primary = client.fields(tableId).find(f => f.id === client.table(tableId)?.primaryFieldId);
    setType(t.output);
    const patch: Partial<FieldOptions> = { ai: { ...ai, template: t.id, prompt: t.prompt.replace("{Field}", `{${primary?.name ?? "Name"}}`) } };
    if (t.choices) patch.choices = t.choices.map((name, i): Choice => ({ id: newChoiceId(), name, color: COLORS[i % COLORS.length] }));
    set(patch);
  };

  const firstRow = viewId ? client.viewState(viewId)?.ids[0] : undefined;
  const runPreview = async () => {
    if (firstRow === undefined) return;
    setPreviewing(true);
    setPreview(null);
    try {
      const options = { ...opts, ai: { ...ai, prompt: promptToStored(ai.prompt, fields) } };
      setPreview(await client.aiPreview(tableId, firstRow, { type, options }));
    } catch (e) {
      setPreview({ failed: e instanceof Error ? e.message : String(e) });
    } finally {
      setPreviewing(false);
    }
  };
  const previewText = (p: Exclude<Preview, { failed: string }>) => {
    if (p.error) return p.error;
    const f = { id: "preview", tableId, name: "", type, options: opts, ord: "" } as Field;
    return displayCell(f, p.value, { userName: id => client.members.find(m => m.id === id)?.name ?? id }) || "(empty)";
  };

  if (services && !services.length) {
    return (
      <div className="ai-options">
        <p className="muted small">No AI services yet. A workspace owner can add one in Settings, AI services.</p>
        {client.info.role === "owner" && <Link to={`/settings/ai?ws=${client.info.base.workspace_id}`}>Open AI services</Link>}
      </div>
    );
  }

  return (
    <div className="stack ai-options">
      <select className="input" value="" onChange={e => applyTemplate(e.target.value)} aria-label="Start from a template">
        <option value="">Start from a template</option>
        {AI_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <div className="row">
        <select className="input" value={ai.serviceId} onChange={e => setAi({ serviceId: e.target.value })} aria-label="AI service">
          {!services && <option value={ai.serviceId}>Loading...</option>}
          {services && !service && <option value={ai.serviceId}>Choose a service</option>}
          {services?.map(s => <option key={s.id} value={s.id}>{s.name}{s.keyRejected ? " (key rejected)" : ""}</option>)}
        </select>
        <input className="input" value={ai.model ?? ""} onChange={e => setAi({ model: e.target.value || undefined })} placeholder={service ? `Model: ${service.model}` : "Model"} aria-label="Model" />
      </div>
      <PromptInput value={ai.prompt} onChange={prompt => setAi({ prompt })} fields={fields} />
      <div>
        <label className="field-label">Answer as</label>
        <select className="input" value={type} onChange={e => setType(e.target.value as FieldType)} aria-label="Answer type">
          {AI_OUTPUT_TYPES.map(t => <option key={t} value={t}>{FIELD_TYPES.find(x => x.type === t)?.label}</option>)}
        </select>
      </div>
      {images.length > 0 && (
        <div>
          <label className="field-label">Send images from</label>
          {images.map(f => {
            const on = ai.imageFieldIds?.includes(f.id) ?? false;
            const full = (ai.imageFieldIds?.length ?? 0) >= AI_LIMITS.imageFields;
            return (
              <label key={f.id} className="row small">
                <input type="checkbox" checked={on} disabled={!on && full} onChange={e => setAi({ imageFieldIds: e.target.checked ? [...(ai.imageFieldIds ?? []), f.id] : (ai.imageFieldIds ?? []).filter(x => x !== f.id) })} /> {f.name}
              </label>
            );
          })}
          <p className="muted small">Images go to the model; choose a model that reads images.</p>
        </div>
      )}
      <label className="row small">
        <input type="checkbox" checked={ai.autoUpdate !== false} onChange={e => setAi({ autoUpdate: e.target.checked })} /> Update when the fields in the prompt change
      </label>
      <div className="ai-preview">
        <Button small icon="sparkle" onClick={runPreview} disabled={previewing || firstRow === undefined || !ai.prompt.trim() || !ai.serviceId}>
          Preview with the first record
        </Button>
        {previewing && <Spinner size={14} />}
        {preview && "failed" in preview && <div className="err small">{preview.failed}</div>}
        {preview && !("failed" in preview) && (
          <div className={preview.error ? "err small" : "small ai-preview-answer"}>
            {previewText(preview)}
            {preview.cut && <div className="muted small">The prompt was cut at 32,000 characters.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function PromptInput({ value, onChange, fields }: { value: string; onChange: (v: string) => void; fields: Field[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const el = useRef<HTMLTextAreaElement | null>(null);
  const insert = (text: string) => {
    const t = el.current;
    if (!t) return onChange(value + text);
    const start = t.selectionStart, end = t.selectionEnd;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      t.focus();
      t.selectionStart = t.selectionEnd = start + text.length;
    });
  };
  return (
    <div className="formula-input">
      <textarea ref={el} className="input textarea" rows={5} maxLength={AI_LIMITS.promptChars} value={value} onChange={e => onChange(e.target.value)} placeholder="Summarize {Notes} in one sentence." aria-label="Prompt" />
      <div className="row">
        <Button small onClick={e => setAnchor(e.currentTarget)} icon="plus">Field</Button>
        <span className="muted small">{value.length.toLocaleString()} / 8,000</span>
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
