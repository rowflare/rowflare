// CSV import (parsed in the browser, types inferred) and direct Airtable import (runs on the server).
import { useMemo, useState } from "react";
import Papa from "papaparse";
import type { FieldInput } from "../../worker/base/store";
import type { FieldType } from "../../shared/types";
import { FIELD_TYPES } from "../../shared/types";
import { parseDate, parseNumber } from "../../shared/cells";
import type { BaseClient } from "./client";
import { Button, Modal, Spinner } from "../ui";
import { toastError, toast } from "../toast";
import { post } from "../api";
import { navigate } from "../router";

const IMPORTABLE: FieldType[] = ["text", "longText", "number", "singleSelect", "multiSelect", "date", "checkbox", "email", "url", "phone"];

export function inferType(values: string[]): FieldType {
  const v = values.map(x => x.trim()).filter(Boolean);
  if (!v.length) return "text";
  if (v.every(x => parseNumber(x) !== null)) return "number";
  if (v.every(x => /^(true|false|yes|no|checked|unchecked|x|0|1)$/i.test(x)) && v.some(x => /^(true|yes|checked|x)$/i.test(x))) return "checkbox";
  if (v.every(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) return "email";
  if (v.every(x => /^https?:\/\/\S+$/i.test(x))) return "url";
  if (v.every(x => /\d/.test(x) && parseDate(x) !== null && !/^\d+$/.test(x))) return "date";
  if (v.some(x => x.includes("\n")) || v.some(x => x.length > 120)) return "longText";
  const distinct = new Set(v);
  if (v.length >= 6 && distinct.size <= 15 && distinct.size <= v.length / 2) return "singleSelect";
  return "text";
}

export function ImportCsv({ client, onClose }: { client: BaseClient; onClose: () => void }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [name, setName] = useState("");
  const [types, setTypes] = useState<FieldType[]>([]);
  const [headerRow, setHeaderRow] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);

  const header = useMemo(() => (rows ? (headerRow ? rows[0] : rows[0].map((_, i) => `Field ${i + 1}`)) : []), [rows, headerRow]);
  const body = useMemo(() => (rows ? (headerRow ? rows.slice(1) : rows) : []), [rows, headerRow]);

  const onFile = (file: File) => {
    setName(file.name.replace(/\.(csv|tsv|txt)$/i, ""));
    Papa.parse<string[]>(file, {
      skipEmptyLines: "greedy",
      complete: res => {
        const data = res.data.filter(r => r.some(c => c.trim()));
        if (!data.length) return toastError(new Error("The file is empty"));
        const width = Math.max(...data.map(r => r.length));
        const norm = data.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ""));
        setRows(norm);
        const sample = norm.slice(1, 501);
        setTypes(Array.from({ length: width }, (_, i) => inferType(sample.map(r => r[i]))));
      },
      error: err => toastError(err),
    });
  };

  const run = async () => {
    if (!rows) return;
    setProgress(0);
    try {
      const seen = new Set<string>();
      const fields: FieldInput[] = header.map((h, i) => {
        let n = h.trim() || `Field ${i + 1}`;
        let k = 2;
        while (seen.has(n.toLowerCase())) n = `${h.trim() || "Field"} ${k++}`;
        seen.add(n.toLowerCase());
        // The primary field must be a plain type.
        const type = i === 0 && ["checkbox", "multiSelect"].includes(types[i]) ? "text" : types[i];
        return { name: n, type };
      });
      // Refused before anything is written when the records do not fit the plan.
      await post(`/api/bases/${client.baseId}/rows/check`, { count: body.length });
      const res = await client.schemaOp({ op: "createTable", name: name.trim() || "Imported table", fields });
      const tableId = res.id!;
      const fieldIds = client.fields(tableId).sort((a, b) => (a.ord < b.ord ? -1 : 1)).map(f => f.id);
      const batch = 500;
      for (let i = 0; i < body.length; i += batch) {
        const chunk = body.slice(i, i + batch).map(r => ({ cells: Object.fromEntries(r.map((v, j) => [fieldIds[j], v])) }));
        await post(`/api/bases/${client.baseId}/rows`, { op: "create", tableId, rows: chunk, typecast: true, source: "import", clientId: client.clientId });
        setProgress(Math.min(body.length, i + batch));
      }
      toast(`Imported ${body.length.toLocaleString()} records`);
      navigate(`/base/${client.baseId}/${tableId}`);
      onClose();
    } catch (e) {
      toastError(e);
      setProgress(null);
    }
  };

  return (
    <Modal title="Import CSV" onClose={onClose} width={760} footer={rows && (
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={run} disabled={progress !== null}>
          {progress !== null ? <><Spinner size={14} /> {progress.toLocaleString()} / {body.length.toLocaleString()}</> : `Import ${body.length.toLocaleString()} records`}
        </Button>
      </>
    )}>
      {!rows ? (
        <label className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}>
          <input type="file" accept=".csv,.tsv,.txt,text/csv" hidden onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
          <strong>Choose a CSV file</strong>
          <span className="muted">or drop it here. Exports from Airtable, Excel and Google Sheets work.</span>
        </label>
      ) : (
        <div className="stack">
          <div className="row">
            <label className="grow">
              <span className="field-label">Table name</span>
              <input className="input" value={name} onChange={e => setName(e.target.value)} />
            </label>
            <label className="row small" style={{ alignSelf: "flex-end", height: 34 }}>
              <input type="checkbox" checked={headerRow} onChange={e => setHeaderRow(e.target.checked)} /> First row is the header
            </label>
          </div>
          <div className="import-preview">
            <table>
              <thead>
                <tr>
                  {header.map((h, i) => (
                    <th key={i}>
                      <div className="ellipsis">{h || `Field ${i + 1}`}</div>
                      <select className="input" value={types[i]} onChange={e => setTypes(t => t.map((x, j) => (j === i ? (e.target.value as FieldType) : x)))}>
                        {IMPORTABLE.map(t => <option key={t} value={t}>{FIELD_TYPES.find(x => x.type === t)?.label}</option>)}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.slice(0, 8).map((r, i) => (
                  <tr key={i}>{r.map((c, j) => <td key={j}><div className="ellipsis">{c}</div></td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Select and multiple select options are created from the values. Links can be added after import by converting a text field to "Link to another record".</p>
        </div>
      )}
    </Modal>
  );
}

export function ImportAirtable({ client, onClose }: { client: BaseClient; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [baseId, setBaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await post(`/api/bases/${client.baseId}/import/airtable`, { token, airtableBaseId: baseId });
      toast("Import started. Tables appear as they are copied.");
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Import from Airtable" onClose={onClose} width={560} footer={
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={start} disabled={busy || !token.trim() || !/app[A-Za-z0-9]{14}/.test(baseId)}>{busy ? <Spinner size={14} /> : null} Start import</Button>
      </>
    }>
      <div className="stack">
        <p className="muted">Copies tables, fields, records, links, lookups, rollups, formulas and attachments into this base. Attachments are stored in your own R2 bucket.</p>
        <ol className="steps">
          <li>In Airtable, open <a href="https://airtable.com/create/tokens" target="_blank" rel="noreferrer">Developer hub, Personal access tokens</a> and create a token with the scopes <code>schema.bases:read</code> and <code>data.records:read</code>, with access to the base.</li>
          <li>Copy the base id from the Airtable URL: it starts with <code>app</code>.</li>
        </ol>
        <label>
          <span className="field-label">Personal access token</span>
          <input className="input mono" type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="pat..." autoComplete="off" />
        </label>
        <label>
          <span className="field-label">Base id or URL</span>
          <input className="input mono" value={baseId} onChange={e => setBaseId(e.target.value)} placeholder="appXXXXXXXXXXXXXX" />
        </label>
        <p className="muted small">The token is used only for this import and is not stored after it finishes. Interfaces, automations, extensions and comments are not imported.</p>
      </div>
    </Modal>
  );
}
