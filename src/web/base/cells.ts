// Maps Rowflare values to Glide Data Grid cells, plus a canvas renderer for colored chips.
import { GridCellKind, GridColumnIcon, type CustomCell, type CustomRenderer, type GridCell } from "@glideapps/glide-data-grid";
import type { Attachment, Field, FieldType, LinkValue, Member, Row } from "../../shared/types";
import { COMPUTED_TYPES } from "../../shared/types";
import { fileUrl } from "../api";
import { cellText, isImage } from "./editors";

export interface ChipsData {
  kind: "rf-chips";
  chips: { text: string; color: string }[];
  raw: unknown;
}

export type ChipsCell = CustomCell<ChipsData>;

/** Cells edited in our own popover instead of the grid overlay. */
export const POPOVER_TYPES: ReadonlySet<FieldType> = new Set(["singleSelect", "multiSelect", "link", "user", "attachment", "date", "longText"]);

export const HEADER_ICONS: Record<FieldType, string> = {
  text: GridColumnIcon.HeaderString,
  longText: GridColumnIcon.HeaderTextTemplate,
  email: GridColumnIcon.HeaderEmail,
  url: GridColumnIcon.HeaderUri,
  phone: GridColumnIcon.HeaderPhone,
  number: GridColumnIcon.HeaderNumber,
  singleSelect: GridColumnIcon.HeaderSingleValue,
  multiSelect: GridColumnIcon.HeaderArray,
  date: GridColumnIcon.HeaderDate,
  checkbox: GridColumnIcon.HeaderBoolean,
  attachment: GridColumnIcon.HeaderImage,
  link: GridColumnIcon.HeaderReference,
  lookup: GridColumnIcon.HeaderLookup,
  rollup: GridColumnIcon.HeaderRollup,
  formula: GridColumnIcon.HeaderMath,
  createdTime: GridColumnIcon.HeaderTime,
  modifiedTime: GridColumnIcon.HeaderTime,
  user: GridColumnIcon.HeaderEmoji,
  autonumber: GridColumnIcon.HeaderRowID,
  button: GridColumnIcon.HeaderString,
};

export const DEFAULT_WIDTH: Partial<Record<FieldType, number>> = { checkbox: 90, number: 120, date: 140, longText: 260, autonumber: 90 };

export function rawValue(f: Field, r: Row): unknown {
  if (f.type === "createdTime") return r.createdAt;
  if (f.type === "modifiedTime") return r.updatedAt;
  if (f.type === "autonumber") return r.id;
  return r.cells[f.id];
}

function chips(f: Field, v: unknown, members: Member[]): { text: string; color: string }[] {
  if (v === null || v === undefined) return [];
  switch (f.type) {
    case "singleSelect": {
      const c = f.options.choices?.find(x => x.id === v);
      return c ? [{ text: c.name, color: c.color }] : [];
    }
    case "multiSelect":
      return (v as string[]).map(id => f.options.choices?.find(x => x.id === id)).filter(Boolean).map(c => ({ text: c!.name, color: c!.color }));
    case "link":
      return (v as LinkValue[]).map(x => ({ text: x.t || "Unnamed record", color: "#e3ecfb" }));
    case "user":
      return (Array.isArray(v) ? v : [v]).map(id => ({ text: members.find(m => m.id === id)?.name ?? "Unknown", color: "#efe6fb" }));
    case "attachment":
      return (v as Attachment[]).map(a => ({ text: a.name, color: "#ece8e3" }));
    default:
      return (Array.isArray(v) ? v : [v]).map(x => ({ text: typeof x === "object" && x && "name" in x ? String((x as Attachment).name) : x === true ? "checked" : String(x ?? ""), color: "#ece8e3" }));
  }
}

export function toGridCell(f: Field, r: Row | undefined, writable: boolean, members: Member[], wrap: boolean, busy = false): GridCell {
  if (!r) return { kind: GridCellKind.Loading, allowOverlay: false };
  const v = rawValue(f, r);
  const ro = !writable || COMPUTED_TYPES.has(f.type);
  const text = cellText(f, v, members);
  switch (f.type) {
    case "text":
    case "email":
    case "phone":
      return { kind: GridCellKind.Text, data: (v as string) ?? "", displayData: text, allowOverlay: !ro, readonly: ro, allowWrapping: wrap, copyData: text };
    case "longText":
      return { kind: GridCellKind.Text, data: (v as string) ?? "", displayData: wrap ? text : text.replace(/\s*\n\s*/g, " "), allowOverlay: false, readonly: ro, allowWrapping: wrap, copyData: text };
    case "url":
      return { kind: GridCellKind.Uri, data: (v as string) ?? "", allowOverlay: !ro, readonly: ro, copyData: text };
    case "number":
      return { kind: GridCellKind.Number, data: typeof v === "number" ? v : undefined, displayData: text, allowOverlay: !ro, readonly: ro, contentAlign: "right", copyData: text };
    case "checkbox":
      return { kind: GridCellKind.Boolean, data: !!v, allowOverlay: false, readonly: ro };
    case "attachment": {
      const list = (v as Attachment[] | undefined) ?? [];
      if (list.length && list.every(isImage)) return { kind: GridCellKind.Image, data: list.map(a => fileUrl(a.key)), allowOverlay: false, readonly: true, copyData: text };
      return chipsCell(f, v, members, text);
    }
    case "singleSelect":
    case "multiSelect":
    case "link":
    case "user":
      return chipsCell(f, v, members, text);
    case "lookup":
      return chipsCell(f, v, members, text);
    case "formula":
    case "rollup":
      if (Array.isArray(v)) return chipsCell(f, v, members, text);
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, contentAlign: typeof v === "number" ? "right" : undefined, copyData: text };
    case "autonumber":
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, contentAlign: "right", copyData: text };
    case "button":
      return { kind: GridCellKind.Custom, data: { kind: "rf-button", label: f.options.label || "Run", color: f.options.color || "#ece8e3", busy }, copyData: "", allowOverlay: false, readonly: true, cursor: "pointer" } as ButtonCell;
    default:
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, copyData: text };
  }
}

