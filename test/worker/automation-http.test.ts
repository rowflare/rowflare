import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import { addViewer, HttpClient, ownerWithBase } from "./helpers";

async function crm(prefix: string) {
  const o = await ownerWithBase(prefix);
  const { schema } = (await o.c.req("GET", `/api/bases/${o.baseId}`)).json;
  const deals = schema.tables.find((t: any) => t.name === "Deals");
  const field = (name: string) => schema.fields.find((f: any) => f.tableId === deals.id && f.name === name);
  const url = `/api/bases/${o.baseId}/automations`;
  const create = async (name: string, config: object, enabled = true) => (await o.c.req("POST", url, { op: "create", name, enabled, config })).json;
  return { ...o, schema, deals, field, url, create };
}

/** Runs whatever is queued, whether or not Miniflare already fired the alarm. */
async function settle(baseId: string) {
  const stub = env.BASE.get(env.BASE.idFromName(baseId));
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, (i: BaseDO) => i.engine.drain());
}

const hook = (baseId: string, token: string, init: RequestInit) => SELF.fetch(`https://app.test/api/hooks/${baseId}/${token}`, { method: "POST", ...init });

describe("webhooks", () => {
  it("a webhook call queues a run that creates a record, also with a session cookie and no x-rf header", async () => {
    const x = await crm("hook-create");
    const r = await x.create("Inbound", { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: x.deals.id, values: { [x.field("Name").id]: "{{trigger.body.deal}}" } }] });
    const token = r.automations[0].config.trigger.token;
    const res = await hook(x.baseId, token, { headers: { "Content-Type": "application/json", Cookie: x.c.cookie }, body: JSON.stringify({ deal: "From the hook" }) });
    expect(res.status).toBe(202);
    const { runId } = await res.json<{ runId: number }>();
    await settle(x.baseId);
    const runs = (await x.c.req("GET", `${x.url}/${r.id}/runs`)).json;
    expect(runs[0]).toMatchObject({ id: runId, status: "succeeded", trigger: { type: "webhook", body: { deal: "From the hook" } } });
    expect((await x.c.req("POST", `/api/bases/${x.baseId}/query`, { tableId: x.deals.id, search: "From the hook" })).json.total).toBe(1);
  });

  it("rejects unknown tokens, turned off automations, broken JSON and large bodies", async () => {
    const x = await crm("hook-errors");
    const on = await x.create("On", { trigger: { type: "webhook", token: "" }, steps: [] });
    const off = await x.create("Off", { trigger: { type: "webhook", token: "" }, steps: [] }, false);
    const tokenOn = on.automations[0].config.trigger.token;
    const tokenOff = off.automations.find((a: any) => a.name === "Off").config.trigger.token;
    expect((await hook(x.baseId, "x".repeat(32), { body: "{}" })).status).toBe(404);
    expect((await hook("appNope", tokenOn, { body: "{}" })).status).toBe(404);
    expect((await hook(x.baseId, tokenOff, { body: "{}" })).status).toBe(404);
    const broken = await hook(x.baseId, tokenOn, { headers: { "Content-Type": "application/json" }, body: "{oops" });
    expect([broken.status, (await broken.json<{ error: string }>()).error]).toEqual([400, "The body is not valid JSON"]);
    expect((await hook(x.baseId, tokenOn, { body: "x".repeat(300 * 1024) })).status).toBe(413);
    expect((await x.c.req("GET", `${x.url}/${on.id}/runs`)).json).toHaveLength(0);
    const form = await hook(x.baseId, tokenOn, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=Ada&plan=pro" });
    expect(form.status).toBe(202);
    expect((await x.c.req("GET", `${x.url}/${on.id}/runs`)).json[0].trigger.body).toEqual({ name: "Ada", plan: "pro" });
  });

  it("stops reading a streamed body at 256 KB, and keeps a short copy of a large body once the run succeeded", async () => {
    const x = await crm("hook-stream");
    const on = await x.create("On", { trigger: { type: "webhook", token: "" }, steps: [] });
    const token = on.automations[0].config.trigger.token;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream({ pull(ctrl) { if (sent++ < 10) ctrl.enqueue(chunk); else ctrl.close(); } });
    const big = await hook(x.baseId, token, { body: stream, duplex: "half" } as RequestInit);
    expect(big.status).toBe(413);
    expect(sent).toBeLessThan(10);
    const r = await hook(x.baseId, token, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ada", notes: "n".repeat(20_000) }) });
    expect(r.status).toBe(202);
    await settle(x.baseId);
    const run = (await x.c.req("GET", `${x.url}/${on.id}/runs`)).json[0];
    expect(run.status).toBe("succeeded");
    expect(run.trigger.body).toMatchObject({ truncated: true });
    expect(JSON.stringify(run.trigger.body).length).toBeLessThan(9000);
  });

  it("allows 60 calls per minute per base", async () => {
    const x = await crm("hook-rate");
    const on = await x.create("On", { trigger: { type: "webhook", token: "" }, steps: [] });
    const token = on.automations[0].config.trigger.token;
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await hook(x.baseId, token, { body: "{}" })).status);
    expect(statuses.slice(0, 60).every(s => s === 202)).toBe(true);
    expect(statuses[60]).toBe(429);
    // 61 requests; slow when the machine is busy.
  }, 20_000);
});

