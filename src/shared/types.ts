// Types shared by the Worker, the Base Durable Object and the web client.
import type { ButtonInfo } from "./automations";
import type { RollupFn } from "./rollup";
import type { AiCellState, AiConfig, AiProgress } from "./ai";

export type FieldType =
  | "text"
  | "longText"
  | "email"
  | "url"
  | "phone"
  | "number"
  | "singleSelect"
  | "multiSelect"
  | "date"
  | "checkbox"
  | "attachment"
  | "link"
  | "lookup"
  | "rollup"
  | "formula"
  | "createdTime"
  | "modifiedTime"
  | "user"
  | "autonumber"
  | "button";

export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: "text", label: "Single line text" },
  { type: "longText", label: "Long text" },
  { type: "number", label: "Number" },
  { type: "singleSelect", label: "Single select" },
  { type: "multiSelect", label: "Multiple select" },
  { type: "date", label: "Date" },
  { type: "checkbox", label: "Checkbox" },
  { type: "attachment", label: "Attachment" },
  { type: "link", label: "Link to another record" },
  { type: "lookup", label: "Lookup" },
  { type: "rollup", label: "Rollup" },
  { type: "formula", label: "Formula" },
  { type: "user", label: "User" },
  { type: "email", label: "Email" },
  { type: "url", label: "URL" },
  { type: "phone", label: "Phone number" },
  { type: "createdTime", label: "Created time" },
  { type: "modifiedTime", label: "Last modified time" },
  { type: "autonumber", label: "Autonumber" },
  { type: "button", label: "Button" },
];

/** Field types whose value is computed by the server and cannot be written. */
export const COMPUTED_TYPES: ReadonlySet<FieldType> = new Set(["lookup", "rollup", "formula", "createdTime", "modifiedTime", "autonumber", "button"]);

export interface Choice {
  id: string;
  name: string;
  color: string;
}

export interface FieldOptions {
  // button
  label?: string;
  color?: string;
  automationId?: string;
  // number
  precision?: number;
  format?: "number" | "currency" | "percent";
  symbol?: string;
  // select
  choices?: Choice[];
  // date
  includeTime?: boolean;
  // link
  linkedTableId?: string;
  inverseFieldId?: string;
  linkTable?: string;
  linkSide?: "a" | "b";
  // lookup / rollup
  linkFieldId?: string;
  targetFieldId?: string;
  fn?: RollupFn;
  // formula
  formula?: string;
  resultType?: "number" | "text" | "date" | "boolean" | "array";
  // user
  multiple?: boolean;
  // AI (text, long text, selects, number, date, checkbox)
  ai?: AiConfig;
}

export interface Field {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  options: FieldOptions;
  description?: string;
  ord: string;
}

export interface Condition {
  fieldId: string;
  op: FilterOp;
  value?: unknown;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "ncontains"
  | "empty"
  | "notempty"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "anyOf"
  | "noneOf"
  | "allOf";

export interface FilterSpec {
  conjunction: "and" | "or";
  conditions: Condition[];
}

export interface SortSpec {
  fieldId: string;
  dir: "asc" | "desc";
}

export interface FormFieldConfig {
  fieldId: string;
  required?: boolean;
  label?: string;
  help?: string;
}

export interface ViewConfig {
  filters?: FilterSpec;
  sorts?: SortSpec[];
  hidden?: string[];
  fieldOrder?: string[];
  widths?: Record<string, number>;
  rowHeight?: "short" | "medium" | "tall";
  groupFieldId?: string; // kanban
  coverFieldId?: string; // kanban
  form?: { title?: string; description?: string; fields?: FormFieldConfig[]; submitText?: string; successText?: string; shareId?: string };
  dateFieldId?: string; // calendar, timeline: start date
  endDateFieldId?: string; // calendar, timeline: optional end date
  durationFieldId?: string; // timeline: number of days, used without an end date
  laneFieldId?: string; // timeline lanes
  calendarMode?: "month" | "week";
  timelineScale?: "day" | "week" | "month";
  dependencyFieldId?: string; // reserved for task dependencies
  groups?: GroupLevel[]; // grid grouping, at most 3
  summaries?: Record<string, SummaryFn>; // grid group summaries by field id
}

export type ViewType = "grid" | "kanban" | "form" | "calendar" | "timeline" | "gallery";

export interface GroupLevel {
  fieldId: string;
  dir: "asc" | "desc";
}

export type SummaryFn = "sum" | "avg" | "min" | "max" | "countFilled" | "countUnique";

export interface View {
  id: string;
  tableId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  ord: string;
}

export type AggFn = "count" | "countUnique" | "countEmpty" | "countFilled" | "sum" | "avg" | "min" | "max";
export type DateBucket = "day" | "week" | "month" | "year";

export type WidgetType = "metric" | "bar" | "line" | "pie" | "pivot" | "text";

export interface WidgetMetric {
  fn: AggFn;
  fieldId?: string;
}

/** One dashboard widget. Positions are 12-column grid units. Settings unused by the widget's type are ignored. */
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tableId?: string;
  viewId?: string;
  filters?: FilterSpec;
  /** The dashboard date range applies to this field; without it the widget ignores the range. */
  dateFieldId?: string;
  metric?: WidgetMetric;
  compare?: boolean; // metric: change against the previous period
  xFieldId?: string; // bar, line
  bucket?: DateBucket; // bar, line, pie: bucket of a date group field
  seriesFieldId?: string; // bar, line
  stacked?: boolean;
  horizontal?: boolean; // bar
  area?: boolean; // line
  sort?: "value" | "key";
  limit?: number;
  groupFieldId?: string; // pie
  donut?: boolean;
  rowFieldId?: string; // pivot
  colFieldId?: string;
  rowBucket?: DateBucket;
  colBucket?: DateBucket;
  text?: string; // text: Markdown
}

