// Record cards shared by kanban, gallery and calendar: cover image, title, first fields with a value.
import type { ReactNode } from "react";
import type { Attachment, Field, Row, View } from "../../shared/types";
import { fileUrl } from "../api";
import { Icon, Popover } from "../ui";
import { type BaseClient, primaryText } from "./client";
import { CellDisplay, isImage } from "./editors";

export const CARD_FIELDS = 4;

/** Value of a field on a row, including the system fields that are not stored in cells. */
export function valueOf(f: Field, row: Row): unknown {
  if (f.type === "autonumber") return row.id;
  if (f.type === "createdTime") return row.createdAt;
  if (f.type === "modifiedTime") return row.updatedAt;
  return row.cells[f.id];
}

export const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

/** Visible fields for card bodies: everything shown in the view except the primary field and `exclude`. */
export function cardFields(client: BaseClient, view: View, exclude: string[] = []): Field[] {
  const primary = client.table(view.tableId)?.primaryFieldId;
  return client.visibleFields(view).filter(f => f.id !== primary && !exclude.includes(f.id));
}

export function coverField(client: BaseClient, view: View): Field | undefined {
  const f = client.field(view.config.coverFieldId ?? "");
  return f && f.type === "attachment" && f.tableId === view.tableId ? f : undefined;
}

export function RecordCard(props: {
  client: BaseClient;
  tableId: string;
  id: number;
  fields: Field[];
  cover?: Field;
  onOpen: (id: number) => void;
  onMenu?: (anchor: HTMLElement) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { client, tableId, id, fields, cover, onOpen, onMenu } = props;
  const row = client.row(tableId, id);
  if (!row) {
    return (
      <div data-card className={"kb-card kb-skeleton " + (props.className ?? "")} style={props.style}>
        <span className="kb-skel kb-skel-title" />
        <span className="kb-skel" />
      </div>
    );
  }
  const title = primaryText(client, tableId, row);
  const img = cover ? ((row.cells[cover.id] as Attachment[] | undefined) ?? []).find(isImage) : undefined;
  const values = fields.map(f => ({ f, v: valueOf(f, row) })).filter(x => !isEmpty(x.v)).slice(0, CARD_FIELDS);
  return (
    <div
      data-card
      className={"kb-card " + (props.className ?? "")}
      style={props.style}
      role="button"
      tabIndex={0}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onClick={e => {
        if ((e.target as HTMLElement).closest("a, .kb-card-menu")) return;
        onOpen(id);
      }}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(id);
        }
      }}
    >
      {img && (
        <div className="kb-cover">
          <img src={fileUrl(img.key)} alt="" loading="lazy" draggable={false} />
        </div>
      )}
      <div className="kb-card-body">
        <div className="kb-card-title-row">
          <div className={"kb-card-title" + (title ? "" : " muted")}>{title || "Unnamed record"}</div>
          {onMenu && (
            <button
              className="icon-btn kb-card-menu"
              aria-label="Card actions"
              onClick={e => {
                e.stopPropagation();
                onMenu(e.currentTarget);
              }}
            >
              <Icon name="dots" size={16} />
            </button>
          )}
        </div>
        {values.map(({ f, v }) => (
          <div key={f.id} className="kb-field">
            <div className="kb-field-name">{f.name}</div>
            <div className="kb-field-value">
              <CellDisplay field={f} value={v} members={client.members} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Cover and card field settings; view-specific controls go in `children` above them. */
export function CardSettings({ client, view, anchor, onClose, exclude = [], children }: { client: BaseClient; view: View; anchor: HTMLElement; onClose: () => void; exclude?: string[]; children?: ReactNode }) {
  const t = client.table(view.tableId);
  const all = client.orderedFields(view);
  const attachments = all.filter(f => f.type === "attachment");
  const hidden = new Set(view.config.hidden ?? []);
  const list = all.filter(f => f.id !== t?.primaryFieldId && !exclude.includes(f.id));
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    client.updateViewConfig(view.id, { hidden: [...next] });
  };
  const ro = !client.writable;
  return (
    <Popover anchor={anchor} onClose={onClose} width={300} align="end" className="kb-settings">
      {children}
      <label className="field-label">Card cover</label>
      <select className="input" disabled={ro} value={view.config.coverFieldId ?? ""} onChange={e => client.updateViewConfig(view.id, { coverFieldId: e.target.value || undefined })}>
        <option value="">No cover</option>
        {attachments.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <div className="kb-settings-head">
        <label className="field-label">Fields on cards</label>
        <span className="muted small">First {CARD_FIELDS} with a value</span>
      </div>
      <div className="kb-settings-fields">
        {list.length === 0 && <div className="muted small">No other fields</div>}
        {list.map(f => (
          <label key={f.id} className="kb-settings-field">
            <input type="checkbox" checked={!hidden.has(f.id)} disabled={ro} onChange={() => toggle(f.id)} />
            <Icon name={f.type} size={14} />
            <span className="grow">{f.name}</span>
          </label>
        ))}
      </div>
    </Popover>
  );
}
