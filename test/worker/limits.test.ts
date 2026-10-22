import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { DEFAULT_HOSTING, clearPlanCache, setHosting, type PlanLimits } from "../../src/worker/hosting";
import type { BaseDO } from "../../src/worker/base-do";
import { addUpload, recountStorage, storageUsed } from "../../src/worker/limits";

let limits: PlanLimits = {};
const testHosting = { plan: async () => ({ name: "Small", paid: false, limits, upgradeUrl: "https://example.com/upgrade" }) };

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers: Record<string, string> = { "x-rf": "1", ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}), ...(init.cookie ? { cookie: init.cookie } : {}) };
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://app.test" + path, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

async function owner(email: string) {
  const s = await call("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: "correct horse" }) });
  const cookie = s.headers.get("set-cookie")!.split(";")[0];
  const ws = (await call("/api/workspaces", { cookie })).json[0].id as string;
  return { cookie, ws };
}

async function base(o: { cookie: string; ws: string }) {
  const r = await call(`/api/workspaces/${o.ws}/bases`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ template: "blank" }) });
  const schema = (await call(`/api/bases/${r.json.id}`, { cookie: o.cookie })).json.schema;
  return { id: r.json.id as string, table: schema.tables[0].id as string, name: schema.tables[0].primaryFieldId as string };
}

const rows = (o: { cookie: string }, b: { id: string; table: string; name: string }, n: number) =>
  call(`/api/bases/${b.id}/rows`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "create", tableId: b.table, rows: Array.from({ length: n }, (_, k) => ({ cells: { [b.name]: `r${k}` } })) }) });

const count = (b: { id: string }) => runInDurableObject(env.BASE.get(env.BASE.idFromName(b.id)), (i: BaseDO) => i.store.totalRows());

