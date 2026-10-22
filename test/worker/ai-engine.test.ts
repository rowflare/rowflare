import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import { AiError } from "../../src/worker/ai/providers";

const actor = { userId: "u1", name: "Tester" };
const svc = { id: "ais1", kind: "openai" as const, baseUrl: "https://x.test", model: "m", key: "k", keyRejected: false };

async function withDO<R>(name: string, fn: (i: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    return fn(i);
  });
}

function setup(i: BaseDO, answer: (prompt: string) => string | Promise<string> = p => `S:${p}`, type: "longText" | "singleSelect" | "number" = "longText") {
  const prompts: string[] = [];
  i.aiService = async id => (id === "ais1" ? svc : null);
  i.aiCall = async (_s, r) => {
    prompts.push(r.prompt);
    return answer(r.prompt);
  };
  i.canRun = async () => true;
  const s = i.store;
  const t = s.createTable(actor, { name: "Posts", fields: [{ name: "Title", type: "text" }, { name: "Body", type: "longText" }] }).tableId;
  const body = s.fieldsOf(t).find(f => f.name === "Body")!.id;
  const options = type === "singleSelect" ? { choices: [{ id: "c1", name: "Urgent", color: "" }, { id: "c2", name: "Later", color: "" }] } : {};
  const sum = s.createField(t, { name: "Summary", type, options: { ...options, ai: { serviceId: "ais1", prompt: `About {${body}}` } } }).fieldId;
  const add = (text: string) => s.createRows(actor, t, [{ cells: { [body]: text } }]).created![0];
  const run = () => i.ai.engine.drain(() => Date.now() + 10_000);
  return { s, t, body, sum, add, run, prompts };
}

