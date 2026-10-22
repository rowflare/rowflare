// The records behind one number on a dashboard; a click opens the record.
import { useEffect, useState } from "react";
import type { Field, Row } from "../../shared/types";
import { displayCell } from "../../shared/cells";
import type { AggregateInput, GroupKey } from "../../worker/base/aggregate";
import { useBase, type BaseClient } from "../base/client";
import { Modal, Spinner } from "../ui";

export interface Drill {
  tableId: string;
  query: AggregateInput;
  key: GroupKey[];
  title: string;
}

const rawOf = (f: Field, r: Row) => (f.type === "createdTime" ? r.createdAt : f.type === "modifiedTime" ? r.updatedAt : f.type === "autonumber" ? r.id : r.cells[f.id]);

export function DrillList({ client, drill, onClose, onOpen }: { client: BaseClient; drill: Drill; onClose: () => void; onOpen: (tableId: string, id: number) => void }) {
  useBase(client);
  const [st, setSt] = useState<{ ids?: number[]; truncated?: boolean; error?: string }>({});
  useEffect(() => {
    client
      .aggregateRecords(drill.tableId, drill.query, drill.key)
      .then(r => {
        setSt(r);
        client.ensureRows(drill.tableId, r.ids);
      })
      .catch(e => setSt({ error: e instanceof Error ? e.message : String(e) }));
  }, [client, drill]);
  const view = client.viewsOf(drill.tableId)[0];
  const fields = view ? client.visibleFields(view).slice(0, 4) : [];
  return (
    <Modal title={drill.title} onClose={onClose} width={760}>
      {st.error ? (
        <p className="danger-text">{st.error}</p>
      ) : !st.ids ? (
        <div className="widget-empty"><Spinner /></div>
      ) : !st.ids.length ? (
        <p className="muted">No records</p>
      ) : (
        <>
          <p className="muted small">{st.truncated ? "Showing the first 500 records" : `${st.ids.length} record${st.ids.length === 1 ? "" : "s"}`}</p>
          <div className="drill-wrap">
            <table className="drill-table">
              <thead><tr>{fields.map(f => <th key={f.id}>{f.name}</th>)}</tr></thead>
              <tbody>
                {st.ids.map(id => {
                  const r = client.row(drill.tableId, id);
                  return (
                    <tr key={id} tabIndex={0} onClick={() => onOpen(drill.tableId, id)} onKeyDown={e => e.key === "Enter" && onOpen(drill.tableId, id)}>
                      {fields.map(f => <td key={f.id}>{r ? displayCell(f, rawOf(f, r), { userName: u => client.memberName(u) }) : "..."}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
