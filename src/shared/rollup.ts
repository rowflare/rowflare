import type { Value } from "./formula";
import { flatten, isBlank, toStr, truthy } from "./formula";
import { ISO_DATE } from "./formula/values";

export type RollupFn = "sum" | "avg" | "min" | "max" | "count" | "counta" | "countall" | "arrayjoin" | "arrayunique" | "arraycompact" | "and" | "or" | "concat";

export const ROLLUP_FNS: { fn: RollupFn; label: string; formula: string }[] = [
  { fn: "sum", label: "Sum", formula: "SUM(values)" },
  { fn: "avg", label: "Average", formula: "AVERAGE(values)" },
  { fn: "min", label: "Min", formula: "MIN(values)" },
  { fn: "max", label: "Max", formula: "MAX(values)" },
  { fn: "count", label: "Count numbers", formula: "COUNT(values)" },
  { fn: "counta", label: "Count non-empty", formula: "COUNTA(values)" },
  { fn: "countall", label: "Count all", formula: "COUNTALL(values)" },
  { fn: "arrayjoin", label: "Join", formula: "ARRAYJOIN(values)" },
  { fn: "arrayunique", label: "Unique", formula: "ARRAYUNIQUE(values)" },
  { fn: "arraycompact", label: "Compact", formula: "ARRAYCOMPACT(values)" },
  { fn: "and", label: "All true", formula: "AND(values)" },
  { fn: "or", label: "Any true", formula: "OR(values)" },
  { fn: "concat", label: "Concatenate", formula: "CONCATENATE(values)" },
];

const BY_NAME: Record<string, RollupFn> = {
  SUM: "sum", AVERAGE: "avg", AVG: "avg", MIN: "min", MAX: "max", COUNT: "count", COUNTA: "counta", COUNTALL: "countall",
  ARRAYJOIN: "arrayjoin", ARRAYUNIQUE: "arrayunique", ARRAYCOMPACT: "arraycompact", AND: "and", OR: "or", CONCATENATE: "concat",
};

function extreme(values: Value[], sign: 1 | -1): Value {
  let best: number | null = null;
  for (const v of values) if (typeof v === "number" && (best === null || (v - best) * sign > 0)) best = v;
  if (best !== null) return best;
  let bestDate: string | null = null;
  let bestMs = 0;
  for (const v of values) {
    if (typeof v !== "string" || !ISO_DATE.test(v)) continue;
    const ms = Date.parse(v.length > 10 && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? v.replace(" ", "T") + "Z" : v.replace(" ", "T"));
    if (Number.isNaN(ms)) continue;
    if (bestDate === null || (ms - bestMs) * sign > 0) { bestDate = v; bestMs = ms; }
  }
  return bestDate;
}

export function aggregate(fn: RollupFn, values: Value[]): Value {
  const vals = flatten(values);
  switch (fn) {
    case "sum": {
      let s = 0;
      for (const v of vals) if (typeof v === "number") s += v;
      return parseFloat(s.toPrecision(15));
    }
    case "avg": {
      let s = 0, n = 0;
      for (const v of vals) if (typeof v === "number") { s += v; n++; }
      return n ? s / n : null;
    }
    case "min": return extreme(vals, -1);
    case "max": return extreme(vals, 1);
    case "count": return vals.filter((v) => typeof v === "number").length;
    case "counta": return vals.filter((v) => !isBlank(v) && v !== false).length;
    case "countall": return vals.length;
    case "arrayjoin":
    case "concat": return vals.filter((v) => v !== null).map(toStr).join(", ");
    case "arrayunique": {
      const seen = new Set<string>();
      return vals.filter((v) => {
        const k = typeof v + ":" + toStr(v);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case "arraycompact": return vals.filter((v) => v !== null && v !== "");
    case "and": return vals.length ? vals.every(truthy) : null;
    case "or": return vals.length ? vals.some(truthy) : null;
  }
}

export function rollupFnFromAirtable(formula: string): RollupFn | null {
  const m = /^([A-Za-z_]+)\s*\(\s*values\s*(?:,[^)]*)?\)$/i.exec(formula.trim());
  if (!m) return null;
  return BY_NAME[m[1].toUpperCase()] ?? null;
}