describe("AI engine", () => {
  it("generates queued cells and writes them as AI", async () => {
    await withDO("ai-e-basic", async i => {
      const { s, t, sum, add, run } = setup(i);
      const id = add("cats");
      await run();
      const row = s.getRows(t, [id])[0];
      expect(row.cells[sum]).toBe("S:About cats");
      expect(row.ai).toBeUndefined();
      expect(row.updatedBy).toBe("ai");
      expect(i.ai.queue.progress()).toEqual([]);
    });
  });
  it("a blank record or cleared inputs make no call and clear the answer", async () => {
    await withDO("ai-e-blank", async i => {
      const { s, t, body, sum, add, run, prompts } = setup(i);
      const blank = s.createRows(actor, t, [{}]).created![0];
      const id = add("cats");
      await run();
      expect(prompts).toEqual(["About cats"]);
      s.updateRows(actor, t, [{ id, cells: { [body]: null } }]);
      await run();
      expect(prompts).toEqual(["About cats"]);
      expect(s.getRows(t, [blank, id]).map(r => [r.cells[sum] ?? null, r.ai ?? null])).toEqual([[null, null], [null, null]]);
    });
  });
  it("skips the call when the input did not change", async () => {
    await withDO("ai-e-hash", async i => {
      const { s, t, body, add, run, prompts } = setup(i);
      const id = add("cats");
      await run();
      s.updateRows(actor, t, [{ id, cells: { [body]: "dogs" } }]);
      s.updateRows(actor, t, [{ id, cells: { [body]: "cats" } }]);
      await run();
      expect(prompts).toEqual(["About cats"]);
    });
  });
  it("a late answer does not overwrite a value typed during the call", async () => {
    await withDO("ai-e-late", async i => {
      let release!: () => void;
      const gate = new Promise<void>(r => (release = r));
      const { s, t, sum, add, run } = setup(i, async p => (await gate, `S:${p}`));
      const id = add("cats");
      const p = run();
      await new Promise(r => setTimeout(r, 10));
      s.updateRows(actor, t, [{ id, cells: { [sum]: "typed" } }]);
      release();
      await p;
      const row = s.getRows(t, [id])[0];
      expect(row.cells[sum]).toBe("typed");
      expect(row.ai).toEqual({ [sum]: { s: "edited" } });
    });
  });
  it("an edit made while the service is being looked up keeps the cell edited", async () => {
    await withDO("ai-e-early-edit", async i => {
      const { s, t, sum, add, run, prompts } = setup(i);
      let release!: () => void;
      const gate = new Promise<void>(r => (release = r));
      i.aiService = async () => (await gate, svc);
      const id = add("cats");
      const p = run();
      await new Promise(r => setTimeout(r, 10));
      s.updateRows(actor, t, [{ id, cells: { [sum]: "typed" } }]);
      release();
      await p;
      expect(prompts).toEqual([]);
      expect(s.getRows(t, [id])[0].ai).toEqual({ [sum]: { s: "edited" } });
    });
  });
  it("a field waiting for another AI field that cannot run waits as long", async () => {
    await withDO("ai-e-dep-pause", async i => {
      const { s, t, sum, add } = setup(i);
      const second = s.createField(t, { name: "Title idea", type: "text", options: { ai: { serviceId: "ais2", prompt: `Title for {${sum}}` } } }).fieldId;
      i.aiService = async id => (id === "ais2" ? svc : null);
      const id = add("cats");
      const now = Date.now() + 10_000;
      await i.ai.engine.drain(() => now);
      expect(i.ai.queue.get(t, sum, id)!.dueAt).toBe(now + 600_000);
      // Both were taken in the same batch; on the next alarm the dependent sees how long the other waits.
      await i.ai.engine.drain(() => now + 2001);
      expect(i.ai.queue.get(t, second, id)!.dueAt).toBeGreaterThan(now + 600_000);
    });
  });
  it("an answer outside the options is an error with the raw answer", async () => {
    await withDO("ai-e-choice", async i => {
      const { s, t, sum, add, run } = setup(i, () => "Soon", "singleSelect");
      const id = add("cats");
      await run();
      expect(s.getRows(t, [id])[0].ai).toEqual({ [sum]: { s: "error", e: 'The answer "Soon" is not one of the options' } });
    });
  });
  it("retries 429 after the delays and then fails", async () => {
    await withDO("ai-e-retry", async i => {
      const { s, t, sum, add } = setup(i, () => { throw new AiError("The service answered 429: slow", "retry", 20_000); });
      const id = add("cats");
      let now = Date.now() + 10_000;
      await i.ai.engine.drain(() => now);
      expect(i.ai.queue.get(t, sum, id)!.dueAt).toBe(now + 20_000);
      for (const step of [20_000, 60_000, 300_000]) {
        now += step;
        await i.ai.engine.drain(() => now);
      }
      expect(i.ai.queue.get(t, sum, id)).toBeUndefined();
      expect(s.getRows(t, [id])[0].ai).toEqual({ [sum]: { s: "error", e: "The service answered 429: slow" } });
    });
  });
  it("entries of a rejected key wait 10 minutes", async () => {
    await withDO("ai-e-auth", async i => {
      const rejected: string[] = [];
      const { t, sum, add } = setup(i, () => { throw new AiError("The key was rejected", "auth"); });
      i.aiRejected = async id => void rejected.push(id);
      i.aiService = async () => ({ ...svc, keyRejected: rejected.length > 0 });
      const ids = Array.from({ length: 8 }, (_, k) => add(`r${k}`));
      const now = Date.now() + 10_000;
      await i.ai.engine.drain(() => now);
      expect(rejected[0]).toBe("ais1");
      const states = ids.map(id => i.ai.queue.state(t, sum, id)!.state);
      // The first 6 were already calling when the key was rejected; the other 2 wait.
      expect(states.filter(x => x === "error").length).toBe(6);
      const waiting = ids.map(id => i.ai.queue.get(t, sum, id)).filter(Boolean);
      expect(waiting.length).toBe(2);
      for (const w of waiting) expect(w!.dueAt).toBeGreaterThanOrEqual(now + 600_000);
    });
  });
  it("a missing service postpones instead of failing", async () => {
    await withDO("ai-e-nosvc", async i => {
      const { t, sum, add } = setup(i);
      i.aiService = async () => null;
      const id = add("cats");
      const now = Date.now() + 10_000;
      await i.ai.engine.drain(() => now);
      expect(i.ai.queue.get(t, sum, id)!.dueAt).toBe(now + 600_000);
      expect(i.ai.queue.state(t, sum, id)!.state).toBe("queued");
    });
  });
  it("fixing the field brings its waiting cells back", async () => {
    await withDO("ai-e-fix", async i => {
      const { t, sum, add } = setup(i);
      i.aiService = async id => (id === "ais2" ? svc : null);
      const id = add("cats");
      await i.ai.engine.drain(() => Date.now() + 10_000);
      expect(i.ai.queue.get(t, sum, id)!.dueAt).toBeGreaterThan(Date.now() + 500_000);
      const ai = i.store.field(sum).options.ai!;
      expect((await i.schemaOp(actor, { op: "updateField", fieldId: sum, patch: { options: { ai: { ...ai, serviceId: "ais2" } } } })).ok).toBe(true);
      expect(i.ai.queue.get(t, sum, id)!.dueAt).toBeLessThanOrEqual(Date.now());
    });
  });
  it("header progress ends when the last waiting cell is typed over or deleted", async () => {
    await withDO("ai-e-progress-end", async i => {
      const { s, t, sum, add } = setup(i);
      const a = add("one"), b = add("two");
      expect(i.ai.queue.progress()).toHaveLength(1);
      s.updateRows(actor, t, [{ id: a, cells: { [sum]: "typed" } }]);
      s.deleteRows(actor, t, [b]);
      expect(i.ai.queue.progress()).toEqual([]);
    });
  });
  it("waking the base does not skip a retry's back-off", async () => {
    await withDO("ai-e-wake-backoff", async i => {
      const { t, sum, add } = setup(i, () => { throw new AiError("The service answered 503: down", "retry"); });
      const id = add("cats");
      const now = Date.now() + 10_000;
      await i.ai.engine.drain(() => now);
      const due = i.ai.queue.get(t, sum, id)!.dueAt;
      await i.aiWake();
      expect(i.ai.queue.get(t, sum, id)!.dueAt).toBe(due);
    });
  });
  it("calls cut off again and again stop with an error", async () => {
    await withDO("ai-e-evicted", async i => {
      const { t, sum, add } = setup(i);
      const id = add("cats");
      // Paused, so each drain only recovers the cut-off call and does not run it.
      i.canRun = async () => false;
      for (let k = 0; k < 4; k++) {
        i.ai.queue.setState(t, sum, id, "running");
        (i.ai.engine as any).recovered = false;
        await i.ai.engine.drain(() => Date.now() - 60_000);
      }
      expect(i.ai.queue.get(t, sum, id)).toBeUndefined();
      expect(i.ai.queue.state(t, sum, id)).toMatchObject({ state: "error" });
    });
  });
  it("Workers AI calls not yet written to D1 count toward the quota", async () => {
    await withDO("ai-e-quota-pending", async i => {
      const { add, run, prompts } = setup(i);
      i.aiService = async () => ({ id: "workers", kind: "workers", model: "m", keyRejected: false });
      i.aiWorkersStored = async () => 2;
      for (let k = 0; k < 5; k++) add(`r${k}`);
      await run();
      expect(prompts.length).toBe(2);
    });
  });
  it("Workers AI quota used up marks cells", async () => {
    await withDO("ai-e-quota", async i => {
      const { s, t, sum, add, run } = setup(i);
      i.aiService = async () => ({ id: "workers", kind: "workers", model: "m", keyRejected: false });
      i.aiWorkersLeft = async () => 0;
      const id = add("cats");
      await run();
      expect(s.getRows(t, [id])[0].ai).toEqual({ [sum]: { s: "error", e: "This month's Workers AI quota is used up" } });
    });
  });
  it("pauses while the workspace is paused", async () => {
    await withDO("ai-e-trial", async i => {
      const { t, sum, add, run, prompts } = setup(i);
      i.canRun = async () => false;
      const id = add("cats");
      await run();
      expect(prompts).toEqual([]);
      expect(i.ai.queue.state(t, sum, id)!.state).toBe("queued");
    });
  });
  it("an AI field that reads another AI field waits for it", async () => {
    await withDO("ai-e-deps", async i => {
      const { s, t, sum, add, prompts } = setup(i);
      const second = s.createField(t, { name: "Title idea", type: "text", options: { ai: { serviceId: "ais1", prompt: `Title for {${sum}}` } } }).fieldId;
      const id = add("cats");
      await i.ai.engine.drain(() => Date.now() + 10_000);
      await i.ai.engine.drain(() => Date.now() + 20_000);
      expect(prompts).toEqual(["About cats", "Title for S:About cats"]);
      expect(s.getRows(t, [id])[0].cells[second]).toBe("S:Title for S:About cats");
    });
  });
  it("runs at most 6 calls at once", async () => {
    await withDO("ai-e-pool", async i => {
      let open = 0, max = 0;
      const { add, run } = setup(i, async p => {
        open++;
        max = Math.max(max, open);
        await new Promise(r => setTimeout(r, 5));
        open--;
        return p;
      });
      for (let k = 0; k < 20; k++) add(`r${k}`);
      await run();
      expect(max).toBe(6);
    });
  });
});
