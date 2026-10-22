import { describe, expect, it } from "vitest";
import { Aggregator, bucketDate, groupKeys, validateAggregate } from "../../src/worker/base/aggregate";
import type { Field, Row } from "../../src/shared/types";

const field = (id: string, type: Field["type"], options: Field["options"] = {}): Field => ({ id, tableId: "t", name: id, type, options, ord: "" });
const row = (id: number, cells: Record<string, unknown>): Row => ({ id, ord: "", createdAt: 0, updatedAt: 0, createdBy: null, updatedBy: null, cells });

describe("aggregate", () => {
  it("buckets times in the given time zone; dates without a time stay as they are", () => {
    // 2026-03-01 23:30 in Shanghai is 15:30 UTC the same day; 2026-03-01 18:00 UTC is March 2 in Shanghai.
    expect(bucketDate("2026-03-01T18:00:00.000Z", "day", "Asia/Shanghai")).toBe("2026-03-02");
    expect(bucketDate(Date.UTC(2026, 2, 31, 20), "month", "Asia/Shanghai")).toBe("2026-04");
    expect(bucketDate("2026-03-01", "day", "Asia/Shanghai")).toBe("2026-03-01");
    expect(bucketDate("2026-03-01T18:00:00.000Z", "day")).toBe("2026-03-01");
  });
  it("checks the time zone and refuses a bucket on a field that is not a date", () => {
    const fields = new Map([["n", field("n", "number")], ["d", field("d", "date")]]);
    expect(validateAggregate(fields, { metrics: [{ fn: "count", as: "c" }], groupBy: [{ fieldId: "n", bucket: "month" }] })).toBe('A date bucket needs a date field; "n" is number');
    expect(validateAggregate(fields, { metrics: [{ fn: "count", as: "c" }], tz: "Mars/Base" })).toBe("Unknown time zone Mars/Base");
    expect(validateAggregate(fields, { metrics: [{ fn: "count", as: "c" }], groupBy: [{ fieldId: "d", bucket: "month" }], tz: "Asia/Shanghai" })).toBeNull();
  });
  it("boolean formula results group as true and false", () => {
    const f = field("b", "formula", { resultType: "boolean" });
    expect(groupKeys(f, true, undefined, x => x)).toEqual([true]);
    expect(groupKeys(f, null, undefined, x => x)).toEqual([false]);
  });
  it("countUnique treats the same values in another order as one", () => {
    const tags = field("m", "multiSelect", { choices: [{ id: "a", name: "A", color: "" }, { id: "b", name: "B", color: "" }] });
    const agg = new Aggregator(new Map([["m", tags]]), { metrics: [{ fn: "countUnique", fieldId: "m", as: "u" }] }, (f, r) => r.cells[f.id], x => x);
    agg.add([row(1, { m: ["a", "b"] }), row(2, { m: ["b", "a"] })]);
    expect(agg.result().groups[0].values.u).toBe(1);
  });
});
