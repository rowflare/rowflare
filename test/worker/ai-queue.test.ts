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

/** Posts (Title, Body) with an AI field Summary on Body. */
function setup(i: BaseDO, ai: Record<string, unknown> = {}) {
  const s = i.store;
  const t = s.createTable(actor, { name: "Posts", fields: [{ name: "Title", type: "text" }, { name: "Body", type: "longText" }, { name: "Photo", type: "attachment" }] }).tableId;
  const id = (n: string) => s.fieldsOf(t).find(f => f.name === n)!.id;
  const sum = s.createField(t, { name: "Summary", type: "longText", options: { ai: { serviceId: "ais1", prompt: `Summarize {${id("Body")}}`, ...ai } } }).fieldId;
  return { s, t, body: id("Body"), title: id("Title"), photo: id("Photo"), sum };
}

describe("AI options", () => {
  it("are kept on output types and dropped on others", async () => {
    await withDO("ai-q-opts", i => {
      const { s, sum } = setup(i);
      expect(s.field(sum).options.ai).toEqual({ serviceId: "ais1", prompt: expect.stringContaining("Summarize {fld"), autoUpdate: true });
      s.updateField(sum, { type: "link", options: { linkedTableId: s.field(sum).tableId } });
      expect(s.field(sum).options.ai).toBeUndefined();
    });
  });
  it("refuse unknown fields, self references, cycles and non-attachment image fields", async () => {
    await withDO("ai-q-check", i => {
      const { s, t, body, title, sum } = setup(i);
      expect(() => s.createField(t, { name: "X", type: "text", options: { ai: { serviceId: "a", prompt: "{fldMissing000001}" } } })).toThrow("The prompt refers to a field that does not exist");
      expect(() => s.updateField(sum, { options: { ai: { serviceId: "a", prompt: `{${sum}}` } } })).toThrow("An AI field cannot refer to itself");
      const b = s.createField(t, { name: "B", type: "text", options: { ai: { serviceId: "a", prompt: `{${sum}}` } } }).fieldId;
      expect(() => s.updateField(sum, { options: { ai: { serviceId: "a", prompt: `{${b}} {${body}}` } } })).toThrow("AI fields cannot refer to each other in a circle");
      expect(() => s.updateField(sum, { options: { ai: { serviceId: "a", prompt: "x", imageFieldIds: [title] } } })).toThrow("Image fields must be attachment fields");
    });
  });
  it("refuse cycles through formulas, lookups and rollups", async () => {
    await withDO("ai-q-cycle-formula", i => {
      const { s, t, title, sum } = setup(i);
      const label = s.createField(t, { name: "Label", type: "formula", options: { formula: `{${title}} & " " & {${sum}}` } }).fieldId;
      expect(() => s.updateField(sum, { options: { ai: { serviceId: "a", prompt: `Summarize {${label}}` } } })).toThrow("AI fields cannot refer to each other in a circle");
      const plain = s.createField(t, { name: "Plain", type: "formula", options: { formula: `{${title}}` } }).fieldId;
      s.updateField(sum, { options: { ai: { serviceId: "a", prompt: `Summarize {${plain}}` } } });
      expect(() => s.updateField(plain, { options: { formula: `{${title}} & {${sum}}` } })).toThrow("refers to itself");
      const other = s.createTable(actor, { name: "Notes", fields: [{ name: "Text", type: "text" }] }).tableId;
      const link = s.createField(other, { name: "Post", type: "link", options: { linkedTableId: t } }).fieldId;
      const look = s.createField(other, { name: "Summary seen", type: "lookup", options: { linkFieldId: link, targetFieldId: sum } }).fieldId;
      const inverse = s.field(link).options.inverseFieldId!;
      const back = s.createField(t, { name: "Note summaries", type: "lookup", options: { linkFieldId: inverse, targetFieldId: look } }).fieldId;
      expect(() => s.updateField(sum, { options: { ai: { serviceId: "a", prompt: `Summarize {${back}}` } } })).toThrow("AI fields cannot refer to each other in a circle");
    });
  });
  it("allow at most 20 AI fields per table", async () => {
    await withDO("ai-q-max", i => {
      const { s, t, body } = setup(i);
      for (let k = 0; k < 19; k++) s.createField(t, { name: `A${k}`, type: "text", options: { ai: { serviceId: "a", prompt: `{${body}}` } } });
      expect(() => s.createField(t, { name: "A20", type: "text", options: { ai: { serviceId: "a", prompt: `{${body}}` } } })).toThrow("A table can have at most 20 AI fields");
    });
  });
});