describe("buttons, test runs and run again", () => {
  it("buttons run for editors, and for viewers only when allowed", async () => {
    const x = await crm("button-run");
    const rid = (await x.c.req("POST", `/api/bases/${x.baseId}/query`, { tableId: x.deals.id, limit: 1 })).json.ids[0];
    const mk = (viewerCanRun: boolean, enabled = true) => x.create("Approve", { trigger: { type: "button", tableId: x.deals.id, viewerCanRun }, steps: [{ id: "s1", type: "updateRecords", target: "trigger", tableId: x.deals.id, values: { [x.field("Name").id]: "Approved" } }] }, enabled);
    const locked = (await mk(false)).id;
    const open = (await mk(true)).id;
    const off = (await mk(true, false)).id;
    const viewer = new HttpClient(await addViewer(x.c, x.wsId, "button-run-v@example.com"));
    const run = (c: HttpClient, id: string, recordId = rid) => c.req("POST", `${x.url}/${id}/run`, { recordId });
    expect((await run(viewer, locked)).status).toBe(403);
    const ok = await run(x.c, locked);
    expect(ok.json).toEqual({ id: expect.any(Number), status: "succeeded", error: null });
    expect((await run(viewer, open)).json.status).toBe("succeeded");
    expect((await run(x.c, off)).json.error).toBe("This automation is turned off");
    expect((await run(x.c, open, 999999)).status).toBe(404);
    const other = x.schema.tables.find((t: any) => t.id !== x.deals.id).id;
    const wrong = await x.c.req("POST", `${x.url}/${open}/run`, { recordId: rid, tableId: other });
    expect([wrong.status, wrong.json.error]).toEqual([400, "This button's automation runs on another table"]);
  });

  it("test runs return their steps and do not count against the quota", async () => {
    const x = await crm("test-run");
    const rid = (await x.c.req("POST", `/api/bases/${x.baseId}/query`, { tableId: x.deals.id, limit: 1 })).json.ids[0];
    const a = await x.create("Check", { trigger: { type: "recordUpdated", tableId: x.deals.id }, steps: [{ id: "s1", type: "branch", match: "all", conditions: [{ left: `{{trigger.record.${x.field("Name").id}}}`, op: "notempty" }], then: [], else: [] }] });
    const res = await x.c.req("POST", `${x.url}/${a.id}/test`, { recordId: rid });
    expect(res.json).toMatchObject({ test: true, status: "succeeded", steps: [{ id: "s1", status: "ok", output: { matched: true } }] });
    expect(res.json.snapshot).toBeUndefined();
    expect((await x.c.req("GET", x.url)).json.usage.used).toBe(0);
    expect((await x.c.req("POST", `${x.url}/${a.id}/test`, {})).json.error).toBe("Choose a record to test with");
  });

  it("a failed run can be run again; other runs cannot", async () => {
    const x = await crm("run-again");
    const a = await x.create("Inner", { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "http", method: "GET", url: "http://10.0.0.1/x", headers: [] }] });
    await hook(x.baseId, a.automations[0].config.trigger.token, { body: "{}" });
    await settle(x.baseId);
    const failed = (await x.c.req("GET", `${x.url}/${a.id}/runs`)).json[0];
    expect(failed.status).toBe("failed");
    await new Promise(r => setTimeout(r, 5));
    const again = await x.c.req("POST", `/api/bases/${x.baseId}/runs/${failed.id}/retry`, {});
    expect(again.json).toEqual({ runId: failed.id });
    // Miniflare may fire the alarm at once, so the run is either still queued or already ran again.
    expect(["queued", "running", "failed"]).toContain((await x.c.req("GET", `${x.url}/${a.id}/runs`)).json[0].status);
    await settle(x.baseId);
    const rerun = (await x.c.req("GET", `${x.url}/${a.id}/runs`)).json;
    expect(rerun).toHaveLength(1);
    expect(rerun[0]).toMatchObject({ id: failed.id, status: "failed", attempt: 0 });
    expect(rerun[0].finishedAt).toBeGreaterThan(failed.finishedAt);
    expect((await x.c.req("POST", `/api/bases/${x.baseId}/runs/${failed.id}/retry`, {})).status).toBe(200);
    expect((await x.c.req("POST", `/api/bases/${x.baseId}/runs/123456/retry`, {})).status).toBe(404);
  });
});
