// Filter conditions editor shared by the view toolbar and the dashboard widget editor.
import type { Condition, Field, FilterOp, FilterSpec } from "../../shared/types";
import { Button, Icon } from "../ui";
import { Chip } from "./editors";

export type Kind = "text" | "number" | "date" | "bool" | "select" | "multi" | "link";

export function kindOf(f: Field): Kind {
  switch (f.type) {
    case "number":
    case "autonumber":
      return "number";
    case "date":
    case "createdTime":
    case "modifiedTime":
      return "date";
    case "checkbox":
      return "bool";
    case "singleSelect":
      return "select";
    case "multiSelect":
      return "multi";
    case "link":
    case "lookup":
    case "attachment":
      return "link";
    case "user":
      return f.options.multiple ? "link" : "text";
    case "formula":
    case "rollup":
      return f.options.resultType === "number" ? "number" : f.options.resultType === "date" ? "date" : f.options.resultType === "boolean" ? "bool" : f.options.resultType === "array" ? "link" : "text";
    default:
      return "text";
  }
}

export const OPS: Record<Kind, [FilterOp, string][]> = {
  text: [["contains", "contains"], ["ncontains", "does not contain"], ["eq", "is"], ["neq", "is not"], ["empty", "is empty"], ["notempty", "is not empty"]],
  number: [["eq", "="], ["neq", "≠"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["empty", "is empty"], ["notempty", "is not empty"]],
  date: [["eq", "is"], ["lt", "is before"], ["gt", "is after"], ["lte", "is on or before"], ["gte", "is on or after"], ["empty", "is empty"], ["notempty", "is not empty"]],
  bool: [["eq", "is"]],
  select: [["eq", "is"], ["neq", "is not"], ["anyOf", "is any of"], ["noneOf", "is none of"], ["empty", "is empty"], ["notempty", "is not empty"]],
  multi: [["anyOf", "has any of"], ["allOf", "has all of"], ["noneOf", "has none of"], ["empty", "is empty"], ["notempty", "is not empty"]],
  link: [["contains", "contains"], ["ncontains", "does not contain"], ["empty", "is empty"], ["notempty", "is not empty"]],
};

export function FilterEditor({ fields, spec, onChange, emptyText }: { fields: Field[]; spec: FilterSpec; onChange: (next: FilterSpec, delay?: number) => void; emptyText: string }) {
  const setCond = (i: number, c: Partial<Condition>, delay = 0) => onChange({ ...spec, conditions: spec.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) }, delay);
  return (
    <>
      {spec.conditions.length === 0 && <p className="muted small" style={{ margin: "4px 4px 10px" }}>{emptyText}</p>}
      <div className="filter-list">
        {spec.conditions.map((c, i) => {
          const f = fields.find(x => x.id === c.fieldId);
          const kind = f ? kindOf(f) : "text";
          return (
            <div key={i} className="filter-row">
              <span className="filter-conj">
                {i === 0 ? "Where" : i === 1 ? (
                  <select className="input" value={spec.conjunction} onChange={e => onChange({ ...spec, conjunction: e.target.value as "and" | "or" })}>
                    <option value="and">and</option>
                    <option value="or">or</option>
                  </select>
                ) : spec.conjunction}
              </span>
              <select className="input" value={c.fieldId} onChange={e => {
                const nf = fields.find(x => x.id === e.target.value)!;
                setCond(i, { fieldId: nf.id, op: OPS[kindOf(nf)][0][0], value: kindOf(nf) === "bool" ? true : undefined });
              }}>
                {fields.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select className="input" value={c.op} onChange={e => setCond(i, { op: e.target.value as FilterOp })}>
                {OPS[kind].map(([op, label]) => <option key={op} value={op}>{label}</option>)}
              </select>
              <div className="filter-value">{f && <FilterValue field={f} kind={kind} cond={c} onChange={(v, delay) => setCond(i, { value: v }, delay)} />}</div>
              <button className="icon-btn" onClick={() => onChange({ ...spec, conditions: spec.conditions.filter((_, j) => j !== i) })} aria-label="Remove filter"><Icon name="x" size={14} /></button>
            </div>
          );
        })}
      </div>
      {fields.length > 0 && (
        <Button small variant="ghost" icon="plus" onClick={() => {
          const f = fields[0];
          onChange({ ...spec, conditions: [...spec.conditions, { fieldId: f.id, op: OPS[kindOf(f)][0][0], value: kindOf(f) === "bool" ? true : undefined }] });
        }}>Add condition</Button>
      )}
    </>
  );
}

function FilterValue({ field, kind, cond, onChange }: { field: Field; kind: Kind; cond: Condition; onChange: (v: unknown, delay?: number) => void }) {
  if (cond.op === "empty" || cond.op === "notempty") return null;
  if (kind === "bool")
    return (
      <select className="input" value={cond.value ? "1" : "0"} onChange={e => onChange(e.target.value === "1")}>
        <option value="1">checked</option>
        <option value="0">not checked</option>
      </select>
    );
  if ((kind === "select" || kind === "multi") && field.options.choices) {
    const multi = cond.op === "anyOf" || cond.op === "noneOf" || cond.op === "allOf";
    if (!multi)
      return (
        <select className="input" value={String(cond.value ?? "")} onChange={e => onChange(e.target.value)}>
          <option value="">Choose</option>
          {field.options.choices.map(ch => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
        </select>
      );
    const selected = new Set(Array.isArray(cond.value) ? (cond.value as string[]) : cond.value ? [String(cond.value)] : []);
    return (
      <div className="chips filter-chips">
        {field.options.choices.map(ch => (
          <button key={ch.id} className={"chip-toggle" + (selected.has(ch.id) ? " on" : "")} onClick={() => {
            const next = new Set(selected);
            if (next.has(ch.id)) next.delete(ch.id);
            else next.add(ch.id);
            onChange([...next]);
          }}>
            <Chip name={ch.name} color={ch.color} />
          </button>
        ))}
      </div>
    );
  }
  if (kind === "date") return <input className="input" type="date" value={String(cond.value ?? "")} onChange={e => onChange(e.target.value)} />;
  return <input className="input" inputMode={kind === "number" ? "decimal" : undefined} value={String(cond.value ?? "")} onChange={e => onChange(e.target.value, 350)} placeholder="Value" />;
}