describe("queueing", () => {
  it("new rows and changed inputs queue a cell once, debounced", async () => {
    await withDO("ai-q-write", i => {
      const { s, t, body, title, sum } = setup(i);
      const id = s.createRows(actor, t, [{ cells: { [body]: "Hello" } }]).created![0];
      const e1 = i.ai.queue.get(t, sum, id)!;
      expect(e1.dueAt).toBeGreaterThan(Date.now() + 1000);
      s.updateRows(actor, t, [{ id, cells: { [body]: "Hello again" } }]);
      const e2 = i.ai.queue.get(t, sum, id)!;
      expect(e2.seq).toBeGreaterThan(e1.seq);
      expect(i.ai.queue.due(Date.now() + 5000, 100).length).toBe(1);
      i.ai.queue.drop(e2);
      s.updateRows(actor, t, [{ id, cells: { [title]: "Unrelated" } }]);
      expect(i.ai.queue.get(t, sum, id)).toBeUndefined();
      expect(s.getRows(t, [id])[0].ai).toEqual({ [sum]: { s: "queued" } });
    });
  });
  it("typing into an AI cell marks it edited and removes its queue entry", async () => {
    await withDO("ai-q-edit", i => {
      const { s, t, body, sum } = setup(i);
      const id = s.createRows(actor, t, [{ cells: { [body]: "Hi" } }]).created![0];
      s.updateRows(actor, t, [{ id, cells: { [sum]: "My own summary" } }]);
      expect(i.ai.queue.get(t, sum, id)).toBeUndefined();
      expect(s.getRows(t, [id])[0].ai).toEqual({ [sum]: { s: "edited" } });
      s.updateRows(actor, t, [{ id, cells: { [body]: "Changed" } }]);
      expect(i.ai.queue.get(t, sum, id)).toBeUndefined();
    });
  });
  it("imports and fields without auto update do not queue", async () => {
    await withDO("ai-q-import", i => {
      const { s, t, body, sum } = setup(i);
      const id = s.createRows(actor, t, [{ cells: { [body]: "x" } }], { noTriggers: true }).created![0];
      expect(i.ai.queue.get(t, sum, id)).toBeUndefined();
      s.updateField(sum, { options: { ai: { ...s.field(sum).options.ai!, autoUpdate: false } } });
      const id2 = s.createRows(actor, t, [{ cells: { [body]: "y" } }]).created![0];
      expect(i.ai.queue.get(t, sum, id2)).toBeUndefined();
    });
  });
  it("a 1,000 row paste queues 1,000 entries in one write", async () => {
    await withDO("ai-q-bulk", i => {
      const { s, t, body } = setup(i);
      const t0 = Date.now();
      s.createRows(actor, t, Array.from({ length: 1000 }, (_, k) => ({ cells: { [body]: `Row ${k}` } })));
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(i.ai.queue.due(Date.now() + 5000, 5000).length).toBe(1000);
      expect(i.ai.queue.progress()).toEqual([{ tableId: t, fieldId: expect.any(String), queued: 1000, done: 0, total: 1000 }]);
    });
  });
  it("whole column and missing rows", async () => {
    await withDO("ai-q-column", i => {
      const { s, t, body, sum } = setup(i, { autoUpdate: false });
      const ids = s.createRows(actor, t, [{ cells: { [body]: "a" } }, { cells: { [body]: "b" } }, { cells: { [body]: "c", [sum]: "typed" } }]).created!;
      expect(i.ai.queue.enqueueColumn(t, sum, true, Date.now())).toBe(2);
      // Clients reload the table instead of receiving every queued row.
      expect([...i.ai.queue.reload]).toEqual([t]);
      i.ai.queue.stop(sum);
      expect(i.ai.queue.due(Date.now() + 1e9, 100)).toEqual([]);
      expect(i.ai.queue.enqueueColumn(t, sum, false, Date.now())).toBe(3);
      expect(i.ai.queue.status(t, sum)).toMatchObject({ queued: 3 });
      void ids;
    });
  });
  it("deleted rows and fields take their entries with them", async () => {
    await withDO("ai-q-delete", i => {
      const { s, t, body, sum } = setup(i);
      const [a, b] = s.createRows(actor, t, [{ cells: { [body]: "a" } }, { cells: { [body]: "b" } }]).created!;
      s.deleteRows(actor, t, [a]);
      expect(i.ai.queue.get(t, sum, a)).toBeUndefined();
      s.deleteField(sum);
      i.ai.queue.prune();
      expect(i.ai.queue.get(t, sum, b)).toBeUndefined();
    });
  });
  it("a deleted referenced field makes the field broken", async () => {
    await withDO("ai-q-broken", i => {
      const { s, body, sum } = setup(i);
      s.deleteField(body);
      expect(s.aiBroken(s.field(sum))).toBe("The prompt refers to a deleted field");
    });
  });
});
