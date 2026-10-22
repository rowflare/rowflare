import { describe, expect, it } from "vitest";
import type { Field } from "../../src/shared/types";
import { buildRows, groupCells, headerLabel, pathOf, summaryText, existingPaths } from "../../src/web/base/gridGroups";

const field = (id: string, type: Field["type"], options: Field["options"] = {}): Field => ({ id, tableId: "tbl", name: id, type, options, ord: "a0" });
const status = field("fStatus", "singleSelect", { choices: [{ id: "selA", name: "Todo", color: "#eee" }, { id: "selB", name: "Done", color: "#eee" }] });
const tags = field("fTags", "multiSelect", { choices: [{ id: "selX", name: "Red", color: "#eee" }, { id: "selY", name: "Blue", color: "#eee" }] });
const ids = [1, 2, 3, 4];
const keys = [["a", "x"], ["a", "y"], ["b", "x"], [null, null]];
const shape = (rows: ReturnType<typeof buildRows>) => rows.map(r => (r.kind === "header" ? `H${r.level}:${r.keys.join("/")}:${r.count}` : `R${r.id}`));

describe("buildRows", () => {
  it("interleaves headers at each level with counts", () => {
    expect(shape(buildRows(ids, keys, 2, new Set()))).toEqual([
      "H0:a:2", "H1:a/x:1", "R1", "H1:a/y:1", "R2",
      "H0:b:1", "H1:b/x:1", "R3",
      "H0::1", "H1:/:1", "R4",
    ]);
  });

  it("collapsing a parent hides nested headers and records", () => {
    expect(shape(buildRows(ids, keys, 2, new Set([pathOf(["a"])])))).toEqual(["H0:a:2", "H0:b:1", "H1:b/x:1", "R3", "H0::1", "H1:/:1", "R4"]);
  });

  it("collapsing a nested group hides only its records", () => {
    expect(shape(buildRows(ids, keys, 2, new Set([pathOf(["a", "x"])])))).toEqual(["H0:a:2", "H1:a/x:1", "H1:a/y:1", "R2", "H0:b:1", "H1:b/x:1", "R3", "H0::1", "H1:/:1", "R4"]);
  });

  it("uses only the requested number of levels", () => {
    expect(shape(buildRows(ids, keys, 1, new Set()))).toEqual(["H0:a:2", "R1", "R2", "H0:b:1", "R3", "H0::1", "R4"]);
  });

  it("handles missing keys and an empty list", () => {
    expect(shape(buildRows([1, 2], [], 1, new Set()))).toEqual(["H0::2", "R1", "R2"]);
    expect(buildRows([], [], 2, new Set())).toEqual([]);
  });
});

describe("labels and cells", () => {
  it("renders group keys as the field shows them", () => {
    const names = (id: string) => (id === "u1" ? "Ada" : id);
    expect(headerLabel(status, "selB", names)).toBe("Done");
    expect(headerLabel(status, null, names)).toBe("(Empty)");
    expect(headerLabel(tags, '["selX","selY"]', names)).toBe("Red, Blue");
    expect(headerLabel(field("fChk", "checkbox"), "1", names)).toBe("Checked");
    expect(headerLabel(field("fChk", "checkbox"), "0", names)).toBe("Unchecked");
    expect(headerLabel(field("fUser", "user"), "u1", names)).toBe("Ada");
    expect(headerLabel(field("fNum", "number", { precision: 0 }), "1234", names)).toBe("1,234");
    expect(headerLabel(field("fLink", "link"), '[{"id":7,"t":"Apollo"}]', names)).toBe("Apollo");
  });

  it("builds the cells a new record needs to join a group", () => {
    const fields = [status, tags, field("fNum", "number"), field("fChk", "checkbox"), field("fF", "formula", { resultType: "number" })];
    expect(groupCells(fields, ["selA", '["selX"]', "5", "1", "10"])).toEqual({ fStatus: "selA", fTags: ["selX"], fNum: 5, fChk: true });
    expect(groupCells(fields, [null, null, null, null, null])).toEqual({});
  });

  it("formats summaries", () => {
    const num = field("fNum", "number", { precision: 2 });
    expect(summaryText(num, "sum", 1234.5)).toBe("Sum 1,234.50");
    expect(summaryText(num, "countFilled", 3)).toBe("Filled 3");
    expect(summaryText(num, "avg", null)).toBe("");
    expect(summaryText(field("fD", "date"), "min", "2026-03-01")).toMatch(/^Min /);
  });
});

describe("summary settings", () => {
  it("drops summaries for missing fields or functions the field type no longer supports", async () => {
    const { validSummaries } = await import("../../src/web/base/gridGroups");
    const num = field("fNum", "number");
    const txt = field("fTxt", "text");
    const date = field("fDate", "date");
    expect(validSummaries([num, txt, date], { fNum: "sum", fTxt: "sum", fDate: "max", fGone: "avg" })).toEqual({ fNum: "sum", fDate: "max" });
    expect(validSummaries([txt], { fTxt: "countUnique" })).toEqual({ fTxt: "countUnique" });
  });
});

describe("collapsed groups and day keys", () => {
  it("keeps only collapsed paths that still exist", () => {
    const collapsed = new Set([pathOf(["A"]), pathOf(["Gone"]), pathOf(["A", "x"]), pathOf(["A", "old"])]);
    expect([...existingPaths(collapsed, [["A", "x"], ["B", "y"]], 2)].sort()).toEqual([pathOf(["A"]), pathOf(["A", "x"])].sort());
  });
  it("labels day groups of fields with a time as dates", () => {
    const created = { id: "c", tableId: "t", name: "Created", type: "createdTime", options: {}, ord: "" } as Field;
    expect(headerLabel(created, "2026-03-01", x => x)).toBe(headerLabel({ ...created, type: "date" }, "2026-03-01", x => x));
    expect(headerLabel(created, "2026-03-01", x => x)).not.toContain("NaN");
  });
});