describe("plan limits", () => {
  beforeEach(() => setHosting(testHosting));
  afterEach(() => setHosting(DEFAULT_HOSTING));

  it("a workspace cannot create more bases than its plan allows", async () => {
    limits = { bases: 1 };
    const o = await owner("lim-bases@example.com");
    expect((await call(`/api/workspaces/${o.ws}/bases`, { method: "POST", cookie: o.cookie, body: "{}" })).status).toBe(200);
    const r = await call(`/api/workspaces/${o.ws}/bases`, { method: "POST", cookie: o.cookie, body: "{}" });
    expect(r.status).toBe(402);
    expect(r.json).toEqual({ error: "This plan allows 1 base per workspace", limit: { key: "bases", limit: 1, upgradeUrl: "https://example.com/upgrade" } });
  });

  it("a paste over the limit writes nothing", async () => {
    limits = { recordsPerBase: 10 };
    const o = await owner("lim-paste@example.com");
    const b = await base(o);
    expect(await count(b)).toBe(3);
    expect((await rows(o, b, 5)).status).toBe(200);
    const r = await rows(o, b, 3);
    expect(r.status).toBe(402);
    expect(r.json.error).toBe("This plan allows 10 records per base; 2 more can be added");
    expect(r.json.limit).toEqual({ key: "records", limit: 10, upgradeUrl: "https://example.com/upgrade" });
    expect(await count(b)).toBe(8);
  });

  it("over the limit existing records stay editable and deletes free room", async () => {
    limits = { recordsPerBase: 5 };
    const o = await owner("lim-over@example.com");
    const b = await base(o);
    limits = {};
    await runInDurableObject(env.BASE.get(env.BASE.idFromName(b.id)), (i: BaseDO) => void i.planChanged());
    expect((await rows(o, b, 5)).status).toBe(200);
    limits = { recordsPerBase: 5 };
    await runInDurableObject(env.BASE.get(env.BASE.idFromName(b.id)), (i: BaseDO) => void i.planChanged());
    const ids = (await call(`/api/bases/${b.id}/query`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ tableId: b.table }) })).json.ids as number[];
    const upd = await call(`/api/bases/${b.id}/rows`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "update", tableId: b.table, updates: [{ id: ids[0], cells: { [b.name]: "edited" } }] }) });
    expect(upd.status).toBe(200);
    expect((await rows(o, b, 1)).status).toBe(402);
    await call(`/api/bases/${b.id}/rows`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "delete", tableId: b.table, ids: ids.slice(0, 4) }) });
    expect((await rows(o, b, 1)).status).toBe(200);
  });

  it("linked records made by typecast count toward the limit", async () => {
    limits = { recordsPerBase: 10 };
    const o = await owner("lim-typecast@example.com");
    const b = await base(o);
    const other = (await call(`/api/bases/${b.id}/schema`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "createTable", name: "Other", emptyRows: 0 }) })).json.id;
    const link = (await call(`/api/bases/${b.id}/schema`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "createField", tableId: b.table, field: { name: "Other", type: "link", options: { linkedTableId: other } } }) })).json.id;
    const id = (await call(`/api/bases/${b.id}/query`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ tableId: b.table }) })).json.ids[0];
    const write = (names: string[]) => call(`/api/bases/${b.id}/rows`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "update", tableId: b.table, typecast: true, updates: [{ id, cells: { [link]: names } }] }) });
    const r = await write(Array.from({ length: 8 }, (_, k) => `n${k}`));
    expect(r.status).toBe(402);
    expect(r.json.limit.key).toBe("records");
    expect(await count(b)).toBe(3);
    expect((await write(["a", "b"])).status).toBe(200);
    expect(await count(b)).toBe(5);
  });

  it("converting a text field to links stops making linked records at the limit and still finishes", async () => {
    limits = { recordsPerBase: 5 };
    const o = await owner("lim-convert@example.com");
    const b = await base(o);
    const other = (await call(`/api/bases/${b.id}/schema`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "createTable", name: "Other", emptyRows: 0 }) })).json.id;
    const tags = (await call(`/api/bases/${b.id}/schema`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "createField", tableId: b.table, field: { name: "Tags", type: "text" } }) })).json.id;
    const ids = (await call(`/api/bases/${b.id}/query`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ tableId: b.table }) })).json.ids as number[];
    await call(`/api/bases/${b.id}/rows`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "update", tableId: b.table, updates: ids.map((id, k) => ({ id, cells: { [tags]: `name ${k}` } })) }) });
    const conv = await call(`/api/bases/${b.id}/schema`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "updateField", fieldId: tags, patch: { type: "link", options: { linkedTableId: other } } }) });
    expect(conv.status).toBe(200);
    const s = env.BASE.get(env.BASE.idFromName(b.id));
    for (let k = 0; k < 5; k++) await runDurableObjectAlarm(s);
    expect(await runInDurableObject(s, (i: BaseDO) => i.store.hasJobs())).toBe(false);
    expect(await count(b)).toBe(5);
  });

  it("the app can ask for room before an import or paste", async () => {
    limits = { recordsPerBase: 10 };
    const o = await owner("lim-room@example.com");
    const b = await base(o);
    const check = (count: number) => call(`/api/bases/${b.id}/rows/check`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ count }) });
    expect((await check(7)).status).toBe(200);
    const r = await check(8);
    expect(r.status).toBe(402);
    expect(r.json.error).toBe("This plan allows 10 records per base; 7 more can be added");
  });

  it("the limit counts every table of the base", async () => {
    limits = { recordsPerBase: 4 };
    const o = await owner("lim-tables@example.com");
    const b = await base(o);
    const t2 = await call(`/api/bases/${b.id}/schema`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "createTable", name: "Second", fields: [{ name: "N", type: "text" }] }) });
    expect(t2.status).toBe(200);
    const second = t2.json.id as string;
    const nf = t2.json.schema.fields.find((f: any) => f.tableId === second).id;
    const r = await call(`/api/bases/${b.id}/rows`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "create", tableId: second, rows: [{ cells: { [nf]: "a" } }, { cells: { [nf]: "b" } }] }) });
    expect(r.status).toBe(402);
    expect(r.json.error).toBe("This plan allows 4 records per base; 1 more can be added");
  });

  it("writes made inside the base (automation steps, imports) are limited the same way", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("lim-store"));
    await runInDurableObject(stub, (i: BaseDO) => {
      i.store.init("lim-store");
      const t = i.store.createTable({ userId: "u", name: "U" }, { name: "T", fields: [{ name: "N", type: "text" }] }).tableId;
      i.store.recordLimit = () => ({ limit: 1 });
      i.store.createRows({ userId: "u", name: "U" }, t, [{}]);
      let err: any;
      try {
        i.store.createRows({ userId: "u", name: "U" }, t, [{}], { noTriggers: true });
      } catch (e) {
        err = e;
      }
      expect(err?.status).toBe(402);
      expect(err?.limit).toEqual({ key: "records", limit: 1, upgradeUrl: undefined });
    });
  });
});