export interface Dashboard {
  id: string;
  name: string;
  ord: string;
  widgets: Widget[];
}


export interface Table {
  id: string;
  name: string;
  ord: string;
  primaryFieldId: string;
  rowCount?: number;
}

export interface Schema {
  baseId: string;
  version: number;
  tables: Table[];
  fields: Field[];
  views: View[];
  dashboards: Dashboard[];
  /** Automations with a button trigger; definitions themselves are only sent to editors. */
  buttons?: ButtonInfo[];
  jobs: JobInfo[];
}

export interface JobInfo {
  id: number;
  kind: string;
  label: string;
  done: number;
  total: number;
}

export type Cells = Record<string, unknown>;

export interface Row {
  id: number;
  ord: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  updatedBy: string | null;
  cells: Cells;
  /** States of AI cells that are not plainly done. */
  ai?: Record<string, AiCellState>;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  key: string;
}

export interface LinkValue {
  id: number;
  t: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export type Role = "owner" | "editor" | "viewer";

/** Messages pushed from the Base Durable Object to clients over WebSocket. */
export type ServerMessage =
  | { type: "rows"; tableId: string; rows: Row[]; by?: string; clientId?: string }
  | { type: "deleted"; tableId: string; ids: number[]; by?: string; clientId?: string }
  | { type: "schema"; schema: Schema; clientId?: string }
  | { type: "reload"; tableId: string }
  | { type: "presence"; users: Presence[] }
  | { type: "cursor"; user: Presence }
  | { type: "jobs"; jobs: JobInfo[] }
  | { type: "automations" }
  | { type: "aiProgress"; progress: AiProgress[] };

export interface Presence {
  sid: string;
  userId: string;
  name: string;
  color: string;
  tableId?: string;
  rowId?: number;
  fieldId?: string;
}

export type ClientMessage = { type: "cursor"; tableId?: string; rowId?: number; fieldId?: string } | { type: "ping" };

export const COLORS = ["#fde2c8", "#d6ecff", "#dff5dc", "#ffe0e6", "#ece0ff", "#fff2b3", "#d4f3f0", "#ffd9c2", "#e3e7ee", "#f8d8f2"];

/** Fields usable as the start or end of a calendar or timeline span. */
export function isDateField(f: Field): boolean {
  return f.type === "date" || f.type === "createdTime" || f.type === "modifiedTime" || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "date");
}

/** Fields whose values carry a time: grid grouping puts them in one group per day. */
export function groupsByDay(f: Field): boolean {
  return f.type === "createdTime" || f.type === "modifiedTime" || (f.type === "date" && !!f.options.includeTime) || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "date");
}

/** The calendar day of a stored time (epoch ms or ISO text) at a fixed offset from UTC, in minutes. */
export function dayAtOffset(raw: unknown, offsetMinutes = 0): string | null {
  const ms = typeof raw === "number" ? raw : typeof raw === "string" && raw ? Date.parse(raw.length === 10 ? raw + "T00:00:00Z" : raw) : NaN;
  if (!Number.isFinite(ms)) return null;
  if (typeof raw === "string" && raw.length === 10) return raw;
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function isNumberField(f: Field): boolean {
  return f.type === "number" || f.type === "autonumber" || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "number");
}
