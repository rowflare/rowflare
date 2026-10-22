import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { Net } from "../../src/worker/auto/types";
import { executeRun } from "../../src/worker/auto/executor";
import { StepError } from "../../src/worker/auto/types";

const actor = { userId: "u1", name: "Tester" };

function net(answer: (p: string) => string, calls: string[] = []): Net {
  return {
    http: async () => ({ status: 200, headers: {}, body: "" }),
    email: async () => ({}),
    ai: async r => (calls.push(r.prompt), { text: answer(r.prompt) }),
  };
}

async function run(name: string, steps: unknown[], n: Net) {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    const t = i.store.createTable(actor, { name: "Leads", fields: [{ name: "Name", type: "text" }, { name: "Note", type: "text" }] }).tableId;
    const [nameF, noteF] = i.store.fieldsOf(t).map(f => f.id);
    const rec = i.store.createRows(actor, t, [{ cells: { [nameF]: "Ada" } }], { noTriggers: true }).created![0];
    const s = JSON.parse(JSON.stringify(steps).replaceAll("$T", t).replaceAll("$NAME", nameF).replaceAll("$NOTE", noteF));
    const id = i.automations.apply(actor, { op: "create", name: "A", enabled: true, config: { trigger: { type: "recordCreated", tableId: t }, steps: s } }, Date.now()).id!;
    const runId = i.automations.insertRun({ automation: i.automations.get(id), status: "queued", trigger: { type: "recordCreated", tableId: t, recordId: rec, at: Date.now() }, chain: [id], now: Date.now() });
    const out = await executeRun(i.automations.getRun(runId)!, { store: i.store, net: n, baseUrl: "https://app.test/base/x", now: () => Date.now() });
    return { out, note: i.store.getRows(t, [rec])[0].cells[noteF] };
  });
}

describe("AI automation step", () => {
  it("passes text to later steps", async () => {
    const calls: string[] = [];
    const { out, note } = await run("auto-ai-1", [
      { id: "s1", type: "ai", serviceId: "ais1", prompt: "Greet {{trigger.record.$NAME}}", output: "text" },
      { id: "s2", type: "updateRecords", target: "trigger", tableId: "$T", values: { $NOTE: "{{steps.s1.text}}" } },
    ], net(p => `Hello from ${p}`, calls));
    expect(out.status).toBe("succeeded");
    expect(calls).toEqual(["Greet Ada"]);
    expect(note).toBe("Hello from Greet Ada");
  });
  it("parses JSON answers, also inside code fences", async () => {
    const { out, note } = await run("auto-ai-2", [
      { id: "s1", type: "ai", serviceId: "ais1", prompt: "x", output: "json" },
      { id: "s2", type: "updateRecords", target: "trigger", tableId: "$T", values: { $NOTE: "{{steps.s1.json.lead.score}}" } },
    ], net(() => '```json\n{"lead": {"score": 7}}\n```'));
    expect(out.status).toBe("succeeded");
    expect(note).toBe("7");
  });
  it("fails the step when the JSON answer is not an object", async () => {
    const { out } = await run("auto-ai-3", [{ id: "s1", type: "ai", serviceId: "ais1", prompt: "x", output: "json" }], net(() => "sorry"));
    expect(out.status).toBe("failed");
    expect(out.error).toBe("The answer is not a JSON object");
  });
  it("retries when the service is busy", async () => {
    const busy: Net = { ...net(() => ""), ai: async () => { throw new StepError("The service answered 503: down", true); } };
    const { out } = await run("auto-ai-4", [{ id: "s1", type: "ai", serviceId: "ais1", prompt: "x", output: "text" }], busy);
    expect(out.status).toBe("waiting_retry");
  });
});
