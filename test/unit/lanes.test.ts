import { describe, expect, it } from "vitest";
import type { Field, Member, Row } from "../../src/shared/types";
import { laneKeys, lanesFor, NONE } from "../../src/web/base/lanes";

const field = (id: string, type: Field["type"], options: Field["options"] = {}): Field => ({ id, tableId: "tbl", name: id, type, options, ord: "a0" });
const row = (id: number, cells: Row["cells"]): Row => ({ id, ord: "a", createdAt: 0, updatedAt: 0, createdBy: null, updatedBy: null, cells });
const status = field("fS", "singleSelect", { choices: [{ id: "selA", name: "A", color: "#eee" }] });
const owner = field("fU", "user", { multiple: true });
const members: Member[] = [{ id: "u1", name: "Ada", email: "ada@example.com", role: "editor" }];

describe("timeline lanes", () => {
  it("puts values without a lane into No value", () => {
    const lanes = lanesFor(status, [], members);
    expect(laneKeys(status, row(1, { fS: "selA" }), lanes)).toEqual(["selA"]);
    expect(laneKeys(status, row(2, { fS: "selDeleted" }), lanes)).toEqual([NONE]);
    expect(laneKeys(status, row(3, {}), lanes)).toEqual([NONE]);
    const users = lanesFor(owner, [], members);
    expect(laneKeys(owner, row(4, { fU: ["u1", "uGone"] }), users)).toEqual(["u1", NONE]);
    expect(laneKeys(owner, row(5, { fU: ["uGone"] }), users)).toEqual([NONE]);
  });

  it("builds link lanes from the records' values and uses one lane without a lane field", () => {
    const link = field("fL", "link");
    const lanes = lanesFor(link, [row(1, { fL: [{ id: 7, t: "Beta" }] }), row(2, { fL: [{ id: 3, t: "Alpha" }] })], members);
    expect(lanes.map(l => l.name)).toEqual(["Alpha", "Beta", "No value"]);
    expect(laneKeys(undefined, row(1, {}), lanesFor(undefined, [], members))).toEqual([""]);
  });
});
