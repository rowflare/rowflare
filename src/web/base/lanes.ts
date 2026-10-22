// Timeline lanes: one per option, member or linked record of the lane field, plus "No value".
import type { Field, Member, Row } from "../../shared/types";

export const NONE = "__none";

export interface Lane {
  key: string;
  name: string;
  color?: string;
}

const cell = (f: Field, row: Row): unknown => row.cells[f.id];
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

export function lanesFor(f: Field | undefined, rows: Row[], members: Member[]): Lane[] {
  if (!f) return [{ key: "", name: "All records" }];
  const none = { key: NONE, name: "No value" };
  if (f.type === "singleSelect") return [...(f.options.choices ?? []).map(c => ({ key: c.id, name: c.name, color: c.color })), none];
  if (f.type === "user") return [...members.map(m => ({ key: m.id, name: m.name })), none];
  const seen = new Map<string, string>();
  for (const r of rows) for (const x of (cell(f, r) as { id: number; t?: string }[] | undefined) ?? []) seen.set(String(x.id), x.t || `Record ${x.id}`);
  return [...[...seen].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name)), none];
}

/** Lane keys of a record; values without a lane (deleted option, removed member) go to "No value". */
export function laneKeys(f: Field | undefined, row: Row, lanes: Lane[]): string[] {
  if (!f) return [""];
  const v = cell(f, row);
  if (isEmpty(v)) return [NONE];
  const raw = f.type === "link" ? (v as { id: number }[]).map(x => String(x.id)) : (Array.isArray(v) ? v : [v]).map(String);
  const known = new Set(lanes.map(l => l.key));
  return [...new Set(raw.map(k => (known.has(k) ? k : NONE)))];
}