describe("attachment storage", () => {
  beforeEach(() => setHosting(testHosting));
  afterEach(() => setHosting(DEFAULT_HOSTING));

  const upload = (o: { cookie: string }, b: { id: string }, bytes: number) =>
    call(`/api/bases/${b.id}/attachments?name=f.bin`, { method: "POST", cookie: o.cookie, headers: { "content-type": "application/octet-stream", "content-length": String(bytes) } as any, body: new Uint8Array(bytes) as any });

  it("uploads stop at the plan's storage", async () => {
    limits = { attachmentBytes: 1000 };
    const o = await owner("lim-files@example.com");
    const b = await base(o);
    expect((await upload(o, b, 600)).status).toBe(200);
    const r = await upload(o, b, 600);
    expect(r.status).toBe(402);
    expect(r.json.limit).toMatchObject({ key: "attachments", limit: 1000 });
    expect(r.json.error).toBe("This plan allows 1,000 bytes of attachments; 400 bytes are left");
  });

  it("limit messages use the same units as the app (1 MB = 1,000,000 bytes)", async () => {
    limits = { attachmentBytes: 100_000_000 };
    const o = await owner("lim-units@example.com");
    const b = await base(o);
    await addUpload(env, o.ws, 99_500_000);
    const r = await upload(o, b, 600_000);
    expect(r.json.error).toBe("This plan allows 100 MB of attachments; 500 KB are left");
  });

  it("the recount frees deleted files and keeps later uploads", async () => {
    limits = { attachmentBytes: 10_000 };
    const o = await owner("lim-recount@example.com");
    const b = await base(o);
    const schema = (await call(`/api/bases/${b.id}`, { cookie: o.cookie })).json.schema;
    const f = await call(`/api/bases/${b.id}/schema`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "createField", tableId: b.table, field: { name: "Files", type: "attachment" } }) });
    const files = f.json.id as string;
    const a1 = (await upload(o, b, 700)).json;
    const a2 = (await upload(o, b, 900)).json;
    const id = (await call(`/api/bases/${b.id}/query`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ tableId: b.table }) })).json.ids[0];
    await call(`/api/bases/${b.id}/rows`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "update", tableId: b.table, updates: [{ id, cells: { [files]: [a1] } }] }) });
    expect(await storageUsed(env, o.ws)).toBe(1600);
    // a2 was never put in a cell, so a recount a day later drops it; an upload made while counting is kept.
    let once = false;
    await recountStorage(env, Date.now() + 2 * 86_400_000, 100, async () => {
      if (once) return;
      once = true;
      await addUpload(env, o.ws, 250);
    });
    expect(await storageUsed(env, o.ws)).toBe(700 + 250);
    void schema;
    void a2;
  });

  const withFiles = async (o: { cookie: string }, b: { id: string; table: string }) => {
    const f = await call(`/api/bases/${b.id}/schema`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "createField", tableId: b.table, field: { name: "Files", type: "attachment" } }) });
    const id = (await call(`/api/bases/${b.id}/query`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ tableId: b.table }) })).json.ids[0];
    const put = (value: unknown) => call(`/api/bases/${b.id}/rows`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "update", tableId: b.table, updates: [{ id, cells: { [f.json.id]: value } }] }) });
    return put;
  };

  it("sizes written into cells do not change the count", async () => {
    limits = { attachmentBytes: 10_000 };
    const o = await owner("lim-sizes@example.com");
    const b = await base(o);
    const put = await withFiles(o, b);
    const a = (await upload(o, b, 700)).json;
    await put([{ ...a, size: -1e15 }, { ...a, id: "attFake", key: `${b.id}/attFake/x.bin`, size: -5 }]);
    await recountStorage(env, Date.now());
    expect(await storageUsed(env, o.ws)).toBe(700);
    await put([{ ...a, size: 0 }]);
    await recountStorage(env, Date.now() + 3_600_000);
    expect(await storageUsed(env, o.ws)).toBe(700);
  });

  it("uploads never put in a cell count for a day and are deleted after a week", async () => {
    limits = { attachmentBytes: 10_000 };
    const o = await owner("lim-orphans@example.com");
    const b = await base(o);
    const a = (await upload(o, b, 900)).json;
    const day = 86_400_000;
    await recountStorage(env, Date.now());
    expect(await storageUsed(env, o.ws)).toBe(900);
    await recountStorage(env, Date.now() + 2 * day);
    expect(await storageUsed(env, o.ws)).toBe(0);
    expect(await env.FILES.head(a.key)).not.toBeNull();
    await recountStorage(env, Date.now() + 10 * day);
    expect(await env.FILES.head(a.key)).toBeNull();
  });

  it("one recount covers every workspace, more than a batch of them", async () => {
    limits = { attachmentBytes: 10_000 };
    const later = Date.now() + 30 * 86_400_000;
    const os = [await owner("lim-batch-1@example.com"), await owner("lim-batch-2@example.com"), await owner("lim-batch-3@example.com")];
    for (const o of os) {
      await base(o);
      await addUpload(env, o.ws, 123);
    }
    await recountStorage(env, later, 1);
    for (const o of os) expect(await storageUsed(env, o.ws)).toBe(0);
  });

  it("a file taken out of a cell and put back within a week is kept", async () => {
    limits = { attachmentBytes: 10_000 };
    const o = await owner("lim-undo-file@example.com");
    const b = await base(o);
    const put = await withFiles(o, b);
    const a = (await upload(o, b, 300)).json;
    await put([a]);
    await recountStorage(env, Date.now());
    await put([]);
    await recountStorage(env, Date.now() + 2 * 86_400_000);
    expect(await storageUsed(env, o.ws)).toBe(0);
    await put([a]);
    await recountStorage(env, Date.now() + 10 * 86_400_000);
    expect(await env.FILES.head(a.key)).not.toBeNull();
    expect(await storageUsed(env, o.ws)).toBe(300);
  });
});

