import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import { addViewer, HttpClient, ownerWithBase } from "./helpers";

async function prepare(prefix: string) {
  const o = await ownerWithBase(prefix, "blank");
  const schema = (await o.c.req("GET", `/api/bases/${o.baseId}`)).json.schema;
  const tableId = schema.tables[0].id as string;
  const nameField = schema.tables[0].primaryFieldId as string;
  const stub = env.BASE.get(env.BASE.idFromName(o.baseId));
  await runInDurableObject(stub, (i: BaseDO) => {
    i.aiService = async () => ({ id: "ais1", kind: "openai", baseUrl: "https://x.test", model: "m", key: "k", keyRejected: false });
    i.aiCall = async (_s, r) => `Echo ${r.prompt}`;
  });
  const created = await o.c.req("POST", `/api/bases/${o.baseId}/schema`, { op: "createField", tableId, field: { name: "Echo", type: "text", options: { ai: { serviceId: "ais1", prompt: `Say {${nameField}}`, autoUpdate: false } } } });
  const fieldId = created.json.id as string;
  const rows = await o.c.req("POST", `/api/bases/${o.baseId}/rows`, { op: "create", tableId, rows: [{ cells: { [nameField]: "a" } }, { cells: { [nameField]: "b" } }] });
  return { ...o, tableId, nameField, fieldId, stub, ids: rows.json.created as number[] };
}

// The blank template starts with 3 empty records, so the table has 5.
describe("AI routes", () => {
  it("generate missing, status and stop", async () => {
    const p = await prepare("ai-r-1");
    const base = `/api/bases/${p.baseId}/tables/${p.tableId}/ai/${p.fieldId}`;
    expect((await p.c.req("GET", base)).json).toMatchObject({ queued: 0, missing: 5, broken: null });
    // Paused, so the alarm cannot work through the queue before the status is read.
    await runInDurableObject(p.stub, (i: BaseDO) => void (i.canRun = async () => false));
    expect((await p.c.req("POST", `${base}/generate`, { missingOnly: true })).json).toEqual({ queued: 5 });
    expect((await p.c.req("GET", base)).json).toMatchObject({ queued: 5, total: 5 });
    expect((await p.c.req("POST", `${base}/stop`)).status).toBe(200);
    expect((await p.c.req("GET", base)).json).toMatchObject({ queued: 0 });
    await runInDurableObject(p.stub, (i: BaseDO) => void (i.canRun = async () => true));
    expect((await p.c.req("POST", `${base}/generate`, { rowIds: [p.ids[0]] })).json).toEqual({ queued: 1 });
    await runInDurableObject(p.stub, (i: BaseDO) => i.ai.engine.drain(() => Date.now() + 10_000));
    const rows = await p.c.req("POST", `/api/bases/${p.baseId}/rows/get`, { tableId: p.tableId, ids: [p.ids[0]] });
    expect(rows.json[0].cells[p.fieldId]).toBe("Echo Say a");
  });
  it("preview answers without writing", async () => {
    const p = await prepare("ai-r-2");
    const r = await p.c.req("POST", `/api/bases/${p.baseId}/ai/preview`, { tableId: p.tableId, rowId: p.ids[1], field: { type: "text", options: { ai: { serviceId: "ais1", prompt: `Hi {${p.nameField}}` } } } });
    expect(r.json).toEqual({ answer: "Echo Hi b", value: "Echo Hi b", prompt: "Hi b", cut: false });
    const rows = await p.c.req("POST", `/api/bases/${p.baseId}/rows/get`, { tableId: p.tableId, ids: [p.ids[1]] });
    expect(rows.json[0].cells[p.fieldId]).toBeUndefined();
  });
  it("viewers can read status but not generate", async () => {
    const p = await prepare("ai-r-3");
    const v = new HttpClient(await addViewer(p.c, p.wsId, "ai-r-3-viewer@example.com"));
    const base = `/api/bases/${p.baseId}/tables/${p.tableId}/ai/${p.fieldId}`;
    expect((await v.req("GET", base)).status).toBe(200);
    expect((await v.req("POST", `${base}/generate`, {})).status).toBe(403);
  });
  it("rejects fields that are not AI fields and too many row ids", async () => {
    const p = await prepare("ai-r-4");
    expect((await p.c.req("POST", `/api/bases/${p.baseId}/tables/${p.tableId}/ai/${p.nameField}/generate`, {})).json.error).toBe("This is not an AI field");
    expect((await p.c.req("POST", `/api/bases/${p.baseId}/tables/${p.tableId}/ai/${p.fieldId}/generate`, { rowIds: Array.from({ length: 5001 }, (_, k) => k) })).json.error).toBe("At most 5,000 records per request");
  });
});
