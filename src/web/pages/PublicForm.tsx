import { useEffect, useMemo, useRef, useState } from "react";
import { get, post, uploadFile } from "../api";
import { FieldValueEditor, type EditorContext } from "../base/editors";
import { Button, Icon, Logo, Spinner } from "../ui";
import type { Field, FieldOptions, FieldType, LinkValue } from "../../shared/types";
import "./pages.css";

interface FormField {
  id: string;
  name: string;
  help: string;
  required: boolean;
  type: FieldType;
  options: FieldOptions;
}

interface FormDef {
  title: string;
  description: string;
  submitText: string;
  successText: string;
  fields: FormField[];
  linkOptions: Record<string, LinkValue[]>;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export default function PublicForm({ shareId }: { shareId: string }) {
  const [form, setForm] = useState<FormDef | null>(null);
  const [loadError, setLoadError] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const valuesRef = useRef(values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    get<FormDef>(`/api/forms/${encodeURIComponent(shareId)}`)
      .then(f => {
        setForm(f);
        document.title = f.title ? `${f.title} - Rowflare` : "Rowflare form";
      })
      .catch(e => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [shareId]);

  const fields = useMemo(() => (form?.fields ?? []).filter(f => f.type !== "user"), [form]);

  const ctxs = useMemo(() => {
    const out: Record<string, EditorContext> = {};
    const upload = (file: File) => uploadFile(`/api/forms/${encodeURIComponent(shareId)}/attachments`, file);
    for (const f of fields) {
      const options = form?.linkOptions[f.id] ?? [];
      out[f.id] = {
        noPreview: true,
        noCreate: true,
        members: [],
        upload,
        searchLinked: async (_t, q) => {
          const s = q.trim().toLowerCase();
          return s ? options.filter(o => o.t.toLowerCase().includes(s)) : options;
        },
      };
    }
    return out;
  }, [fields, form, shareId]);

  const setValue = (id: string, v: unknown) => {
    valuesRef.current = { ...valuesRef.current, [id]: v };
    setValues(valuesRef.current);
    if (!isEmpty(v)) setErrors(e => (e[id] ? { ...e, [id]: "" } : e));
  };

  const submit = async () => {
    if (!form || busy) return;
    const current = valuesRef.current;
    const missing: Record<string, string> = {};
    for (const f of fields) if (f.required && isEmpty(current[f.id])) missing[f.id] = "This field is required";
    setErrors(missing);
    setApiError("");
    const first = fields.find(f => missing[f.id]);
    if (first) {
      document.getElementById(`pf-${first.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const cells: Record<string, unknown> = {};
    for (const f of fields) if (!isEmpty(current[f.id])) cells[f.id] = current[f.id];
    setBusy(true);
    try {
      await post(`/api/forms/${encodeURIComponent(shareId)}`, { cells });
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    valuesRef.current = {};
    setValues({});
    setErrors({});
    setApiError("");
    setDone(false);
    setRound(r => r + 1);
  };

  let content: React.ReactNode;
  if (loadError) {
    content = (
      <div className="pf-done">
        <h1 style={{ fontSize: 20 }}>Form unavailable</h1>
        <p>{loadError}</p>
      </div>
    );
  } else if (!form) {
    content = <div className="pf-done"><Spinner size={24} /></div>;
  } else if (done) {
    content = (
      <div className="pf-done" role="status">
        <span className="pf-check"><Icon name="check" size={26} /></span>
        <h1 style={{ fontSize: 20 }}>{form.title}</h1>
        <p>{form.successText}</p>
        <Button onClick={reset}>Submit another response</Button>
      </div>
    );
  } else {
    content = (
      <>
        <div className="pf-head">
          <h1>{form.title}</h1>
          {form.description && <p className="pf-desc">{form.description}</p>}
        </div>
        {/* Not a <form>: the shared editors render buttons without type="button", which would submit it. */}
        <div className="pf-body">
          {fields.length === 0 && <p className="muted">This form has no fields yet.</p>}
          {fields.map(f => {
            const field: Field = { id: f.id, tableId: "", name: f.name, type: f.type, options: f.options, ord: "" };
            const labelId = `pf-${f.id}-label`;
            return (
              <div key={`${f.id}-${round}`} id={`pf-${f.id}`} className={"pf-field" + (errors[f.id] ? " invalid" : "")} role="group" aria-labelledby={labelId} aria-describedby={f.help ? `pf-${f.id}-help` : undefined}>
                <div className="pf-label" id={labelId}>
                  {f.name}
                  {f.required && <span className="pf-req" aria-label="required">*</span>}
                </div>
                {f.help && <div className="pf-help" id={`pf-${f.id}-help`}>{f.help}</div>}
                <FieldValueEditor compact
                  field={field}
                  value={values[f.id]}
                  ctx={ctxs[f.id]}
                  onChange={(v, opts) => {
                    // New select options cannot be created from a public form.
                    if (opts?.typecast) return;
                    setValue(f.id, v);
                  }}
                />
                {errors[f.id] && <div className="err" role="alert">{errors[f.id]}</div>}
              </div>
            );
          })}
          <div className="pf-actions">
            {apiError && <div className="page-err" role="alert">{apiError}</div>}
            <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={submit}>
              {busy && <Spinner size={14} />} {form.submitText || "Submit"}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <main className="pf-page">
      <div className="card pf-card">
        <div className="pf-band" />
        {content}
      </div>
      <a className="pf-foot" href="/" target="_blank" rel="noreferrer">
        <Logo size={14} /> Powered by Rowflare
      </a>
    </main>
  );
}
