// Value display and editors for every field type. Used by the record modal, kanban cards,
// grid popover editors and the public form page.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Choice, Field, LinkValue, Member } from "../../shared/types";
import { COMPUTED_TYPES } from "../../shared/types";
import { displayCell, formatNumber, parseNumber } from "../../shared/cells";
import { fileUrl } from "../api";
import { Icon, Popover, Spinner } from "../ui";
import { toastError } from "../toast";

export interface EditorContext {
  members?: Member[];
  searchLinked?: (tableId: string, q: string) => Promise<LinkValue[]>;
  upload?: (file: File) => Promise<Attachment>;
  /** Attachment URLs are not readable on public forms. */
  noPreview?: boolean;
  /** Hide "Create option" in select pickers (public forms). */
  noCreate?: boolean;
}

export type Commit = (value: unknown, opts?: { typecast?: boolean }) => void;

export function Chip({ name, color, onRemove, title }: { name: string; color?: string; onRemove?: () => void; title?: string }) {
  return (
    <span className="chip" style={{ background: color ?? "var(--chip)" }} title={title ?? name}>
      <span className="chip-text">{name}</span>
      {onRemove && (
        <button type="button" className="chip-x" onClick={e => { e.stopPropagation(); onRemove(); }} aria-label={`Remove ${name}`}>
          <Icon name="x" size={11} />
        </button>
      )}
    </span>
  );
}

const choiceOf = (f: Field, id: unknown): Choice | undefined => f.options.choices?.find(c => c.id === id);

export function isImage(a: Attachment) {
  return /^image\//.test(a.type) || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(a.name);
}

export function formatDate(v: unknown, withTime: boolean): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  const d = new Date(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00Z" : v);
  if (Number.isNaN(d.getTime())) return String(v);
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", timeZone: withTime ? undefined : "UTC" };
  if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString("en-US", opts);
}

/** Plain-text rendering used by grid cells and copy. */
export function cellText(f: Field, v: unknown, members: Member[] = []): string {
  if (v === null || v === undefined) return "";
  const userName = (id: string) => members.find(m => m.id === id)?.name ?? "Unknown";
  if (f.type === "date") return formatDate(v, !!f.options.includeTime);
  if (f.type === "createdTime" || f.type === "modifiedTime") return formatDate(v, true);
  if ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "date") return formatDate(v, typeof v === "string" && v.length > 10);
  if ((f.type === "formula" || f.type === "rollup") && typeof v === "number") return f.options.format ? formatNumber(f, v) : String(Math.round(v * 1e10) / 1e10);
  if (f.type === "lookup" && Array.isArray(v)) return v.map(x => (typeof x === "object" && x && "name" in x ? (x as Attachment).name : x === true ? "checked" : String(x ?? ""))).join(", ");
  return displayCell(f, v, { userName });
}

/** Rich read-only rendering (chips, thumbnails, checkmarks). */
export function CellDisplay({ field, value, members = [], ctx }: { field: Field; value: unknown; members?: Member[]; ctx?: EditorContext }) {
  if (value === null || value === undefined || value === "") return <span className="muted">-</span>;
  switch (field.type) {
    case "singleSelect": {
      const c = choiceOf(field, value);
      return c ? <Chip name={c.name} color={c.color} /> : null;
    }
    case "multiSelect":
      return (
        <span className="chips">
          {(value as string[]).map(id => choiceOf(field, id)).filter(Boolean).map(c => <Chip key={c!.id} name={c!.name} color={c!.color} />)}
        </span>
      );
    case "link":
      return <span className="chips">{(value as LinkValue[]).map(v => <Chip key={v.id} name={v.t || "Unnamed record"} color="var(--link-chip)" />)}</span>;
    case "user":
      return <span className="chips">{(Array.isArray(value) ? value : [value]).map(id => <Chip key={String(id)} name={members.find(m => m.id === id)?.name ?? "Unknown"} color="var(--user-chip)" />)}</span>;
    case "checkbox":
      return value ? <Icon name="check" className="check-on" /> : null;
    case "attachment":
      return <AttachmentStrip list={value as Attachment[]} noPreview={ctx?.noPreview} />;
    case "url":
      return <a href={String(value)} target="_blank" rel="noreferrer noopener" onClick={e => e.stopPropagation()}>{String(value)}</a>;
    case "email":
      return <a href={`mailto:${value}`} onClick={e => e.stopPropagation()}>{String(value)}</a>;
    case "longText":
      return <span className="pre">{String(value)}</span>;
    case "lookup":
      if (Array.isArray(value) && value.some(x => typeof x === "object" && x && "key" in x)) return <AttachmentStrip list={value as Attachment[]} noPreview={ctx?.noPreview} />;
      return <span className="chips">{(value as unknown[]).map((x, i) => <Chip key={i} name={x === true ? "checked" : String(x ?? "")} color="var(--chip)" />)}</span>;
    default:
      return <span>{cellText(field, value, members)}</span>;
  }
}

