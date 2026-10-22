// Display rows for a grouped grid: group header rows interleaved with record rows, with collapsing.
// The server orders ids by the group fields, so every group is one consecutive run.
import type { Field, SummaryFn } from "../../shared/types";
import { COMPUTED_TYPES, groupsByDay, isDateField, isNumberField } from "../../shared/types";
import { displayCell } from "../../shared/cells";

export type GroupKey = string | null;

export interface HeaderRow {
  kind: "header";
  level: number;
  keys: GroupKey[];
  path: string;
  count: number;
}

export interface RecordRow {
  kind: "record";
  id: number;
}

export type DisplayRow = HeaderRow | RecordRow;

export const pathOf = (keys: GroupKey[]): string => JSON.stringify(keys);

function norm(keys: GroupKey[] | undefined, levels: number): GroupKey[] {
  const out = (keys ?? []).slice(0, levels);
  while (out.length < levels) out.push(null);
  return out;
}

/** True when a group above `depth` levels (paths of length 1..depth) is collapsed. */
function hidden(keys: GroupKey[], depth: number, collapsed: ReadonlySet<string>): boolean {
  for (let l = 1; l <= depth; l++) if (collapsed.has(pathOf(keys.slice(0, l)))) return true;
  return false;
}

export function buildRows(ids: number[], groupKeys: GroupKey[][], levels: number, collapsed: ReadonlySet<string>): DisplayRow[] {
  const counts = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    const keys = norm(groupKeys[i], levels);
    for (let l = 1; l <= levels; l++) {
      const p = pathOf(keys.slice(0, l));
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  const out: DisplayRow[] = [];
  let prev: GroupKey[] | null = null;
  for (let i = 0; i < ids.length; i++) {
    const keys = norm(groupKeys[i], levels);
    let from = 0;
    if (prev) while (from < levels && prev[from] === keys[from]) from++;
    for (let l = from; l < levels; l++) {
      if (hidden(keys, l, collapsed)) break;
      const p = pathOf(keys.slice(0, l + 1));
      out.push({ kind: "header", level: l, keys: keys.slice(0, l + 1), path: p, count: counts.get(p) ?? 0 });
    }
    prev = keys;
    if (!hidden(keys, levels, collapsed)) out.push({ kind: "record", id: ids[i]! });
  }
  return out;
}

/** The collapsed paths that still name a group, so stored collapse state does not grow forever. */
export function existingPaths(collapsed: ReadonlySet<string>, groupKeys: GroupKey[][], levels: number): Set<string> {
  const live = new Set<string>();
  for (const k of groupKeys) {
    const keys = norm(k, levels);
    for (let l = 1; l <= levels; l++) live.add(pathOf(keys.slice(0, l)));
  }
  return new Set([...collapsed].filter(p => live.has(p)));
}

const NUMERIC_TYPES = new Set(["number", "autonumber"]);

function parseKey(f: Field, key: string): unknown {
  if (key.startsWith("[") || key.startsWith("{")) {
    try {
      return JSON.parse(key);
    } catch {
      return key;
    }
  }
  if (NUMERIC_TYPES.has(f.type) || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "number")) return Number(key);
  return key;
}

export function headerLabel(f: Field | undefined, key: GroupKey, userName: (id: string) => string): string {
  if (key === null) return "(Empty)";
  if (!f) return key;
  if (f.type === "checkbox") return key === "1" || key === "true" ? "Checked" : "Unchecked";
  // Values with a time are grouped by day; the key is that day.
  if (groupsByDay(f)) return displayCell({ ...f, type: "date", options: { includeTime: false } }, key, { userName }) || key;
  return displayCell(f, parseKey(f, key), { userName }) || "(Empty)";
}

/** Cells a new record needs so it lands in the group with these keys; computed fields are skipped. */
export function groupCells(fields: (Field | undefined)[], keys: GroupKey[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  keys.forEach((k, i) => {
    const f = fields[i];
    if (!f || k === null || COMPUTED_TYPES.has(f.type)) return;
    out[f.id] = f.type === "checkbox" ? k === "1" || k === "true" : groupsByDay(f) ? k : parseKey(f, k);
  });
  return out;
}

export const SUMMARY_LABELS: Record<SummaryFn, string> = { sum: "Sum", avg: "Average", min: "Min", max: "Max", countFilled: "Filled", countUnique: "Unique" };

export function summaryText(f: Field, fn: SummaryFn, value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const shown = fn === "countFilled" || fn === "countUnique" ? String(value) : displayCell(f, value, {});
  return `${SUMMARY_LABELS[fn]} ${shown}`;
}

/** Summary functions that make sense for a field's type. */
export function summaryOptions(f: Field): SummaryFn[] {
  if (isNumberField(f)) return ["sum", "avg", "min", "max", "countFilled", "countUnique"];
  if (isDateField(f)) return ["min", "max", "countFilled"];
  return ["countFilled", "countUnique"];
}

/** Drops summaries whose field is gone or whose function no longer fits the field's type (it changed since). */
export function validSummaries(fields: Field[], summaries: Record<string, SummaryFn>): Record<string, SummaryFn> {
  const byId = new Map(fields.map(f => [f.id, f]));
  return Object.fromEntries(Object.entries(summaries).filter(([id, fn]) => {
    const f = byId.get(id);
    return !!f && summaryOptions(f).includes(fn);
  }));
}
