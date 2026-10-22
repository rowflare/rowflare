import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { AutomationConfig } from "../../src/shared/automations";
import type { HttpRequest } from "../../src/worker/auto/types";
import { NO_QUOTA, STALE_AFTER } from "../../src/worker/auto/repo";

/** Longer ago than a run may take, so the run counts as cut off. */
const CUT_OFF = STALE_AFTER + 60_000;

const actor = { userId: "u1", name: "Tester" };

async function withDO<R>(name: string, fn: (i: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    return fn(i);
  });
}

const httpStep = { id: "s1", type: "http" as const, method: "POST" as const, url: "https://example.com/x", headers: [] as [string, string][] };
const create = (i: BaseDO, config: AutomationConfig, now = Date.now(), name = "A") => i.automations.apply(actor, { op: "create", name, config, enabled: true }, now).id!;

describe("automation engine", () => {
  it("executing a run that another drain already claimed does nothing", async () => {
    await withDO("eng-claimed", async i => {
      let calls = 0;
      i.net = { http: async () => (calls++, { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] });
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", body: {}, at: Date.now() }, [id], Date.now(), NO_QUOTA);
      // The alarm took the run and is in the middle of it when the button's own execution starts.
      i.automations.saveRun(runId, { status: "running", startedAt: Date.now() });
      await i.engine.execute(runId);
      expect(calls).toBe(0);
    });
  });
  it("a run without an AI step counts as cut off after its own limit, a run with one after the longer limit", async () => {
    await withDO("eng-stale-limits", async i => {
      i.net = { http: async () => ({ status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "x" }) };
      const plain = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] });
      const withAi = i.automations.apply({ userId: "u1", name: "T" }, { op: "create", name: "AI", enabled: true, config: { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "ai", serviceId: "a", prompt: "x", output: "text" }] } }, Date.now()).id!;
      const t = Date.now();
      const runs = [plain, withAi].map(id => {
        const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", body: {}, at: t }, [id], t, NO_QUOTA);
        i.automations.saveRun(runId, { status: "running", startedAt: t - 90_000 });
        return runId;
      });
      await i.engine.drain(() => t);
      expect(i.automations.getRun(runs[0])!.status).not.toBe("running");
      expect(i.automations.getRun(runs[1])!.status).toBe("running");
    });
  });
  it("the time limit message names the run's own limit", async () => {
    await withDO("eng-limit-msg", async i => {
      let clock = Date.now();
      i.net = { http: async () => ({ status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ((clock += 200_000), { text: "x" }) };
      const id = i.automations.apply({ userId: "u1", name: "T" }, { op: "create", name: "AI", enabled: true, config: { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "ai", serviceId: "a", prompt: "x", output: "text" }, { ...httpStep, id: "s2" }] } }, Date.now()).id!;
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", body: {}, at: clock }, [id], clock, NO_QUOTA);
      const run = await i.engine.execute(runId, () => clock);
      expect(run.error).toBe("The run took longer than 150 seconds");
    });
  });
  it("two drains at once run a queued run once", async () => {
    await withDO("eng-double", async i => {
      let calls = 0;
      i.net = { http: async () => (calls++, { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      // A slow billing check, as when it reads D1, lets the second drain look at the queue before the first claims the run.
      i.canRun = async () => (await new Promise(r => setTimeout(r, 20)), true);
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] });
      i.automations.enqueue(i.automations.get(id), { type: "webhook", body: {}, at: Date.now() }, [id], Date.now(), NO_QUOTA);
      await Promise.all([i.engine.drain(), i.engine.drain()]);
      expect(calls).toBe(1);
    });
  });
  it("a record edit queues a run that the next alarm executes", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("eng-alarm"));
    const calls: HttpRequest[] = [];
    await runInDurableObject(stub, async (i: BaseDO) => {
      i.store.init("eng-alarm");
      i.net = { http: async r => (calls.push(r), { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const tableId = i.store.createTable(actor, { name: "T" }).tableId;
      create(i, { trigger: { type: "recordCreated", tableId }, steps: [httpStep] });
      expect((await i.rowOp(actor, { op: "create", tableId, rows: [{ cells: {} }] })).ok).toBe(true);
      expect(await (i as any).ctx.storage.getAlarm()).not.toBeNull();
    });
    // Miniflare may also fire the alarm on its own; either way the run executes exactly once.
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, (i: BaseDO) => i.engine.drain());
    expect(calls).toHaveLength(1);
  });

  it("the alarm stops after its time budget and continues later", async () => {
    await withDO("eng-budget", async i => {
      let clock = Date.parse("2026-10-13T00:00:00Z");
      i.net = { http: async () => ((clock += 300), { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] }, clock);
      const a = i.automations.get(id);
      for (let k = 0; k < 10; k++) i.automations.enqueue(a, { type: "webhook", at: clock }, [id], clock, NO_QUOTA);
      const count = (st: string) => i.automations.runs(id, { limit: 20 }).filter(r => r.status === st).length;
      await i.engine.drain(() => clock);
      expect([count("succeeded"), count("queued")]).toEqual([7, 3]);
      await i.engine.drain(() => clock);
      expect(count("succeeded")).toBe(10);
    });
  });

  it("retries after 10 s, 1 min and 5 min, then fails", async () => {
    await withDO("eng-retry", async i => {
      let clock = Date.parse("2026-10-13T00:00:00Z");
      let calls = 0;
      i.net = { http: async () => (calls++, { status: 503, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] }, clock);
      i.automations.enqueue(i.automations.get(id), { type: "webhook", at: clock }, [id], clock, NO_QUOTA);
      const run = () => i.automations.runs(id, { limit: 1 })[0];
      await i.engine.drain(() => clock);
      expect(run()).toMatchObject({ status: "waiting_retry", attempt: 1, nextAt: clock + 10_000 });
      clock += 5_000;
      await i.engine.drain(() => clock);
      expect(calls).toBe(1);
      clock += 5_000;
      await i.engine.drain(() => clock);
      expect(run()).toMatchObject({ attempt: 2, nextAt: clock + 60_000 });
      clock += 60_000;
      await i.engine.drain(() => clock);
      expect(run()).toMatchObject({ attempt: 3, nextAt: clock + 300_000 });
      clock += 300_000;
      await i.engine.drain(() => clock);
      expect(run()).toMatchObject({ status: "failed", attempt: 3, error: "The server answered 503" });
      expect(calls).toBe(4);
    });
  });

  it("20 failed runs in a row turn the automation off; a success resets the count", async () => {
    await withDO("eng-streak", async i => {
      let status = 400;
      i.net = { http: async () => ({ status, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] });
      const queue = (n: number) => { for (let k = 0; k < n; k++) i.automations.enqueue(i.automations.get(id), { type: "webhook", at: 0 }, [id], Date.now(), NO_QUOTA); };
      queue(19);
      await i.engine.drain(() => 0);
      expect(i.automations.get(id)).toMatchObject({ enabled: true, failStreak: 19 });
      status = 200;
      queue(1);
      await i.engine.drain(() => 0);
      expect(i.automations.get(id).failStreak).toBe(0);
      status = 400;
      queue(20);
      await i.engine.drain(() => 0);
      expect(i.automations.get(id)).toMatchObject({ enabled: false, disabledReason: "failures", failStreak: 20 });
      queue(1);
      await i.engine.drain(() => 0);
      expect(i.automations.runs(id, { limit: 1 })[0]).toMatchObject({ status: "skipped", error: "The automation was turned off" });
    });
  });

  it("a run left running by an eviction resumes at its unfinished step", async () => {
    await withDO("eng-stale", async i => {
      const s = i.store;
      const log = s.createTable(actor, { name: "Log", fields: [{ name: "Message", type: "text" }] }).tableId;
      const msg = s.fieldsOf(log)[0].id;
      const calls: string[] = [];
      i.net = { http: async r => (calls.push(r.url), { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [msg]: "once" } }, { ...httpStep, id: "s2" }] });
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", at: 0 }, [id], Date.now(), NO_QUOTA);
      const first = s.createRows(actor, log, [{ cells: { [msg]: "once" } }], { noTriggers: true }).created![0];
      const t = Date.now();
      i.automations.saveRun(runId, { status: "running", startedAt: t - CUT_OFF, steps: [{ id: "s1", type: "createRecord", status: "ok", output: { records: { tableId: log, ids: [first] }, count: 1 }, ms: 3 }] });
      expect(i.engine.nextWake()).toBe(t - CUT_OFF + STALE_AFTER);
      await i.engine.drain(() => t);
      expect(i.automations.getRun(runId)).toMatchObject({ status: "succeeded" });
      expect(s.rowCount(log)).toBe(1);
      expect(calls).toEqual(["https://example.com/x"]);
    });
  });

  it("run again uses the automation as it is now and resumes at the failed step", async () => {
    await withDO("eng-rerun", async i => {
      const s = i.store;
      const log = s.createTable(actor, { name: "Log", fields: [{ name: "Message", type: "text" }] }).tableId;
      const msg = s.fieldsOf(log)[0].id;
      const calls: string[] = [];
      i.net = { http: async r => (calls.push(r.url), { status: r.url.includes("broken") ? 400 : 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const steps = (url: string) => [{ id: "s1", type: "createRecord" as const, tableId: log, values: { [msg]: "once" } }, { ...httpStep, id: "s2", url }];
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: steps("https://example.com/broken") });
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", at: 0 }, [id], Date.now(), NO_QUOTA);
      await i.engine.drain();
      expect(i.automations.getRun(runId)).toMatchObject({ status: "failed" });
      i.automations.apply(actor, { op: "update", id, config: { trigger: { type: "webhook", token: "" }, steps: steps("https://example.com/fixed") } }, Date.now());
      expect((await i.retryRun(runId)).ok).toBe(true);
      await i.engine.drain();
      expect(i.automations.getRun(runId)).toMatchObject({ status: "succeeded" });
      expect(calls).toEqual(["https://example.com/broken", "https://example.com/fixed"]);
      expect(s.rowCount(log)).toBe(1);
    });
  });

  it("date triggers find the next date behind many dates that already passed", async () => {
    await withDO("eng-date-many", async i => {
      const s = i.store;
      const t = s.createTable(actor, { name: "Tasks", fields: [{ name: "Name", type: "text" }, { name: "Due", type: "date" }] }).tableId;
      const due = s.fieldsOf(t).find(f => f.name === "Due")!.id;
      s.createRows(actor, t, Array.from({ length: 600 }, () => ({ cells: { [due]: "2026-10-12" } })), { noTriggers: true });
      s.createRows(actor, t, [{ cells: { [due]: "2026-10-14" } }], { noTriggers: true });
      const id = create(i, { trigger: { type: "dateReached", tableId: t, fieldId: due, offsetMinutes: 0, at: "09:00", tz: "UTC" }, steps: [] }, Date.parse("2026-10-13T12:00:00Z"));
      expect(new Date(i.automations.timers().find(x => x.automation.id === id)!.nextAt!).toISOString()).toBe("2026-10-14T09:00:00.000Z");
    });
  });

  it("date triggers queue every due record, also more than one page of them", async () => {
    await withDO("eng-date-page", async i => {
      i.monthlyRuns = 0;
      const s = i.store;
      const t = s.createTable(actor, { name: "Tasks", fields: [{ name: "Name", type: "text" }, { name: "Due", type: "date" }] }).tableId;
      const due = s.fieldsOf(t).find(f => f.name === "Due")!.id;
      s.createRows(actor, t, Array.from({ length: 5100 }, () => ({ cells: { [due]: "2026-10-14" } })), { noTriggers: true });
      const id = create(i, { trigger: { type: "dateReached", tableId: t, fieldId: due, offsetMinutes: 0, at: "09:00", tz: "UTC" }, steps: [] }, Date.parse("2026-10-13T12:00:00Z"));
      i.engine.enqueueDue(Date.parse("2026-10-14T09:30:00Z"));
      expect(i.automations.runs(id, { limit: 1 })[0].id).toBeGreaterThanOrEqual(5100);
      expect(i.store.one<{ n: number }>("SELECT count(*) n FROM _auto_runs WHERE automation_id = ?", id)!.n).toBe(5100);
    });
  }, 30_000);

  it("a button run sets the alarm before it starts, so an eviction mid-run is picked up again", async () => {
    await withDO("eng-button-alarm", async i => {
      const t = i.store.createTable(actor, { name: "T" }).tableId;
      const rid = i.store.createRows(actor, t, [{ cells: {} }], { noTriggers: true }).created![0];
      let alarmDuringRun: number | null = null;
      i.net = { http: async () => ((alarmDuringRun = await (i as any).ctx.storage.getAlarm()), { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "button", tableId: t, viewerCanRun: false }, steps: [httpStep] });
      await (i as any).ctx.storage.deleteAlarm();
      expect((await i.runButton(actor, id, rid, true)).ok).toBe(true);
      expect(alarmDuringRun).not.toBeNull();
    });
  });

  it("a retry still sees the whole answer of an earlier HTTP step, beyond what the log keeps", async () => {
    await withDO("eng-resume-body", async i => {
      let clock = Date.parse("2026-10-13T00:00:00Z");
      let fail = true;
      const sent: string[] = [];
      i.net = {
        http: async r => {
          if (r.url.endsWith("/big")) return { status: 200, headers: {}, body: JSON.stringify({ id: "abc", pad: "x".repeat(6000) }) };
          sent.push(r.body ?? "");
          return { status: fail ? 503 : 200, headers: {}, body: "" };
        },
        email: async () => ({}),
        ai: async () => ({ text: "" }),
      };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [{ ...httpStep, id: "s1", method: "GET", url: "https://example.com/big" }, { ...httpStep, id: "s2", body: '{"id": "{{steps.s1.body.id}}"}' }] }, clock);
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", at: clock }, [id], clock, NO_QUOTA);
      await i.engine.drain(() => clock);
      expect(i.automations.getRun(runId)!.status).toBe("waiting_retry");
      fail = false;
      clock += 10_000;
      await i.engine.drain(() => clock);
      expect(i.automations.getRun(runId)!.status).toBe("succeeded");
      expect(sent).toEqual(['{"id": "abc"}', '{"id": "abc"}']);
    });
  });

  it("a run cut off again and again counts as a try each time and fails after the last one", async () => {
    await withDO("eng-stale-limit", async i => {
      let calls = 0;
      i.net = { http: async () => (calls++, { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] });
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", at: 0 }, [id], Date.now(), NO_QUOTA);
      const t = Date.now();
      i.automations.saveRun(runId, { status: "running", startedAt: t - CUT_OFF, attempt: 2 });
      await i.engine.drain(() => t);
      expect(i.automations.getRun(runId)).toMatchObject({ status: "succeeded", attempt: 3 });
      i.automations.saveRun(runId, { status: "running", startedAt: t - CUT_OFF });
      await i.engine.drain(() => t);
      expect(i.automations.getRun(runId)).toMatchObject({ status: "failed", error: "The run was cut off before it finished, 4 times" });
      expect(calls).toBe(1);
      expect(i.automations.get(id).failStreak).toBe(1);
    });
  });

  it("a test run cut off by an eviction is marked failed by the next alarm, not run again", async () => {
    await withDO("eng-stale-test", async i => {
      let calls = 0;
      i.net = { http: async () => (calls++, { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] });
      const t = Date.now();
      const runId = i.automations.insertRun({ automation: i.automations.get(id), status: "running", test: true, trigger: { type: "webhook", at: t }, chain: [id], now: t - CUT_OFF });
      await i.engine.drain(() => t);
      expect(i.automations.getRun(runId)).toMatchObject({ status: "failed", error: "The test run was cut off before it finished" });
      expect(calls).toBe(0);
    });
  });

  it("imported rows bring a date trigger's next check forward, without firing record triggers", async () => {
    await withDO("eng-date-import", async i => {
      const s = i.store;
      const t = s.createTable(actor, { name: "Tasks", fields: [{ name: "Name", type: "text" }, { name: "Due", type: "date" }] }).tableId;
      const due = s.fieldsOf(t).find(f => f.name === "Due")!.id;
      s.createRows(actor, t, [{ cells: { [due]: "2026-10-20" } }], { noTriggers: true });
      const id = create(i, { trigger: { type: "dateReached", tableId: t, fieldId: due, offsetMinutes: 0, at: "09:00", tz: "UTC" }, steps: [] }, Date.parse("2026-10-13T12:00:00Z"));
      const created = create(i, { trigger: { type: "recordCreated", tableId: t }, steps: [] });
      const nextAt = () => new Date(i.automations.timers().find(x => x.automation.id === id)!.nextAt!).toISOString();
      expect(nextAt()).toBe("2026-10-20T09:00:00.000Z");
      s.createRows(actor, t, [{ cells: { [due]: "2026-10-15" } }], { noTriggers: true });
      expect(nextAt()).toBe("2026-10-15T09:00:00.000Z");
      expect(i.automations.runs(created, { limit: 5 })).toHaveLength(0);
    });
  });

  it("runs are skipped while the workspace is paused", async () => {
    await withDO("eng-paused", async i => {
      let calls = 0;
      i.net = { http: async () => (calls++, { status: 200, headers: {}, body: "" }), email: async () => ({}), ai: async () => ({ text: "" }) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] });
      i.canRun = async () => false;
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", at: 0 }, [id], Date.now(), NO_QUOTA);
      await i.engine.drain();
      expect(i.automations.getRun(runId)).toMatchObject({ status: "skipped", error: "Automations are paused for this workspace" });
      expect(calls).toBe(0);
      expect(i.automations.get(id)).toMatchObject({ enabled: true, failStreak: 0 });
    });
  });

  it("schedules queue one run at their time, even after missed times", async () => {
    await withDO("eng-schedule", async i => {
      const t0 = Date.parse("2026-10-13T08:00:00Z");
      const id = create(i, { trigger: { type: "schedule", every: "day", at: "09:00", tz: "UTC" }, steps: [] }, t0);
      const nextAt = () => i.automations.timers().find(x => x.automation.id === id)!.nextAt!;
      const first = nextAt();
      expect(new Date(first).toISOString()).toBe("2026-10-13T09:00:00.000Z");
      expect(i.engine.nextWake()).toBe(first);
      i.engine.enqueueDue(first - 1);
      expect(i.automations.runs(id, { limit: 10 })).toHaveLength(0);
      i.engine.enqueueDue(first + 60_000);
      expect(i.automations.runs(id, { limit: 10 })).toHaveLength(1);
      i.engine.enqueueDue(first + 3 * 86_400_000);
      expect(i.automations.runs(id, { limit: 10 })).toHaveLength(2);
      expect(new Date(nextAt()).toISOString()).toBe("2026-10-17T09:00:00.000Z");
      i.automations.apply(actor, { op: "setEnabled", id, enabled: false }, t0);
      expect(i.automations.timers()).toEqual([]);
    });
  });

  it("date triggers fire once when a date plus its offset is reached", async () => {
    await withDO("eng-date", async i => {
      const s = i.store;
      const t = s.createTable(actor, { name: "Tasks", fields: [{ name: "Name", type: "text" }, { name: "Due", type: "date" }] }).tableId;
      const due = s.fieldsOf(t).find(f => f.name === "Due")!.id;
      const mk = (d: string) => s.createRows(actor, t, [{ cells: { [due]: d } }]).created![0];
      const r13 = mk("2026-10-13");
      mk("2026-10-14");
      mk("2026-10-09");
      const t0 = Date.parse("2026-10-10T00:00:00Z");
      const id = create(i, { trigger: { type: "dateReached", tableId: t, fieldId: due, offsetMinutes: -60, at: "09:00", tz: "UTC" }, steps: [] }, t0);
      const nextAt = () => new Date(i.automations.timers().find(x => x.automation.id === id)!.nextAt!).toISOString();
      expect(nextAt()).toBe("2026-10-13T08:00:00.000Z");
      const r11 = mk("2026-10-11");
      expect(nextAt()).toBe("2026-10-11T08:00:00.000Z");
      i.engine.enqueueDue(Date.parse("2026-10-13T08:30:00Z"));
      const fired = () => i.automations.runs(id, { limit: 10 }).map(r => r.trigger.recordId);
      expect(fired().sort()).toEqual([r11, r13].sort());
      expect(nextAt()).toBe("2026-10-14T08:00:00.000Z");
      i.engine.enqueueDue(Date.parse("2026-10-13T09:00:00Z"));
      expect(fired()).toHaveLength(2);
      i.engine.enqueueDue(Date.parse("2026-10-14T08:00:00Z"));
      expect(fired()).toHaveLength(3);
    });
  });
});