describe("automation runs and Workers AI", () => {
  beforeEach(() => setHosting(testHosting));
  afterEach(() => setHosting(DEFAULT_HOSTING));

  const stub = (b: { id: string }) => env.BASE.get(env.BASE.idFromName(b.id));
  const onCreate = (o: { cookie: string }, b: { id: string; table: string }) =>
    call(`/api/bases/${b.id}/automations`, { method: "POST", cookie: o.cookie, body: JSON.stringify({ op: "create", name: "On create", enabled: true, config: { trigger: { type: "recordCreated", tableId: b.table }, steps: [] } }) });
  const runs = (b: { id: string }) => runInDurableObject(stub(b), (i: BaseDO) => i.store.all<{ status: string; error: string | null }>("SELECT status, error FROM _auto_runs ORDER BY id"));

  it("the workspace's runs stop at the plan's monthly limit", async () => {
    limits = { automationRuns: { per: "workspace", n: 3 } };
    const o = await owner("lim-runs@example.com");
    const b = await base(o);
    await onCreate(o, b);
    for (let k = 0; k < 4; k++) await rows(o, b, 1);
    const r = await runs(b);
    expect(r.filter(x => x.status === "skipped")).toEqual([{ status: "skipped", error: "This workspace used its 3 automation runs for this month" }]);
    expect(r.length).toBe(4);
    const list = await call(`/api/bases/${b.id}/automations`, { cookie: o.cookie });
    expect(list.json.usage).toEqual({ used: 3, limit: 3, per: "workspace" });
  });

  it("two bases share the workspace run limit", async () => {
    limits = { automationRuns: { per: "workspace", n: 3 } };
    const o = await owner("lim-runs-two@example.com");
    const a = await base(o);
    const b = await base(o);
    await onCreate(o, a);
    await onCreate(o, b);
    await rows(o, a, 3);
    await rows(o, b, 3);
    const counted = (await runs(a)).concat(await runs(b)).filter(x => x.status !== "skipped").length;
    expect(counted).toBeGreaterThanOrEqual(3);
    expect(counted).toBeLessThanOrEqual(6);
    await runDurableObjectAlarm(stub(a));
    await runDurableObjectAlarm(stub(b));
    await rows(o, a, 1);
    await rows(o, b, 1);
    expect((await runs(a)).at(-1)!.status).toBe("skipped");
    expect((await runs(b)).at(-1)!.status).toBe("skipped");
    const used = await env.DB.prepare("SELECT n FROM workspace_usage WHERE workspace_id = ? AND kind = 'automationRuns'").bind(o.ws).first<{ n: number }>();
    expect(used!.n).toBe(counted);
  });

  it("a base sees runs other bases already counted, even with its plan cached", async () => {
    limits = { automationRuns: { per: "workspace", n: 3 } };
    const o = await owner("lim-runs-fresh@example.com");
    const a = await base(o);
    const b = await base(o);
    await onCreate(o, a);
    await onCreate(o, b);
    await rows(o, b, 0);
    await rows(o, a, 3);
    await runDurableObjectAlarm(stub(a));
    await rows(o, b, 2);
    expect((await runs(b)).map(r => r.status)).toEqual(["skipped", "skipped"]);
  });

  it("per-base limits keep counting in the base", async () => {
    limits = { automationRuns: { per: "base", n: 2 } };
    const o = await owner("lim-runs-base@example.com");
    const b = await base(o);
    await onCreate(o, b);
    await rows(o, b, 3);
    expect((await runs(b)).map(x => x.status).filter(s => s === "skipped")).toHaveLength(1);
    expect((await runs(b)).find(x => x.status === "skipped")!.error).toBe("This base used its 2 automation runs for this month");
  });

  it("Workers AI calls follow the plan", async () => {
    limits = { workersAiCalls: 2 };
    const o = await owner("lim-ai@example.com");
    const b = await base(o);
    await env.DB.prepare("INSERT INTO ai_usage (workspace_id, service_id, month, n) VALUES (?, 'workers', ?, 1)").bind(o.ws, new Date().toISOString().slice(0, 7)).run();
    expect(await runInDurableObject(stub(b), (i: BaseDO) => i.aiWorkersStored())).toBe(1);
    limits = {};
    await runInDurableObject(stub(b), (i: BaseDO) => i.planChanged());
    expect(await runInDurableObject(stub(b), (i: BaseDO) => i.aiWorkersStored())).toBe(Infinity);
  });
});

