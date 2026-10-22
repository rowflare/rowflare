import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { AutomationConfig, StepLog, TriggerInfo } from "../../src/shared/automations";
import { executeRun } from "../../src/worker/auto/executor";
import type { HttpRequest, HttpResult, MailRequest, Net } from "../../src/worker/auto/types";

const actor = { userId: "u1", name: "Tester" };

async function withDO<R>(name: string, fn: (i: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    return fn(i);
  });
}

function fakeNet(http?: (r: HttpRequest) => HttpResult) {
  const calls = { http: [] as HttpRequest[], email: [] as MailRequest[] };
  const net: Net = {
    async http(r) {
      calls.http.push(r);
      return http ? http(r) : { status: 200, headers: {}, body: '{"ok":true}' };
    },
    async ai() {
      return { text: "" };
    },
    async email(r) {
      calls.email.push(r);
      return { messageId: "m1" };
    },
  };
  return { net, calls };
}

/** Tasks (Name, Status, Points) and Log (Message, Task linking to Tasks). */
function setup(i: BaseDO) {
  const s = i.store;
  const tasks = s.createTable(actor, {
    name: "Tasks",
    fields: [
      { name: "Name", type: "text" },
      { name: "Status", type: "singleSelect", options: { choices: [{ id: "chTodo", name: "Todo", color: "#eee" }, { id: "chDone", name: "Done", color: "#eee" }] } },
      { name: "Points", type: "number" },
    ],
  }).tableId;
  const log = s.createTable(actor, { name: "Log", fields: [{ name: "Message", type: "text" }] }).tableId;
  const link = s.createField(log, { name: "Task", type: "link", options: { linkedTableId: tasks } }).fieldId;
  const f = (t: string, n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
  const F = { name: f(tasks, "Name"), status: f(tasks, "Status"), points: f(tasks, "Points"), message: f(log, "Message"), link };
  const add = (config: AutomationConfig, name = "A") => i.automations.apply(actor, { op: "create", name, config, enabled: true }, Date.now()).id!;
  const row = (cells: Record<string, unknown>) => s.createRows(actor, tasks, [{ cells }], { noTriggers: true }).created![0];
  return { s, tasks, log, F, add, row };
}

async function execute(i: BaseDO, id: string, trigger: TriggerInfo, net: Net, opts: { test?: boolean; steps?: StepLog[]; attempt?: number } = {}) {
  const a = i.automations.get(id);
  const runId = i.automations.insertRun({ automation: a, status: "queued", test: opts.test, trigger, chain: [id], now: Date.now() });
  const run = { ...i.automations.getRun(runId)!, steps: opts.steps ?? [], attempt: opts.attempt ?? 0 };
  return executeRun(run, { store: i.store, net, baseUrl: "https://app.test/base/x", now: () => Date.now() });
}

describe("automation steps", () => {
  it("creates a record from the trigger record and links it back", async () => {
    await withDO("ex-create", async i => {
      const { s, tasks, log, F, add, row } = setup(i);
      const rid = row({ [F.name]: "Write docs", [F.points]: 3 });
      const id = add({ trigger: { type: "recordCreated", tableId: tasks }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [F.message]: `New task {{trigger.record.${F.name}}} ({{trigger.record.${F.points}}})`, [F.link]: "{{trigger.record}}" } }] });
      const out = await execute(i, id, { type: "recordCreated", tableId: tasks, recordId: rid, at: Date.now() }, fakeNet().net);
      expect(out.status).toBe("succeeded");
      const created = out.steps[0].output!.records!.ids;
      const r = s.getRows(log, created)[0];
      expect(r.cells[F.message]).toBe("New task Write docs (3)");
      expect(r.cells[F.link]).toEqual([{ id: rid, t: "Write docs" }]);
      expect(r.createdBy).toBe("auto:" + id);
      expect(out.steps[0].input).toEqual({ values: { Message: "New task Write docs (3)", Task: [{ id: rid }] } });
      expect(out.results).toHaveLength(1);
    });
  });

  it("finds records by a webhook value and updates them with typecast", async () => {
    await withDO("ex-find", async i => {
      const { s, tasks, F, add, row } = setup(i);
      const a = row({ [F.name]: "a" }), b = row({ [F.name]: "b" });
      const id = add({
        trigger: { type: "webhook", token: "" },
        steps: [
          { id: "s1", type: "findRecords", tableId: tasks, conditions: { conjunction: "and", conditions: [{ fieldId: F.name, op: "eq", value: "{{trigger.body.name}}" }] }, limit: 10 },
          { id: "s2", type: "updateRecords", target: "s1", tableId: tasks, values: { [F.status]: "Blocked" } },
        ],
      });
      const out = await execute(i, id, { type: "webhook", body: { name: "B" }, at: Date.now() }, fakeNet().net);
      expect(out.status).toBe("succeeded");
      expect(out.steps.map(l => l.output?.count)).toEqual([1, 1]);
      const blocked = s.maybeField(F.status)!.options.choices!.find(c => c.name === "Blocked")!;
      expect(s.getRows(tasks, [a, b]).map(r => r.cells[F.status])).toEqual([undefined, blocked.id]);
      const none = await execute(i, id, { type: "webhook", body: {}, at: Date.now() }, fakeNet().net);
      expect(none.steps.map(l => l.output?.count)).toEqual([0, 0]);
      expect(s.getRows(tasks, [a]).map(r => r.cells[F.status])).toEqual([undefined]);
    });
  });

  it("branches run one side and skip the other", async () => {
    await withDO("ex-branch", async i => {
      const { tasks, F, add, row } = setup(i);
      const rid = row({ [F.points]: 8 });
      const id = add({
        trigger: { type: "recordCreated", tableId: tasks },
        steps: [
          {
            id: "s1", type: "branch", match: "all",
            conditions: [{ left: `{{trigger.record.${F.points}}}`, op: "gt", right: "5" }],
            then: [{ id: "s2", type: "http", method: "POST", url: "https://example.com/big", headers: [], body: `{{trigger.record.${F.points}}}` }],
            else: [{ id: "s3", type: "email", provider: "resend", to: "a@example.com", subject: "small", body: "x", format: "text" }],
          },
          { id: "s4", type: "http", method: "GET", url: "https://example.com/after", headers: [] },
        ],
      });
      const { net, calls } = fakeNet();
      const out = await execute(i, id, { type: "recordCreated", tableId: tasks, recordId: rid, at: Date.now() }, net);
      expect(out.steps.map(l => l.id)).toEqual(["s1", "s2", "s4"]);
      expect(out.steps[0].output).toEqual({ matched: true });
      expect(calls.http.map(r => r.url)).toEqual(["https://example.com/big", "https://example.com/after"]);
      expect(calls.http[0].body).toBe("8");
      expect(calls.email).toHaveLength(0);
    });
  });

  it("HTTP masks secrets in the log, and a 4xx fails the run without a retry", async () => {
    await withDO("ex-http", async i => {
      const { tasks, F, add, row } = setup(i);
      const rid = row({ [F.name]: "a b" });
      const id = add({ trigger: { type: "recordCreated", tableId: tasks }, steps: [{ id: "s1", type: "http", method: "POST", url: `https://example.com/t/{{trigger.record.${F.name}}}`, headers: [["Authorization", "Bearer abc"], ["X-Kind", "task"]], body: `{"n":"{{trigger.record.${F.name}}}"}` }] });
      const { net, calls } = fakeNet(() => ({ status: 404, headers: {}, body: "nope" }));
      const out = await execute(i, id, { type: "recordCreated", tableId: tasks, recordId: rid, at: Date.now() }, net);
      expect(out).toMatchObject({ status: "failed", error: "The server answered 404", nextAt: null });
      expect(out.steps[0].input).toMatchObject({ url: "https://example.com/t/a%20b", headers: [["Authorization", "***"], ["X-Kind", "task"]], body: '{"n":"a b"}' });
      expect(out.steps[0].output).toEqual({ status: 404, body: "nope" });
      expect(calls.http[0].headers).toEqual([["Authorization", "Bearer abc"], ["X-Kind", "task"]]);
    });
  });

  it("a 5xx waits for a retry, the retry resumes at the failed step, and the fourth failure fails", async () => {
    await withDO("ex-retry", async i => {
      const { s, log, F, add } = setup(i);
      const id = add({ trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [F.message]: "once" } }, { id: "s2", type: "http", method: "POST", url: "https://example.com/x", headers: [] }] });
      let status = 503;
      const { net, calls } = fakeNet(() => ({ status, headers: {}, body: "" }));
      const first = await execute(i, id, { type: "webhook", at: Date.now() }, net);
      expect(first.status).toBe("waiting_retry");
      expect(first.nextAt! - Date.now()).toBeGreaterThan(9000);
      status = 200;
      const second = await execute(i, id, { type: "webhook", at: Date.now() }, net, { steps: first.steps, attempt: 1 });
      expect(second.status).toBe("succeeded");
      expect(s.rowCount(log)).toBe(1);
      expect(calls.http).toHaveLength(2);
      status = 503;
      expect((await execute(i, id, { type: "webhook", at: Date.now() }, net, { steps: first.steps, attempt: 3 })).status).toBe("failed");
      expect((await execute(i, id, { type: "webhook", at: Date.now() }, net, { test: true })).status).toBe("failed");
    });
  });

  it("a deleted field fails the step with a clear message", async () => {
    await withDO("ex-deleted", async i => {
      const { s, log, add } = setup(i);
      const extra = s.createField(log, { name: "Extra", type: "text" }).fieldId;
      const id = add({ trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [extra]: "x" } }] });
      s.deleteField(extra);
      const out = await execute(i, id, { type: "webhook", at: Date.now() }, fakeNet().net);
      expect(out).toMatchObject({ status: "failed", error: `The field ${extra} no longer exists` });
    });
  });

  it("email splits recipients, escapes values in HTML and checks addresses", async () => {
    await withDO("ex-email", async i => {
      const { tasks, F, add, row } = setup(i);
      const rid = row({ [F.name]: "<script>'" });
      const trigger = { type: "recordCreated" as const, tableId: tasks, recordId: rid, at: Date.now() };
      const mk = (to: string) => add({ trigger: { type: "recordCreated", tableId: tasks }, steps: [{ id: "s1", type: "email", provider: "smtp", to, subject: `Task {{trigger.record.${F.name}}}`, body: `<b>{{trigger.record.${F.name}}}</b>`, format: "html" }] }, to.slice(0, 20));
      const { net, calls } = fakeNet();
      expect((await execute(i, mk("a@x.co, b@x.co; c@x.co"), trigger, net)).status).toBe("succeeded");
      expect(calls.email[0]).toMatchObject({ provider: "smtp", to: ["a@x.co", "b@x.co", "c@x.co"], cc: [], subject: "Task <script>'", body: "<b>&lt;script&gt;&#39;</b>", format: "html" });
      const many = Array.from({ length: 51 }, (_, k) => `u${k}@x.co`).join(",");
      expect((await execute(i, mk(many), trigger, net)).error).toBe("An email can have at most 50 recipients");
      expect((await execute(i, mk("not-an-address"), trigger, net)).error).toBe("Invalid email address not-an-address");
    });
  });

  it("test runs write but do not trigger other automations", async () => {
    await withDO("ex-test", async i => {
      const { log, F, add } = setup(i);
      const a = add({ trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [F.message]: "hi" } }] }, "A");
      const b = add({ trigger: { type: "recordCreated", tableId: log }, steps: [] }, "B");
      await execute(i, a, { type: "webhook", at: Date.now() }, fakeNet().net, { test: true });
      expect(i.automations.runs(b, { limit: 10 })).toHaveLength(0);
      await execute(i, a, { type: "webhook", at: Date.now() }, fakeNet().net);
      expect(i.automations.runs(b, { limit: 10 }).map(r => r.chain)).toEqual([[a, b]]);
      expect(i.store.rowCount(log)).toBe(2);
    });
  });
});
