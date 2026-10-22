// Form builder: pick fields, edit labels and texts, preview the form and manage its public link.
import { useEffect, useMemo, useState } from "react";
import type { Field, FormFieldConfig, View, ViewConfig } from "../../shared/types";
import { COMPUTED_TYPES } from "../../shared/types";
import { del, post } from "../api";
import { toast, toastError } from "../toast";
import { Button, confirmDialog, copyText, Icon, Spinner } from "../ui";
import { type BaseClient, useBase } from "./client";
import { type EditorContext, FieldValueEditor } from "./editors";
import "./views.css";

type FormConfig = NonNullable<ViewConfig["form"]>;

const DEFAULT_SUBMIT = "Submit";
const DEFAULT_SUCCESS = "Thanks, your response was recorded.";

/** Text input that keeps its own draft while focused so remote echoes never clobber typing. */
function DraftInput({ value, onChange, multiline, className, ...rest }: {
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const props = {
    ...rest,
    className,
    value: draft,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      onChange(e.target.value);
    },
  };
  return multiline ? <textarea rows={Math.min(8, Math.max(2, draft.split("\n").length))} {...props} /> : <input {...props} />;
}

export default function FormView({ client, view: viewProp }: { client: BaseClient; view: View }) {
  useBase(client);
  const view = client.view(viewProp.id) ?? viewProp;
  const ro = !client.writable;
  const form: FormConfig = view.config.form ?? {};
  const [preview, setPreview] = useState<Record<string, unknown>>({});
  const [shareBusy, setShareBusy] = useState(false);

  const available = client.orderedFields(view).filter(f => !COMPUTED_TYPES.has(f.type) && f.type !== "user");
  const byId = new Map(available.map(f => [f.id, f]));
  const items = (form.fields ?? []).filter(ff => byId.has(ff.fieldId));
  const included = new Set(items.map(ff => ff.fieldId));

  const ctx: EditorContext = useMemo(() => ({ members: client.members, searchLinked: (t, q) => client.searchRecords(t, q) }), [client]);

  const save = (patch: Partial<FormConfig>, delay = 400) => {
    const current = client.view(view.id)?.config.form ?? {};
    const fields = (patch.fields ?? current.fields ?? []).filter(ff => byId.has(ff.fieldId));
    client.updateViewConfig(view.id, { form: { ...current, ...patch, fields } }, delay);
  };
  const setItems = (next: FormFieldConfig[]) => save({ fields: next }, 0);
  const patchItem = (fieldId: string, patch: Partial<FormFieldConfig>, delay = 400) =>
    save({ fields: items.map(ff => (ff.fieldId === fieldId ? { ...ff, ...patch } : ff)) }, delay);
  const toggle = (f: Field) => setItems(included.has(f.id) ? items.filter(ff => ff.fieldId !== f.id) : [...items, { fieldId: f.id }]);
  const move = (i: number, d: number) => {
    const next = [...items];
    const [it] = next.splice(i, 1);
    next.splice(i + d, 0, it!);
    setItems(next);
  };

  const shareUrl = form.shareId ? `${location.origin}/form/${form.shareId}` : "";
  const createLink = async () => {
    setShareBusy(true);
    try {
      const res = await post<{ shareId: string; url: string }>(`/api/bases/${client.baseId}/forms`, { viewId: view.id });
      // Keep the id locally too so a pending debounced save cannot drop it.
      if (res.shareId) save({ shareId: res.shareId }, 0);
    } catch (e) {
      toastError(e);
    } finally {
      setShareBusy(false);
    }
  };
  const disableLink = async () => {
    if (!form.shareId || !confirmDialog("Disable this link? People who have it will no longer be able to submit the form.")) return;
    setShareBusy(true);
    try {
      await del(`/api/bases/${client.baseId}/forms/${form.shareId}`);
      save({ shareId: undefined }, 0);
    } catch (e) {
      toastError(e);
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div className="fv">
      <aside className="fv-side">
        <div className="fv-side-head">
          <h3>Fields</h3>
          <div className="row">
            <Button small variant="ghost" disabled={ro || included.size === available.length} onClick={() => setItems([...items, ...available.filter(f => !included.has(f.id)).map(f => ({ fieldId: f.id }))])}>
              Add all
            </Button>
            <Button small variant="ghost" disabled={ro || !items.length} onClick={() => setItems([])}>
              Clear
            </Button>
          </div>
        </div>
        <div className="fv-side-list">
          {available.map(f => (
            <label key={f.id} className={"fv-side-item" + (included.has(f.id) ? " on" : "")}>
              <Icon name={f.type} size={14} />
              <span className="grow fv-ellipsis">{f.name}</span>
              <input type="checkbox" className="fv-switch" checked={included.has(f.id)} disabled={ro} onChange={() => toggle(f)} aria-label={`Include ${f.name}`} />
            </label>
          ))}
          {!available.length && <div className="muted small">This table has no fields that can be filled in.</div>}
        </div>
        <p className="muted small fv-side-note">Computed and user fields cannot be filled in by a form.</p>
      </aside>

      <div className="fv-main">
        <div className="fv-wrap">
          <section className="card fv-share">
            <div className="fv-share-head">
              <Icon name="link" />
              <div className="grow">
                <div className="fv-share-title">Public link</div>
                <div className="muted small">{form.shareId ? "Anyone with this link can submit a response." : "Create a link so anyone can fill in this form, no account needed."}</div>
              </div>
              {shareBusy && <Spinner size={14} />}
            </div>
            {form.shareId ? (
              <div className="fv-share-row">
                <input className="input fv-share-url" readOnly value={shareUrl} onFocus={e => e.currentTarget.select()} aria-label="Form link" />
                <div className="row fv-share-actions">
                  <Button small icon="copy" onClick={() => { copyText(shareUrl); toast("Link copied"); }}>Copy</Button>
                  <Button small icon="expand" onClick={() => window.open(shareUrl, "_blank", "noopener")}>Open</Button>
                  <Button small variant="danger" disabled={ro || shareBusy} onClick={disableLink}>Disable link</Button>
                </div>
              </div>
            ) : (
              <Button variant="primary" icon="link" disabled={ro || shareBusy} onClick={createLink}>Create share link</Button>
            )}
          </section>

          <section className="card fv-card">
            <div className="fv-accent" />
            <div className="fv-card-head">
              <DraftInput className="fv-title" value={form.title ?? view.name} placeholder="Form title" disabled={ro} aria-label="Form title" onChange={v => save({ title: v || undefined })} />
              <DraftInput className="fv-desc" multiline value={form.description ?? ""} placeholder="Add a description (optional)" disabled={ro} aria-label="Form description" onChange={v => save({ description: v })} />
            </div>

            {items.length === 0 && (
              <div className="fv-empty">
                <Icon name="form" size={22} />
                <div>Add fields from the list to build your form.</div>
              </div>
            )}

            {items.map((ff, i) => {
              const f = byId.get(ff.fieldId)!;
              return (
                <div key={ff.fieldId} className="fv-field">
                  <div className="fv-field-head">
                    <Icon name={f.type} size={14} className="muted" />
                    <DraftInput className="fv-label" value={ff.label ?? ""} placeholder={f.name} disabled={ro} aria-label={`Label for ${f.name}`} onChange={v => patchItem(f.id, { label: v || undefined })} />
                    {ff.required && <span className="fv-req" aria-hidden="true">*</span>}
                    <div className="fv-field-tools">
                      <label className="fv-required">
                        <input type="checkbox" checked={!!ff.required} disabled={ro} onChange={e => patchItem(f.id, { required: e.target.checked || undefined }, 0)} />
                        Required
                      </label>
                      <button className="icon-btn" disabled={ro || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                        <Icon name="chevron" size={15} className="fv-up" />
                      </button>
                      <button className="icon-btn" disabled={ro || i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                        <Icon name="chevron" size={15} />
                      </button>
                      <button className="icon-btn" disabled={ro} onClick={() => setItems(items.filter(x => x.fieldId !== f.id))} aria-label={`Remove ${f.name}`}>
                        <Icon name="x" size={15} />
                      </button>
                    </div>
                  </div>
                  <DraftInput className="fv-help" value={ff.help ?? ""} placeholder={f.description || "Help text (optional)"} disabled={ro} aria-label={`Help text for ${f.name}`} onChange={v => patchItem(f.id, { help: v || undefined })} />
                  <div className="fv-preview">
                    <FieldValueEditor compact field={f} value={preview[f.id] ?? null} ctx={ctx} onChange={v => setPreview(p => ({ ...p, [f.id]: v }))} />
                  </div>
                </div>
              );
            })}

            <div className="fv-foot">
              <div className="fv-submit">
                <DraftInput className="fv-submit-input" value={form.submitText ?? DEFAULT_SUBMIT} placeholder={DEFAULT_SUBMIT} disabled={ro} aria-label="Submit button text" onChange={v => save({ submitText: v || undefined })} />
              </div>
              <label className="field-label">Message shown after submitting</label>
              <DraftInput className="input" value={form.successText ?? DEFAULT_SUCCESS} placeholder={DEFAULT_SUCCESS} disabled={ro} aria-label="Success message" onChange={v => save({ successText: v || undefined })} />
            </div>
          </section>
          <p className="muted small fv-note">Values entered in this preview are not saved.</p>
        </div>
      </div>
    </div>
  );
}
