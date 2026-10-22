import { describe, expect, it } from "vitest";
import { aggregate, ROLLUP_FNS, rollupFnFromAirtable, type RollupFn } from "../../src/shared/rollup";

const mixed = [1, null, [2, [3]], "x", "", 4.5, true];

describe("aggregate", () => {
  it("sums, averages and counts", () => {
    expect(aggregate("sum", mixed)).toBe(10.5);
    expect(aggregate("sum", [0.1, 0.2])).toBe(0.3);
    expect(aggregate("sum", [])).toBe(0);
    expect(aggregate("avg", [1, 2, [3, null]])).toBe(2);
    expect(aggregate("avg", [])).toBe(null);
    expect(aggregate("avg", ["a", null])).toBe(null);
    expect(aggregate("count", mixed)).toBe(4);
    expect(aggregate("counta", mixed)).toBe(6);
    expect(aggregate("counta", [false, null, "", "a"])).toBe(1);
    expect(aggregate("countall", mixed)).toBe(8);
  });

  it("min and max work on numbers and dates", () => {
    expect(aggregate("min", mixed)).toBe(1);
    expect(aggregate("max", mixed)).toBe(4.5);
    expect(aggregate("max", [-3, -1, null])).toBe(-1);
    expect(aggregate("min", ["2025-03-01", "2024-12-31T10:00:00.000Z", null])).toBe("2024-12-31T10:00:00.000Z");
    expect(aggregate("max", ["2025-03-01", ["2025-03-01T00:00:01.000Z"], "nope"])).toBe("2025-03-01T00:00:01.000Z");
    expect(aggregate("min", [])).toBe(null);
    expect(aggregate("max", ["a", null])).toBe(null);
  });

  it("joins, uniques and compacts arrays", () => {
    expect(aggregate("arrayjoin", ["a", ["b", null], 3, true])).toBe("a, b, 3, 1");
    expect(aggregate("concat", ["a", ["b"], null])).toBe("a, b");
    expect(aggregate("arrayunique", ["a", ["a", "b"], 1, "1", 1])).toEqual(["a", "b", 1, "1"]);
    expect(aggregate("arraycompact", ["a", null, "", [0, false]])).toEqual(["a", 0, false]);
  });

  it("and/or use truthiness", () => {
    expect(aggregate("and", [true, 1, "x"])).toBe(true);
    expect(aggregate("and", [true, [0]])).toBe(false);
    expect(aggregate("or", [null, "", [false, 2]])).toBe(true);
    expect(aggregate("or", [null, 0])).toBe(false);
    expect(aggregate("and", [])).toBe(null);
  });
});

describe("ROLLUP_FNS and rollupFnFromAirtable", () => {
  it("covers every fn and maps formulas back", () => {
    const fns: RollupFn[] = ["sum", "avg", "min", "max", "count", "counta", "countall", "arrayjoin", "arrayunique", "arraycompact", "and", "or", "concat"];
    expect(ROLLUP_FNS.map((r) => r.fn).sort()).toEqual([...fns].sort());
    for (const r of ROLLUP_FNS) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(rollupFnFromAirtable(r.formula)).toBe(r.fn);
    }
  });

  it("parses Airtable variants", () => {
    expect(rollupFnFromAirtable("SUM(values)")).toBe("sum");
    expect(rollupFnFromAirtable(" sum( values ) ")).toBe("sum");
    expect(rollupFnFromAirtable("COUNTALL(values)")).toBe("countall");
    expect(rollupFnFromAirtable("ARRAYJOIN(values, ', ')")).toBe("arrayjoin");
    expect(rollupFnFromAirtable("AVERAGE(values)")).toBe("avg");
    expect(rollupFnFromAirtable("CONCATENATE(values)")).toBe("concat");
    expect(rollupFnFromAirtable("XOR(values)")).toBe(null);
    expect(rollupFnFromAirtable("SUM(values) * 2")).toBe(null);
    expect(rollupFnFromAirtable("")).toBe(null);
  });
});