function AttachmentStrip({ list, noPreview, onRemove }: { list: Attachment[]; noPreview?: boolean; onRemove?: (a: Attachment) => void }) {
  return (
    <span className="attachments">
      {list.map(a => (
        <span key={a.id} className="attachment" title={a.name}>
          {!noPreview && isImage(a) ? (
            <a href={fileUrl(a.key)} target="_blank" rel="noreferrer"><img src={fileUrl(a.key)} alt={a.name} loading="lazy" /></a>
          ) : noPreview ? (
            <span className="file-tile"><Icon name="attachment" size={14} /> {a.name}</span>
          ) : (
            <a className="file-tile" href={fileUrl(a.key)} target="_blank" rel="noreferrer"><Icon name="attachment" size={14} /> {a.name}</a>
          )}
          {onRemove && (
            <button type="button" className="chip-x" onClick={() => onRemove(a)} aria-label={`Remove ${a.name}`}><Icon name="x" size={11} /></button>
          )}
        </span>
      ))}
    </span>
  );
}

/** Editor for one value. `autoFocus` puts the caret in text inputs (grid overlay). */
export function FieldValueEditor({ field, value, onChange, ctx = {}, autoFocus, readOnly, onDone, compact }: {
  field: Field;
  value: unknown;
  onChange: Commit;
  ctx?: EditorContext;
  autoFocus?: boolean;
  readOnly?: boolean;
  onDone?: () => void;
  /** Show pickers (select, link, user) as chips that open a popover, for record and form layouts. */
  compact?: boolean;
}) {
  if (compact && !readOnly && ["singleSelect", "multiSelect", "link", "user"].includes(field.type)) return <CompactPicker field={field} value={value} onChange={onChange} ctx={ctx} />;
  if (readOnly || COMPUTED_TYPES.has(field.type)) return <div className="ro-value"><CellDisplay field={field} value={value} members={ctx.members} ctx={ctx} /></div>;
  switch (field.type) {
    case "text":
    case "email":
    case "url":
    case "phone":
      return <TextInput value={value as string} onCommit={v => onChange(v || null)} autoFocus={autoFocus} onDone={onDone} type={field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "phone" ? "tel" : "text"} />;
    case "longText":
      return <TextArea value={value as string} onCommit={v => onChange(v || null)} autoFocus={autoFocus} onDone={onDone} />;
    case "number":
      return <TextInput value={value === undefined || value === null ? "" : String(value)} inputMode="decimal" onCommit={v => onChange(v.trim() === "" ? null : parseNumber(v))} autoFocus={autoFocus} onDone={onDone} />;
    case "checkbox":
      return (
        <label className="checkbox-edit">
          <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} autoFocus={autoFocus} />
        </label>
      );
    case "date":
      return <DateInput field={field} value={value as string} onCommit={v => onChange(v)} autoFocus={autoFocus} onDone={onDone} />;
    case "singleSelect":
    case "multiSelect":
      return <SelectEditor field={field} value={value} onChange={onChange} autoFocus={autoFocus} onDone={onDone} noCreate={ctx.noCreate} />;
    case "link":
      return <LinkEditor field={field} value={(value as LinkValue[]) ?? []} onChange={onChange} ctx={ctx} autoFocus={autoFocus} />;
    case "user":
      return <UserEditor field={field} value={value} onChange={onChange} members={ctx.members ?? []} autoFocus={autoFocus} onDone={onDone} />;
    case "attachment":
      return <AttachmentEditor value={(value as Attachment[]) ?? []} onChange={onChange} ctx={ctx} />;
    default:
      return <CellDisplay field={field} value={value} members={ctx.members} />;
  }
}

