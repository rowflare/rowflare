import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { AutomationConfig } from "../../src/shared/automations";
import { ownerWithBase } from "./helpers";

const actor = { userId: "u1", name: "Tester" };

async function withDO<R>(name: string, fn: (i: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    return fn(i);
  });
}

/** A Tasks table with Name, Status (Todo, Done) and Points. */
function setup(i: BaseDO) {
  const s = i.store;
  const t = s.createTable(actor, {
    name: "Tasks",
    fields: [
      { name: "Name", type: "text" },
      { name: "Status", type: "singleSelect", options: { choices: [{ id: "chTodo", name: "Todo", color: "#eee" }, { id: "chDone", name: "Done", color: "#eee" }] } },
      { name: "Points", type: "number" },
    ],
  }).tableId;
  const f = (n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
  const F = { name: f("Name"), status: f("Status"), points: f("Points") };
  const add = (config: AutomationConfig, name = "A") => i.automations.apply(actor, { op: "create", name, config, enabled: true }, Date.now()).id!;
  const runsOf = (id: string) => i.automations.runs(id, { limit: 100 });
  const create = (cells: Record<string, unknown>) => s.createRows(actor, t, [{ cells }]).changes.find(c => c.tableId === t)!.rows[0].id;
  return { s, t, F, add, runsOf, create };
}

const isDone = (F: { status: string }) => ({ conjunction: "and" as const, conditions: [{ fieldId: F.status, op: "eq" as const, value: "chDone" }] });

describe("record triggers", () => {
  it("recordCreated queues one run per created record that matches", async () => {
    await withDO("trg-created", i => {
      const { t, F, add, runsOf, s } = setup(i);
      const id = add({ trigger: { type: "recordCreated", tableId: t, conditions: isDone(F) }, steps: [] });
      s.createRows(actor, t, [{ cells: { [F.status]: "chDone" } }, { cells: { [F.status]: "chTodo" } }, { cells: { [F.status]: "chDone" } }]);
      const runs = runsOf(id);
      expect(runs).toHaveLength(2);
      expect(runs.every(r => r.status === "queued" && r.trigger.type === "recordCreated" && r.trigger.by === "u1" && r.trigger.tableId === t)).toBe(true);
      expect(runs[0].chain).toEqual([id]);
    });
  });

  it("recordUpdated fires only for the watched fields and only on real changes", async () => {
    await withDO("trg-updated", i => {
      const { t, F, add, runsOf, s, create } = setup(i);
      const id = add({ trigger: { type: "recordUpdated", tableId: t, fieldIds: [F.status] }, steps: [] });
      const rid = create({ [F.name]: "a" });
      s.updateRows(actor, t, [{ id: rid, cells: { [F.name]: "b" } }]);
      expect(runsOf(id)).toHaveLength(0);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chDone" } }]);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chDone" } }]);
      expect(runsOf(id).map(r => r.trigger.recordId)).toEqual([rid]);
    });
  });

  it("recordMatches fires when a record starts to match, not while it keeps matching", async () => {
    await withDO("trg-matches", i => {
      const { t, F, add, runsOf, s, create } = setup(i);
      const id = add({ trigger: { type: "recordMatches", tableId: t, conditions: isDone(F) }, steps: [] });
      const rid = create({ [F.status]: "chTodo" });
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chDone" } }]);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.points]: 3 } }]);
      expect(runsOf(id)).toHaveLength(1);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chTodo" } }]);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chDone" } }]);
      expect(runsOf(id)).toHaveLength(2);
      create({ [F.status]: "chDone" });
      expect(runsOf(id)).toHaveLength(3);
    });
  });

  it("disabled automations, imports and silent writes do not fire", async () => {
    await withDO("trg-quiet", i => {
      const { t, F, add, runsOf, s } = setup(i);
      const id = add({ trigger: { type: "recordCreated", tableId: t }, steps: [] });
      s.createRows(actor, t, [{ cells: { [F.name]: "imported" } }], { noTriggers: true });
      s.withWriteContext({ chain: [], silent: true }, () => s.createRows(actor, t, [{ cells: { [F.name]: "test run" } }]));
      i.automations.apply(actor, { op: "setEnabled", id, enabled: false }, Date.now());
      s.createRows(actor, t, [{ cells: { [F.name]: "while off" } }]);
      expect(runsOf(id)).toHaveLength(0);
    });
  });

  it("an automation does not trigger itself through its own writes, and chains stop at 5", async () => {
    await withDO("trg-chain", i => {
      const { t, F, add, runsOf, s, create } = setup(i);
      const self = add({ trigger: { type: "recordUpdated", tableId: t }, steps: [] }, "Self");
      const rid = create({ [F.name]: "x" });
      s.withWriteContext({ chain: [self] }, () => s.updateRows(actor, t, [{ id: rid, cells: { [F.name]: "y" } }]));
      expect(runsOf(self)).toHaveLength(0);
      s.withWriteContext({ chain: ["a1", "a2", "a3", "a4"] }, () => s.updateRows(actor, t, [{ id: rid, cells: { [F.name]: "z" } }]));
      expect(runsOf(self).map(r => r.chain)).toEqual([["a1", "a2", "a3", "a4", self]]);
      s.withWriteContext({ chain: ["a1", "a2", "a3", "a4", "a5"] }, () => s.updateRows(actor, t, [{ id: rid, cells: { [F.name]: "w" } }]));
      expect(runsOf(self)).toHaveLength(1);
    });
  });

  it("only rows written directly fire, not linked rows updated as a side effect", async () => {
    await withDO("trg-direct", i => {
      const { t, F, add, runsOf, s, create } = setup(i);
      const other = s.createTable(actor, { name: "Projects", fields: [{ name: "Name", type: "text" }] }).tableId;
      const link = s.createField(t, { name: "Project", type: "link", options: { linkedTableId: other } }).fieldId;
      const pid = s.createRows(actor, other, [{ cells: {} }]).changes.find(c => c.tableId === other)!.rows[0].id;
      const id = add({ trigger: { type: "recordUpdated", tableId: other }, steps: [] });
      const rid = create({ [F.name]: "x" });
      s.updateRows(actor, t, [{ id: rid, cells: { [link]: [pid] } }]);
      expect(runsOf(id)).toHaveLength(0);
    });
  });

  it("over the monthly quota, runs are recorded as skipped", async () => {
    await withDO("trg-quota", i => {
      const { t, add, runsOf, s } = setup(i);
      i.monthlyRuns = 2;
      const id = add({ trigger: { type: "recordCreated", tableId: t }, steps: [] });
      s.createRows(actor, t, [{ cells: {} }, { cells: {} }, { cells: {} }]);
      expect(runsOf(id).map(r => r.status).sort()).toEqual(["queued", "queued", "skipped"]);
      expect(runsOf(id).find(r => r.status === "skipped")!.error).toBe("This base used its 2 automation runs for this month");
    });
  });

  it("CSV import does not fire, the rows endpoint does", async () => {
    const x = await ownerWithBase("trg-http");
    const { schema } = (await x.c.req("GET", `/api/bases/${x.baseId}`)).json;
    const deals = schema.tables.find((t: any) => t.name === "Deals");
    const r = await x.c.req("POST", `/api/bases/${x.baseId}/automations`, { op: "create", name: "New deal", enabled: true, config: { trigger: { type: "recordCreated", tableId: deals.id }, steps: [] } });
    await x.c.req("POST", `/api/bases/${x.baseId}/rows`, { op: "create", tableId: deals.id, rows: [{ cells: {} }], source: "import" });
    await x.c.req("POST", `/api/bases/${x.baseId}/rows`, { op: "create", tableId: deals.id, rows: [{ cells: {} }] });
    const runs = await x.c.req("GET", `/api/bases/${x.baseId}/automations/${r.json.id}/runs`);
    expect(runs.json).toHaveLength(1);
  });
});