describe("billing and usage routes", () => {
  afterEach(() => setHosting(DEFAULT_HOSTING));

  it("there is no billing view without a hosting that provides one", async () => {
    const o = await owner("bill-none@example.com");
    expect((await call(`/api/workspaces/${o.ws}/billing`, { cookie: o.cookie })).status).toBe(404);
    expect((await call("/api/config")).json.billing).toBe(false);
  });

  it("the hosting's billing view is shown to members only", async () => {
    const view = { plan: "Free", paid: false, usage: [], actions: [{ label: "Upgrade", post: "/api/x/checkout", style: "primary" as const }] };
    setHosting({ ...testHosting, billing: async () => view });
    const o = await owner("bill-view@example.com");
    expect((await call(`/api/workspaces/${o.ws}/billing`, { cookie: o.cookie })).json).toEqual(view);
    const other = await owner("bill-other@example.com");
    expect((await call(`/api/workspaces/${o.ws}/billing`, { cookie: other.cookie })).status).toBe(404);
  });

  it("usage counts bases, records, files, runs and AI calls against the plan", async () => {
    limits = { bases: 3, recordsPerBase: 1000, attachmentBytes: 10_000, automationRuns: { per: "workspace", n: 50 }, workersAiCalls: 100 };
    setHosting(testHosting);
    const o = await owner("usage@example.com");
    const a = await base(o);
    const b = await base(o);
    await rows(o, a, 7);
    await addUpload(env, o.ws, 1234);
    await env.DB.prepare("INSERT INTO ai_usage (workspace_id, service_id, month, n) VALUES (?, 'workers', ?, 4)").bind(o.ws, new Date().toISOString().slice(0, 7)).run();
    const r = await call(`/api/workspaces/${o.ws}/usage`, { cookie: o.cookie });
    expect(r.json.plan).toEqual({ name: "Small", paid: false, upgradeUrl: "https://example.com/upgrade" });
    expect(Object.fromEntries(r.json.usage.map((u: any) => [u.key, [u.used, u.limit]]))).toEqual({
      bases: [2, 3],
      records: [10, 1000],
      attachments: [1234, 10_000],
      automationRuns: [0, 50],
      workersAiCalls: [4, 100],
    });
    expect(b.id).toBeTruthy();
  });

  it("without limits usage shows no limit", async () => {
    const o = await owner("usage-free@example.com");
    await base(o);
    const r = await call(`/api/workspaces/${o.ws}/usage`, { cookie: o.cookie });
    expect(r.json.usage.find((u: any) => u.key === "bases")).toMatchObject({ used: 1, limit: null });
    expect(r.json.usage.find((u: any) => u.key === "automationRuns")).toMatchObject({ used: 0, limit: 10_000, label: "Automation runs this month in the busiest base" });
  });
});

describe("plan outages", () => {
  afterEach(() => setHosting(DEFAULT_HOSTING));

  it("when the plan cannot be read, writes keep the last plan", async () => {
    let fail = false;
    setHosting({ plan: async () => { if (fail) throw new Error("plan store down"); return { name: "Small", paid: false, limits: { recordsPerBase: 10 } }; } });
    const o = await owner("lim-outage@example.com");
    const b = await base(o);
    expect((await rows(o, b, 2)).status).toBe(200);
    fail = true;
    clearPlanCache();
    await runInDurableObject(env.BASE.get(env.BASE.idFromName(b.id)), (i: BaseDO) => void ((i as unknown as { planAt: number }).planAt = 0));
    expect((await rows(o, b, 2)).status).toBe(200);
    const over = await rows(o, b, 10);
    expect(over.status).toBe(402);
  });
});