function CompactPicker({ field, value, onChange, ctx }: { field: Field; value: unknown; onChange: Commit; ctx: EditorContext }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const empty = value === null || value === undefined || (Array.isArray(value) && !value.length);
  return (
    <div className="compact-picker">
      <button type="button" className="compact-picker-box" onClick={e => setAnchor(e.currentTarget)}>
        {empty ? <span className="muted">{field.type === "link" ? "Add a record" : field.type === "user" ? "Add a person" : "Choose an option"}</span> : <CellDisplay field={field} value={value} members={ctx.members} ctx={ctx} />}
        <Icon name="chevron" size={14} className="push" />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={Math.max(280, anchor.offsetWidth)}>
          <FieldValueEditor field={field} value={value} onChange={onChange} ctx={ctx} autoFocus onDone={() => setAnchor(null)} />
        </Popover>
      )}
    </div>
  );
}

function TextInput({ value, onCommit, autoFocus, onDone, type = "text", inputMode }: { value: string | undefined; onCommit: (v: string) => void; autoFocus?: boolean; onDone?: () => void; type?: string; inputMode?: "decimal" }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <input
      className="input"
      type={type}
      inputMode={inputMode}
      value={draft}
      autoFocus={autoFocus}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => draft !== (value ?? "") && onCommit(draft)}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (draft !== (value ?? "")) onCommit(draft);
          onDone?.();
        }
        if (e.key === "Escape") {
          setDraft(value ?? "");
          onDone?.();
        }
      }}
    />
  );
}

function TextArea({ value, onCommit, autoFocus, onDone }: { value: string | undefined; onCommit: (v: string) => void; autoFocus?: boolean; onDone?: () => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <textarea
      className="input textarea"
      value={draft}
      autoFocus={autoFocus}
      rows={5}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => draft !== (value ?? "") && onCommit(draft)}
      onKeyDown={e => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (draft !== (value ?? "")) onCommit(draft);
          onDone?.();
        }
        if (e.key === "Escape") onDone?.();
      }}
    />
  );
}

function DateInput({ field, value, onCommit, autoFocus, onDone }: { field: Field; value: string | undefined; onCommit: (v: string | null) => void; autoFocus?: boolean; onDone?: () => void }) {
  const withTime = !!field.options.includeTime;
  const toLocal = (iso: string | undefined) => {
    if (!iso) return "";
    if (!withTime) return iso.slice(0, 10);
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return (
    <input
      className="input"
      type={withTime ? "datetime-local" : "date"}
      defaultValue={toLocal(value)}
      autoFocus={autoFocus}
      onChange={e => {
        const v = e.target.value;
        if (!v) return onCommit(null);
        onCommit(withTime ? new Date(v).toISOString() : v);
      }}
      onKeyDown={e => (e.key === "Enter" || e.key === "Escape") && onDone?.()}
    />
  );
}

function useFilter<T>(items: T[], query: string, text: (t: T) => string) {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter(i => text(i).toLowerCase().includes(q)) : items;
  }, [items, query, text]);
}

function SelectEditor({ field, value, onChange, autoFocus, onDone, noCreate }: { field: Field; value: unknown; onChange: Commit; autoFocus?: boolean; onDone?: () => void; noCreate?: boolean }) {
  const multi = field.type === "multiSelect";
  const selected: string[] = multi ? ((value as string[]) ?? []) : value ? [value as string] : [];
  const [q, setQ] = useState("");
  const choices = field.options.choices ?? [];
  const list = useFilter(choices, q, c => c.name);
  const [active, setActive] = useState(0);
  const exact = choices.some(c => c.name.toLowerCase() === q.trim().toLowerCase());
  const toggle = (c: Choice) => {
    if (multi) onChange(selected.includes(c.id) ? selected.filter(id => id !== c.id) : [...selected, c.id]);
    else {
      onChange(selected[0] === c.id ? null : c.id);
      onDone?.();
    }
    setQ("");
  };
  const create = () => {
    const name = q.trim();
    if (!name || noCreate) return;
    onChange(multi ? [...selected, name] : name, { typecast: true });
    setQ("");
    if (!multi) onDone?.();
  };
  return (
    <div className="picker">
      {selected.length > 0 && (
        <div className="chips picker-selected">
          {selected.map(id => choiceOf(field, id)).filter(Boolean).map(c => (
            <Chip key={c!.id} name={c!.name} color={c!.color} onRemove={() => onChange(multi ? selected.filter(x => x !== c!.id) : null)} />
          ))}
        </div>
      )}
      <input
        className="input"
        placeholder={noCreate ? "Find an option" : choices.length ? "Find or create an option" : "Type to create an option"}
        value={q}
        autoFocus={autoFocus}
        onChange={e => { setQ(e.target.value); setActive(0); }}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, list.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          if (e.key === "Enter") {
            e.preventDefault();
            if (list[active] && (exact || !q.trim() || list.length)) toggle(list[active]);
            else create();
          }
          if (e.key === "Escape") onDone?.();
        }}
      />
      <div className="picker-list">
        {list.map((c, i) => (
          <button type="button" key={c.id} className={"picker-item" + (i === active ? " active" : "")} onMouseEnter={() => setActive(i)} onClick={() => toggle(c)}>
            <Chip name={c.name} color={c.color} />
            {selected.includes(c.id) && <Icon name="check" size={14} />}
          </button>
        ))}
        {q.trim() && !exact && !noCreate && (
          <button type="button" className="picker-item create" onClick={create}>
            <Icon name="plus" size={14} /> Create "{q.trim()}"
          </button>
        )}
      </div>
    </div>
  );
}

