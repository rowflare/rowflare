// Expanded record: every field with its full editor, previous / next navigation and record actions.
import { useEffect } from "react";
import type { View } from "../../shared/types";
import { COMPUTED_TYPES } from "../../shared/types";
import { BaseClient, primaryText, useBase } from "./client";
import { FieldValueEditor, formatDate } from "./editors";
import { rawValue } from "./cells";
import { FieldIcon, Icon, Modal, Spinner } from "../ui";
import { toast } from "../toast";
import { runButtonField } from "../auto/button";
import { AI_STATE_TEXT } from "../ai/aiCell";

export default function RecordModal({ client, view, rowId, onClose, onNavigate }: { client: BaseClient; view: View; rowId: number; onClose: () => void; onNavigate: (id: number) => void }) {
  useBase(client);
  const tableId = view.tableId;
  const row = client.row(tableId, rowId);
  const ids = client.viewState(view.id)?.ids ?? [];
  const idx = ids.indexOf(rowId);
  useEffect(() => {
    if (!row) client.ensureRows(tableId, [rowId]);
  }, [row, client, tableId, rowId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.key === "ArrowDown" || e.key === "j") && idx >= 0 && idx < ids.length - 1) onNavigate(ids[idx + 1]);
      if ((e.key === "ArrowUp" || e.key === "k") && idx > 0) onNavigate(ids[idx - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, ids, onNavigate]);

  const fields = client.orderedFields(view);
  const title = row ? primaryText(client, tableId, row) || "Unnamed record" : "Loading";
  const ctx = { members: client.members, searchLinked: (t: string, q: string) => client.searchRecords(t, q), upload: (f: File) => client.uploadAttachment(f) };

  return (
    <Modal
      width={720}
      onClose={onClose}
      title={
        <div className="row record-head">
          <button className="icon-btn" disabled={idx <= 0} onClick={() => onNavigate(ids[idx - 1])} aria-label="Previous record"><Icon name="chevron" className="flip" /></button>
          <button className="icon-btn" disabled={idx < 0 || idx >= ids.length - 1} onClick={() => onNavigate(ids[idx + 1])} aria-label="Next record"><Icon name="chevron" /></button>
          <span className="record-title">{title}</span>
        </div>
      }
      footer={
        row && (
          <div className="row record-foot">
            <span className="muted small grow">
              Created {formatDate(row.createdAt, true)}{row.createdBy ? ` by ${client.memberName(row.createdBy)}` : ""} · Updated {formatDate(row.updatedAt, true)}
            </span>
            {client.writable && (
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  const next = ids[idx + 1] ?? ids[idx - 1];
                  client.deleteRows(tableId, [rowId]);
                  toast("Record deleted", "info", { label: "Undo", run: () => client.undo() });
                  if (next !== undefined) onNavigate(next);
                  else onClose();
                }}
              >
                <Icon name="trash" size={14} /> Delete
              </button>
            )}
          </div>
        )
      }
    >
      {!row ? (
        <div className="center-page"><Spinner /></div>
      ) : (
        <div className="record-fields">
          {fields.map(f => (
            <div key={f.id} className="record-field">
              <label className="field-label row">
                <FieldIcon type={f.type} size={13} /> {f.name}
                {COMPUTED_TYPES.has(f.type) && f.type !== "button" && <span className="muted small">computed</span>}
                {f.options.ai && <span className="muted small" style={{ marginLeft: 6 }}>AI</span>}
              </label>
              {f.description && <div className="muted small field-help">{f.description}</div>}
              {f.type === "button" ? (
                <div>
                  <button className="btn btn-sm" style={{ background: f.options.color ?? "var(--chip)" }} disabled={client.buttonBusy.has(`${f.id}:${rowId}`)} onClick={() => runButtonField(client, f, rowId)}>
                    {client.buttonBusy.has(`${f.id}:${rowId}`) ? "Running..." : f.options.label || "Run"}
                  </button>
                </div>
              ) : (
                <FieldValueEditor
                  field={f}
                  value={rawValue(f, row)}
                  readOnly={!client.writable}
                  compact
                  ctx={ctx}
                  onChange={(v, opts) => client.updateCells(tableId, [{ id: rowId, cells: { [f.id]: v } }], { typecast: opts?.typecast })}
                />
              )}
              {f.options.ai && (
                <div className="row small ai-record-state">
                  {row.ai?.[f.id] && <span className={row.ai[f.id].s === "error" ? "err" : "muted"}>{row.ai[f.id].s === "error" ? row.ai[f.id].e ?? AI_STATE_TEXT.error : AI_STATE_TEXT[row.ai[f.id].s]}</span>}
                  {client.writable && (
                    <button className="link-btn" onClick={() => client.aiGenerate(tableId, f.id, { rowIds: [rowId] }).catch(e => toast(String(e.message ?? e), "error"))}>
                      Regenerate
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
