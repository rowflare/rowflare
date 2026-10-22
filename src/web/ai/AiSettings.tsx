// Workspace settings: model services for AI fields and AI automation steps.
import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceInfo } from "../api";
import { confirmDialog, Spinner } from "../ui";
import { toast } from "../toast";
import { ErrorLine, Submit, useAction } from "../pages/formParts";
import type { AiServiceInfo } from "../../shared/ai";
import { addService, KIND_LABELS, listWsServices, removeService, saveService, testService, type ServiceForm, type ServiceList } from "./api";

/** Fill the form for common services; the model stays editable. */
const PRESETS: { label: string; kind: "anthropic" | "openai"; baseUrl?: string; model?: string; note?: string }[] = [
  { label: "Anthropic", kind: "anthropic" },
  { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1" },
  { label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Qwen (DashScope)", kind: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { label: "Kimi (Moonshot)", kind: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { label: "Zhipu", kind: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { label: "Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { label: "Ollama", kind: "openai", baseUrl: "http://localhost:11434/v1", note: "Needs AUTOMATION_ALLOW_PRIVATE=true on the server." },
];

export function AiSettings({ ws }: { ws: WorkspaceInfo }) {
  const [info, setInfo] = useState<ServiceList | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    listWsServices(ws.id)
      .then(setInfo)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    load();
  }, [ws.id]);
  if (error) return <ErrorLine error={error} />;
  if (!info) return <Spinner />;
  const owner = ws.role === "owner";
  const saved = info.services.filter(s => s.kind !== "workers");
  const workers = info.services.find(s => s.kind === "workers");
  return (
    <>
      <section className="card section">
        <h2>AI services</h2>
        <p className="section-desc" style={{ margin: 0 }}>
          AI fields and AI automation steps call these services with your own keys. Keys are stored encrypted and never shown again; only their last four characters are.
        </p>
      </section>
      {!owner && (
        <section className="card section">
          <p className="page-note" style={{ margin: 0 }}>Only workspace owners can add or change AI services.</p>
          <ServiceTable services={info.services} />
        </section>
      )}
      {owner && !info.secretKey && <div className="page-err">The server has no SECRET_KEY setting, so AI keys cannot be stored. Set SECRET_KEY to a long random value and restart.</div>}
      {owner && workers && <WorkersCard ws={ws} service={workers} />}
      {owner && saved.map(s => <ServiceCard key={s.id} ws={ws} saved={s} disabled={!info.secretKey} onChanged={load} />)}
      {owner && <ServiceCard key={`new-${saved.length}`} ws={ws} disabled={!info.secretKey} onChanged={load} />}
    </>
  );
}

function ServiceTable({ services }: { services: AiServiceInfo[] }) {
  if (!services.length) return <p className="muted small">No AI services yet.</p>;
  return (
    <ul className="list">
      {services.map(s => (
        <li key={s.id} className="list-row">
          <div>
            <div>{s.name} {s.keyRejected && <span className="page-err-inline">Key rejected</span>}</div>
            <div className="list-sub">{KIND_LABELS[s.kind]}, {s.model}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function WorkersCard({ ws, service }: { ws: WorkspaceInfo; service: AiServiceInfo }) {
  const t = useAction();
  return (
    <section className="card section">
      <h2>Workers AI</h2>
      <p className="section-desc">Built into this server, no key needed. Default model {service.model}. {service.calls.toLocaleString()} calls this month.</p>
      <button type="button" className="btn" disabled={t.busy} onClick={() => t.run(async () => toast(`The service answered: ${(await testService(ws.id, { id: service.id })).answer}`))}>
        {t.busy && <Spinner size={14} />} Test
      </button>
      <ErrorLine error={t.error} />
    </section>
  );
}

function ServiceCard({ ws, saved, disabled, onChanged }: { ws: WorkspaceInfo; saved?: AiServiceInfo; disabled: boolean; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(saved?.name ?? "");
  const [kind, setKind] = useState<"anthropic" | "openai">(saved?.kind === "anthropic" ? "anthropic" : "openai");
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [model, setModel] = useState(saved?.model ?? "");
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const action = useAction();
  const testAction = useAction();
  const form = (): ServiceForm => ({ name, kind, baseUrl: kind === "openai" ? baseUrl : undefined, model, key: key || undefined });
  const save = (e: FormEvent) => {
    e.preventDefault();
    action.run(async () => {
      if (saved) await saveService(ws.id, saved.id, form());
      else await addService(ws.id, form());
      setKey("");
      await onChanged();
      toast(saved ? `${name} saved` : `${name} added`);
    });
  };
  const remove = () =>
    action.run(async () => {
      if (!saved || !confirmDialog(`Remove the AI service ${saved.name}? AI fields that use it stop generating.`)) return;
      await removeService(ws.id, saved.id);
      await onChanged();
    });
  const test = () =>
    testAction.run(async () => {
      const r = await testService(ws.id, { ...form(), id: saved?.id });
      toast(`The service answered: ${r.answer}`);
    });
  const preset = (label: string) => {
    const p = PRESETS.find(x => x.label === label);
    if (!p) return;
    setKind(p.kind);
    setBaseUrl(p.baseUrl ?? "");
    if (p.model) setModel(p.model);
    if (!name) setName(p.label);
    setNote(p.note ?? "");
  };
  return (
    <section className="card section">
      <h2>{saved ? saved.name : "Add a service"}</h2>
      {saved && (
        <p className="section-desc">
          {KIND_LABELS[saved.kind]}, {saved.calls.toLocaleString()} calls this month.
          {saved.keyRejected && <span className="page-err-inline"> The key was rejected; enter a new key and save.</span>}
        </p>
      )}
      <form className="stack narrow" onSubmit={save}>
        {!saved && (
          <>
            <label className="field-label">Preset</label>
            <select className="input" value="" onChange={e => preset(e.target.value)} aria-label="Preset">
              <option value="">Choose a provider to fill the form</option>
              {PRESETS.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
            </select>
          </>
        )}
        <label className="field-label">Name</label>
        <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="DeepSeek" required maxLength={60} />
        <label className="field-label">Kind</label>
        <select className="input" value={kind} onChange={e => setKind(e.target.value as "anthropic" | "openai")}>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
        </select>
        {kind === "openai" && (
          <>
            <label className="field-label">Address</label>
            <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" required />
          </>
        )}
        {note && <p className="muted small">{note}</p>}
        <label className="field-label">Model</label>
        <input className="input" value={model} onChange={e => setModel(e.target.value)} placeholder="Model name from the provider" required />
        <label className="field-label">API key</label>
        <input className="input" type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={saved?.last4 ? `Saved, ends in ${saved.last4}. Leave empty to keep it.` : ""} autoComplete="new-password" />
        <ErrorLine error={action.error} />
        <div className="row">
          <Submit busy={action.busy} disabled={disabled}>{saved ? "Save" : "Add service"}</Submit>
          <button type="button" className="btn" onClick={test} disabled={testAction.busy}>{testAction.busy && <Spinner size={14} />} Test</button>
          {saved && <button type="button" className="btn btn-danger" onClick={remove}>Remove</button>}
        </div>
        <ErrorLine error={testAction.error} />
      </form>
    </section>
  );
}