function chipsCell(f: Field, v: unknown, members: Member[], text: string): ChipsCell {
  return { kind: GridCellKind.Custom, data: { kind: "rf-chips", chips: chips(f, v, members), raw: v ?? null }, copyData: text, allowOverlay: false, readonly: true };
}

/** Value written back to the server for a cell edited inside the grid (overlay, fill handle). */
export function valueFromCell(cell: GridCell): unknown {
  switch (cell.kind) {
    case GridCellKind.Text:
    case GridCellKind.Uri:
      return cell.data === "" ? null : cell.data;
    case GridCellKind.Number:
      return cell.data === undefined || Number.isNaN(cell.data) ? null : cell.data;
    case GridCellKind.Boolean:
      return cell.data === true;
    case GridCellKind.Custom:
      return (cell.data as ChipsData).raw ?? null;
    default:
      return undefined;
  }
}

export const chipsRenderer: CustomRenderer<ChipsCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is ChipsCell => (c.data as ChipsData | undefined)?.kind === "rf-chips",
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const pad = theme.cellHorizontalPadding;
    const h = 22;
    let x = rect.x + pad;
    const y = rect.y + rect.height / 2 - h / 2;
    const maxX = rect.x + rect.width - pad;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.font = `12.5px ${theme.fontFamily}`;
    ctx.textBaseline = "middle";
    for (const chip of cell.data.chips) {
      if (x > maxX) break;
      const w = Math.min(ctx.measureText(chip.text).width + 16, 220);
      ctx.fillStyle = chip.color;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 11);
      else ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.fillStyle = "#2b2723";
      let label = chip.text;
      if (w >= 220) {
        while (label.length > 1 && ctx.measureText(label + "...").width > w - 16) label = label.slice(0, -1);
        label += "...";
      }
      ctx.fillText(label, x + 8, y + h / 2 + 0.5);
      x += w + 4;
    }
    ctx.restore();
    return true;
  },
};

export interface GroupHeaderData {
  kind: "rf-group";
  label: string;
  count: number;
  level: number;
  collapsed: boolean;
}

export type GroupHeaderCell = CustomCell<GroupHeaderData>;

/** First cell of a group header row: chevron, group value and record count, indented by level. */
export const groupHeaderRenderer: CustomRenderer<GroupHeaderCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is GroupHeaderCell => (c.data as GroupHeaderData | undefined)?.kind === "rf-group",
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const x0 = rect.x + theme.cellHorizontalPadding + cell.data.level * 14;
    const cy = rect.y + rect.height / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.strokeStyle = theme.textMedium;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (cell.data.collapsed) {
      ctx.moveTo(x0 + 2, cy - 4);
      ctx.lineTo(x0 + 6, cy);
      ctx.lineTo(x0 + 2, cy + 4);
    } else {
      ctx.moveTo(x0, cy - 2);
      ctx.lineTo(x0 + 4, cy + 2);
      ctx.lineTo(x0 + 8, cy - 2);
    }
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.font = `600 13px ${theme.fontFamily}`;
    ctx.fillStyle = theme.textDark;
    ctx.fillText(cell.data.label, x0 + 16, cy + 0.5);
    const w = ctx.measureText(cell.data.label).width;
    ctx.font = `12px ${theme.fontFamily}`;
    ctx.fillStyle = theme.textLight;
    ctx.fillText(String(cell.data.count), x0 + 24 + w, cy + 0.5);
    ctx.restore();
    return true;
  },
};

export interface ButtonData {
  kind: "rf-button";
  label: string;
  color: string;
  busy: boolean;
}

export type ButtonCell = CustomCell<ButtonData>;

/** A Button field cell: a pill with the button's label, or "Running..." while its automation runs. */
export const buttonRenderer: CustomRenderer<ButtonCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is ButtonCell => (c.data as ButtonData | undefined)?.kind === "rf-button",
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const label = cell.data.busy ? "Running..." : cell.data.label;
    ctx.save();
    ctx.font = `600 12.5px ${theme.fontFamily}`;
    const pad = theme.cellHorizontalPadding;
    const w = Math.min(rect.width - 2 * pad, ctx.measureText(label).width + 20);
    const h = 24;
    const x = rect.x + pad;
    const y = rect.y + rect.height / 2 - h / 2;
    ctx.fillStyle = cell.data.color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.fillStyle = "#2b2723";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + 10, y + h / 2 + 0.5, Math.max(0, w - 20));
    ctx.restore();
    return true;
  },
};
