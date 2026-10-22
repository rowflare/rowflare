// Setup screen for calendar and timeline views that have no usable date field yet.
import { useState } from "react";
import type { Field, View } from "../../shared/types";
import { isDateField } from "../../shared/types";
import { toastError } from "../toast";
import { Button, Icon } from "../ui";
import type { BaseClient } from "./client";

export const dateFields = (client: BaseClient, tableId: string): Field[] => client.fields(tableId).filter(isDateField);

export function DateSetup({ client, view, icon, title, text }: { client: BaseClient; view: View; icon: string; title: string; text: string }) {
  const options = dateFields(client, view.tableId);
  const [busy, setBusy] = useState(false);
  const stale = !!view.config.dateFieldId;
  const create = async () => {
    setBusy(true);
    try {
      const res = await client.schemaOp({ op: "createField", tableId: view.tableId, field: { name: "Date", type: "date" } });
      if (res.id) client.updateViewConfig(view.id, { dateFieldId: res.id });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kb-setup">
      <div className="kb-setup-card card">
        <div className="kb-setup-icon"><Icon name={icon} size={22} /></div>
        <h3>{title}</h3>
        {stale && <p className="muted">The date field was removed or changed; pick another.</p>}
        {options.length ? (
          <>
            <p className="muted">{text}</p>
            <select className="input" value="" disabled={!client.writable} onChange={e => e.target.value && client.updateViewConfig(view.id, { dateFieldId: e.target.value })}>
              <option value="">Select a date field...</option>
              {options.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </>
        ) : (
          <>
            <p className="muted">This table has no date field yet.</p>
            {client.writable && <Button variant="primary" icon="plus" disabled={busy} onClick={create}>Add a Date field</Button>}
          </>
        )}
      </div>
    </div>
  );
}
