import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import { addViewer, HttpClient, ownerWithBase } from "./helpers";

const actor = { userId: "u1", name: "Tester" };
const hookCfg = { trigger: { type: "webhook", token: "" }, steps: [] };

async function crm(prefix: string) {
  const o = await ownerWithBase(prefix);
  const { schema } = (await o.c.req("GET", `/api/bases/${o.baseId}`)).json;
  const deals = schema.tables.find((t: any) => t.name === "Deals");
  const field = (name: string) => schema.fields.find((f: any) => f.tableId === deals.id && f.name === name);
  return { ...o, schema, deals, field, url: `/api/bases/${o.baseId}/automations` };
}

describe("automation definitions", () => {
  it("editors create, list, rename and delete automations", async () => {
    const x = await crm("auto-crud");
    const step = { id: "s1", type: "http", method: "POST", url: "https://example.com/{{trigger.record." + x.field("Name").id + "}}", headers: [] };
    const created = await x.c.req("POST", x.url, { op: "create", name: "Notify", config: { trigger: { type: "recordCreated", tableId: x.deals.id }, steps: [step] } });
    expect(created.status).toBe(200);
    const id = created.json.id;
    expect(created.json.automations).toHaveLength(1);
    expect(created.json.automations[0]).toMatchObject({ id, name: "Notify", enabled: false, failStreak: 0, disabledReason: null, lastRun: null, createdBy: expect.any(String) });
    expect((await x.c.req("POST", x.url, { op: "update", id, name: "Notify team" })).status).toBe(200);
    const list = await x.c.req("GET", x.url);
    expect(list.json.automations[0].name).toBe("Notify team");
    expect(list.json.usage).toEqual({ used: 0, limit: 10000, per: "base" });
    expect((await x.c.req("POST", x.url, { op: "delete", id })).status).toBe(200);
    expect((await x.c.req("GET", x.url)).json.automations).toEqual([]);
  });

  it("rejects invalid definitions with 400", async () => {
    const x = await crm("auto-invalid");
    const bad = await x.c.req("POST", x.url, { op: "create", name: "x", config: { trigger: { type: "recordCreated", tableId: "tblNope" }, steps: [] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("Unknown table tblNope");
    const ref = await x.c.req("POST", x.url, { op: "create", name: "x", config: { trigger: { type: "recordCreated", tableId: x.deals.id }, steps: [{ id: "s1", type: "http", method: "GET", url: "{{trigger.body.x}}", headers: [] }] } });
    expect(ref.json.error).toBe("Unknown reference {{trigger.body.x}}");
    expect((await x.c.req("POST", x.url, { op: "explode" })).json.error).toBe("Unknown automation operation");
  });

  it("assigns webhook tokens on the server and keeps them across edits", async () => {
    const x = await crm("auto-token");
    const r = await x.c.req("POST", x.url, { op: "create", name: "Hook", config: { trigger: { type: "webhook", token: "mine" }, steps: [] } });
    const token = r.json.automations[0].config.trigger.token;
    expect(token).toMatch(/^[A-Za-z0-9]{32}$/);
    await x.c.req("POST", x.url, { op: "update", id: r.json.id, config: { trigger: { type: "webhook", token: "other" }, steps: [] } });
    expect((await x.c.req("GET", x.url)).json.automations[0].config.trigger.token).toBe(token);
    await x.c.req("POST", x.url, { op: "regenerateWebhook", id: r.json.id });
    expect((await x.c.req("GET", x.url)).json.automations[0].config.trigger.token).not.toBe(token);
  });

  it("viewers cannot read definitions and the schema carries only button stubs", async () => {
    const x = await crm("auto-viewer");
    await x.c.req("POST", x.url, { op: "create", name: "Secret hook", config: hookCfg });
    await x.c.req("POST", x.url, { op: "create", name: "Approve", config: { trigger: { type: "button", tableId: x.deals.id, viewerCanRun: true }, steps: [] } });
    const viewer = new HttpClient(await addViewer(x.c, x.wsId, "auto-viewer-v@example.com"));
    expect((await viewer.req("GET", x.url)).status).toBe(403);
    expect((await viewer.req("POST", x.url, { op: "delete", id: "autX" })).status).toBe(403);
    const schema = (await viewer.req("GET", `/api/bases/${x.baseId}`)).json.schema;
    expect(schema.buttons).toEqual([{ id: expect.any(String), name: "Approve", tableId: x.deals.id, viewerCanRun: true, enabled: false }]);
    expect(JSON.stringify(schema)).not.toContain("Secret hook");
  });

  it("holds at most 50 automations per base", async () => {
    const x = await crm("auto-limit");
    for (let i = 0; i < 50; i++) expect((await x.c.req("POST", x.url, { op: "create", name: "A" + i, config: hookCfg })).status).toBe(200);
    expect((await x.c.req("POST", x.url, { op: "create", name: "One more", config: hookCfg })).json.error).toBe("A base holds at most 50 automations");
  });

  it("keeps 1,000 finished runs per automation and none older than 30 days, but never drops queued runs", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("auto-retention"));
    await runInDurableObject(stub, async (i: BaseDO) => {
      if (!i.store.initialized) i.store.init("auto-retention");
      const t = i.store.createTable(actor, { name: "T" }).tableId;
      const { id } = i.automations.apply(actor, { op: "create", name: "R", config: { trigger: { type: "recordCreated", tableId: t }, steps: [] } }, 0);
      const a = i.automations.get(id!);
      const day = 86_400_000;
      const trigger = { type: "recordCreated" as const, at: 0 };
      i.automations.insertRun({ automation: a, status: "skipped", trigger, chain: [], now: day });
      const queued = i.automations.insertRun({ automation: a, status: "queued", trigger, chain: [], now: day });
      for (let k = 0; k < 1001; k++) i.automations.insertRun({ automation: a, status: "skipped", trigger, chain: [], now: 40 * day });
      const runs = i.automations.runs(id!, { limit: 2000 });
      expect(runs.filter(r => r.status === "skipped")).toHaveLength(1000);
      expect(runs.some(r => r.id === queued)).toBe(true);
    });
  });
});
