import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";

const actor = { userId: "u1", name: "Tester" };

describe("button fields", () => {
  it("store their options, hold no data, export empty and cannot be the primary field", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("button-field"));
    await runInDurableObject(stub, async (i: BaseDO) => {
      const s = i.store;
      s.init("button-field");
      const t = s.createTable(actor, { name: "Deals", fields: [{ name: "Name", type: "text" }] }).tableId;
      const btn = s.createField(t, { name: "Approve", type: "button", options: { label: "Approve deal", color: "#dff5dc", automationId: "autX", precision: 3 } }).fieldId;
      expect(s.field(btn).options).toEqual({ label: "Approve deal", color: "#dff5dc", automationId: "autX" });
      const name = s.fieldsOf(t)[0].id;
      const id = s.createRows(actor, t, [{ cells: { [name]: "Acme", [btn]: "clicked" } }]).created![0];
      expect(s.getRows(t, [id])[0].cells).toEqual({ [name]: "Acme" });
      expect(s.exportCsv(t).split("\r\n")).toEqual(["Name,Approve", "Acme,"]);
      expect(() => s.updateTable(t, { primaryFieldId: btn })).toThrow("This field cannot be the primary field");
      expect(() => s.createTable(actor, { name: "X", fields: [{ name: "Go", type: "button" }] })).toThrow("The primary field cannot be this type");
    });
  });
});
