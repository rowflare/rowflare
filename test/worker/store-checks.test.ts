import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";

const actor = { userId: "u1", name: "Tester" };

async function withDO<R>(name: string, fn: (i: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    return fn(i);
  });
}

describe("table and field checks", () => {
  it("createTable makes field names unique", async () => {
    await withDO("chk-dedupe", i => {
      const t = i.store.createTable(actor, { name: "T", fields: [{ name: "Name", type: "text" }, { name: "name", type: "number" }, { name: "Name", type: "longText" }] }).tableId;
      expect(i.store.fieldsOf(t).map(f => f.name)).toEqual(["Name", "name 2", "Name 3"]);
    });
  });
  it("createTable refuses a primary field that cannot be one", async () => {
    await withDO("chk-primary", i => {
      for (const type of ["checkbox", "attachment", "button"] as const) expect(() => i.store.createTable(actor, { name: "T", fields: [{ name: "A", type }] })).toThrow("The primary field cannot be this type");
    });
  });
  it("option names must be unique", async () => {
    await withDO("chk-choices", i => {
      const t = i.store.createTable(actor, { name: "T", fields: [{ name: "Name", type: "text" }] }).tableId;
      const choices = [{ id: "", name: "Done", color: "" }, { id: "", name: "done ", color: "" }];
      expect(() => i.store.createField(t, { name: "S", type: "singleSelect", options: { choices } })).toThrow('The option "done" appears twice');
      expect(() => i.store.createTable(actor, { name: "U", fields: [{ name: "Name", type: "text" }, { name: "S", type: "multiSelect", options: { choices } }] })).toThrow('The option "done" appears twice');
    });
  });
});

describe("grid grouping keys", () => {
  it("groups values with a time by day in the viewer's offset, and unchecked with empty", async () => {
    await withDO("chk-group-day", i => {
      const s = i.store;
      const t = s.createTable(actor, { name: "T", fields: [{ name: "Name", type: "text" }, { name: "At", type: "date", options: { includeTime: true } }, { name: "Ok", type: "checkbox" }] }).tableId;
      const [name, at, ok] = s.fieldsOf(t).map(f => f.id);
      s.createRows(actor, t, [
        { cells: { [name]: "a", [at]: "2026-03-01T15:00:00.000Z", [ok]: true } },
        { cells: { [name]: "b", [at]: "2026-03-01T17:30:00.000Z" } },
        { cells: { [name]: "c", [at]: "2026-03-01T09:00:00.000Z" } },
      ]);
      s.sql.exec(`UPDATE ${(s as any).table(t).phys} SET data = json_set(data, '$.${ok}', json('false')) WHERE json_extract(data, '$.${name}') = 'c'`);
      s.invalidate();
      // UTC+8: 15:00 and 17:30 UTC fall on March 1 and March 2.
      const r = s.query(t, { groupLevels: [{ fieldId: at, dir: "asc" }], dayOffset: 480, limit: 10 });
      expect(r.groupKeys).toEqual([["2026-03-01"], ["2026-03-01"], ["2026-03-02"]]);
      const c = s.query(t, { groupLevels: [{ fieldId: ok, dir: "asc" }], limit: 10 });
      expect(c.groupKeys!.map(k => k[0]).sort()).toEqual(["0", "0", "1"]);
      const sums = s.aggregate(t, { groupBy: [{ fieldId: at }], fanOut: false, dayOffset: 480, metrics: [{ fn: "count", as: "n" }] });
      expect(sums.groups.map(g => [g.key[0], g.values.n]).sort()).toEqual([["2026-03-01", 2], ["2026-03-02", 1]]);
      const sumsOk = s.aggregate(t, { groupBy: [{ fieldId: ok }], fanOut: false, metrics: [{ fn: "count", as: "n" }] });
      expect(sumsOk.groups.map(g => [g.key[0], g.values.n]).sort()).toEqual([["0", 2], ["1", 1]]);
    });
  });
});