function LinkEditor({ field, value, onChange, ctx, autoFocus }: { field: Field; value: LinkValue[]; onChange: Commit; ctx: EditorContext; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LinkValue[] | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!ctx.searchLinked || !field.options.linkedTableId) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      ctx.searchLinked!(field.options.linkedTableId!, q).then(r => n === seq.current && setResults(r)).catch(toastError);
    }, q ? 150 : 0);
    return () => clearTimeout(t);
  }, [q, field.options.linkedTableId, ctx.searchLinked]);
  const ids = new Set(value.map(v => v.id));
  return (
    <div className="picker">
      {value.length > 0 && (
        <div className="chips picker-selected">
          {value.map(v => <Chip key={v.id} name={v.t || "Unnamed record"} color="var(--link-chip)" onRemove={() => onChange(value.filter(x => x.id !== v.id))} />)}
        </div>
      )}
      <input className="input" placeholder="Find a record" value={q} autoFocus={autoFocus} onChange={e => setQ(e.target.value)} />
      <div className="picker-list">
        {results === null && <div className="picker-empty"><Spinner size={14} /></div>}
        {results?.length === 0 && <div className="picker-empty muted">No records found</div>}
        {results?.map(r => (
          <button type="button" key={r.id} className="picker-item" onClick={() => onChange(ids.has(r.id) ? value.filter(v => v.id !== r.id) : [...value, r])}>
            <span className="link-title">{r.t || "Unnamed record"}</span>
            {ids.has(r.id) && <Icon name="check" size={14} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserEditor({ field, value, onChange, members, autoFocus, onDone }: { field: Field; value: unknown; onChange: Commit; members: Member[]; autoFocus?: boolean; onDone?: () => void }) {
  const multi = !!field.options.multiple;
  const selected: string[] = Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
  const [q, setQ] = useState("");
  const list = useFilter(members, q, m => m.name + " " + m.email);
  const toggle = (id: string) => {
    if (multi) onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
    else {
      onChange(selected[0] === id ? null : id);
      onDone?.();
    }
  };
  return (
    <div className="picker">
      <input className="input" placeholder="Find a collaborator" value={q} autoFocus={autoFocus} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Escape" && onDone?.()} />
      <div className="picker-list">
        {list.map(m => (
          <button type="button" key={m.id} className="picker-item" onClick={() => toggle(m.id)}>
            <span>{m.name} <span className="muted">{m.email}</span></span>
            {selected.includes(m.id) && <Icon name="check" size={14} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function AttachmentEditor({ value, onChange, ctx }: { value: Attachment[]; onChange: Commit; ctx: EditorContext }) {
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = async (files: FileList | File[]) => {
    if (!ctx.upload) return;
    const list = [...files];
    setBusy(b => b + list.length);
    const out: Attachment[] = [];
    for (const f of list) {
      try {
        out.push(await ctx.upload(f));
      } catch (e) {
        toastError(e);
      } finally {
        setBusy(b => b - 1);
      }
    }
    if (out.length) onChange([...value, ...out]);
  };
  return (
    <div
      className={"attach-edit" + (over ? " over" : "")}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
      onPaste={e => e.clipboardData.files.length && add(e.clipboardData.files)}
    >
      <AttachmentStrip list={value} noPreview={ctx.noPreview} onRemove={a => onChange(value.filter(x => x.id !== a.id))} />
      <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={!ctx.upload}>
        {busy ? <Spinner size={12} /> : <Icon name="upload" size={14} />} {busy ? `Uploading ${busy}` : "Add files"}
      </button>
      <span className="muted small">or drop files here</span>
      <input ref={input} type="file" multiple hidden onChange={e => e.target.files && add(e.target.files)} />
    </div>
  );
}
