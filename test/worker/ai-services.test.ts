import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addUsage, listServices, loadService, workersLeft } from "../../src/worker/ai/services";
import { addViewer, ownerWithBase, signup } from "./helpers";

describe("AI services", () => {
  it("owners add, list, update and delete services; keys stay encrypted", async () => {
    const { c, wsId } = await ownerWithBase("ai-svc-1", "blank");
    const add = await c.req("POST", `/api/workspaces/${wsId}/ai-services`, { name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", key: "sk-abcdef1234" });
    expect(add.status).toBe(200);
    const list = await c.req("GET", `/api/workspaces/${wsId}/ai-services`);
    expect(list.json.services).toEqual([{ id: add.json.id, name: "DeepSeek", kind: "openai", model: "deepseek-flash", baseUrl: "https://api.deepseek.com", last4: "1234", keyRejected: false, calls: 0 }]);
    const row = await env.DB.prepare("SELECT secret_enc FROM workspace_ai WHERE id = ?").bind(add.json.id).first<{ secret_enc: string }>();
    expect(row!.secret_enc).not.toContain("sk-abcdef1234");
    const svc = await loadService(env, wsId, add.json.id);
    expect(svc).toMatchObject({ kind: "openai", key: "sk-abcdef1234", model: "deepseek-flash" });
    expect((await c.req("PUT", `/api/workspaces/${wsId}/ai-services/${add.json.id}`, { name: "DS", kind: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" })).status).toBe(200);
    expect((await loadService(env, wsId, add.json.id))!.key).toBe("sk-abcdef1234");
    expect((await c.req("DELETE", `/api/workspaces/${wsId}/ai-services/${add.json.id}`)).status).toBe(200);
    expect((await c.req("GET", `/api/workspaces/${wsId}/ai-services`)).json.services).toEqual([]);
  });

  it("a stored key is not sent to a new address", async () => {
    const { c, wsId } = await ownerWithBase("ai-svc-6", "blank");
    const id = (await c.req("POST", `/api/workspaces/${wsId}/ai-services`, { name: "DS", kind: "openai", baseUrl: "https://api.deepseek.com", model: "m", key: "sk-1234" })).json.id;
    const moved = await c.req("PUT", `/api/workspaces/${wsId}/ai-services/${id}`, { name: "DS", kind: "openai", baseUrl: "https://evil.example.com", model: "m" });
    expect(moved.json.error).toBe("Enter the API key again when you change the address or kind");
    const test = await c.req("POST", `/api/workspaces/${wsId}/ai-services/test`, { id, baseUrl: "https://evil.example.com" });
    expect(test.json.error).toBe("Enter the API key again when you change the address or kind");
    expect((await c.req("PUT", `/api/workspaces/${wsId}/ai-services/${id}`, { name: "DS 2", kind: "openai", baseUrl: "https://api.deepseek.com", model: "m2" })).status).toBe(200);
  });
  it("checks settings", async () => {
    const { c, wsId } = await ownerWithBase("ai-svc-2", "blank");
    const bad = (b: object) => c.req("POST", `/api/workspaces/${wsId}/ai-services`, { name: "X", kind: "openai", model: "m", key: "k", baseUrl: "https://x.test", ...b });
    expect((await bad({ kind: "nope" })).json.error).toBe("Choose Anthropic or an OpenAI-compatible service");
    expect((await bad({ baseUrl: "ftp://x" })).json.error).toBe("The service address must start with https://");
    expect((await bad({ baseUrl: "http://127.0.0.1:11434/v1" })).json.error).toBe("The service address must start with https://");
    expect((await bad({ model: "" })).json.error).toBe("Enter a model name");
    expect((await bad({ key: "" })).json.error).toBe("Enter the API key");
    for (let i = 0; i < 10; i++) expect((await bad({ name: `S${i}` })).status).toBe(200);
    expect((await bad({ name: "S11" })).json.error).toBe("A workspace can have at most 10 AI services");
  });

  it("editors see names and models only; viewers cannot manage", async () => {
    const { c, wsId, baseId } = await ownerWithBase("ai-svc-3", "blank");
    await c.req("POST", `/api/workspaces/${wsId}/ai-services`, { name: "A", kind: "anthropic", model: "claude-sonnet-5-5", key: "sk-ant-9999" });
    const viewerToken = await addViewer(c, wsId, "ai-svc-3-viewer@example.com");
    const v = new (await import("./helpers")).HttpClient(viewerToken);
    const seen = await v.req("GET", `/api/bases/${baseId}/ai-services`);
    expect(seen.json.services[0]).toEqual({ id: expect.any(String), name: "A", kind: "anthropic", model: "claude-sonnet-5-5", keyRejected: false, calls: 0 });
    expect((await v.req("POST", `/api/workspaces/${wsId}/ai-services`, { name: "B", kind: "anthropic", model: "m", key: "k" })).status).toBe(403);
    const other = await signup("ai-svc-3-other@example.com");
    expect((await other.req("GET", `/api/bases/${baseId}/ai-services`)).status).toBe(404);
  });

  it("counts usage per month and computes the Workers AI quota", async () => {
    const { wsId } = await ownerWithBase("ai-svc-4", "blank");
    const now = Date.UTC(2026, 9, 14);
    await addUsage(env, wsId, new Map([["workers", 3]]), now);
    await addUsage(env, wsId, new Map([["workers", 2]]), now);
    expect((await listServices({ ...env, AI: { run: async () => ({}) } } as any, wsId, now)).find(s => s.id === "workers")!.calls).toBe(5);
    expect(await workersLeft({ ...env, AI_WORKERS_MONTHLY_CALLS: "7" } as any, wsId, now)).toBe(2);
    expect(await workersLeft(env, wsId, now)).toBe(Infinity);
    expect(await workersLeft({ ...env, AI_WORKERS_MONTHLY_CALLS: "7" } as any, wsId, Date.UTC(2026, 10, 1))).toBe(7);
  });

  it("test call reports the service's error", async () => {
    const { c, wsId } = await ownerWithBase("ai-svc-5", "blank");
    const r = await c.req("POST", `/api/workspaces/${wsId}/ai-services/test`, { name: "X", kind: "openai", baseUrl: "https://10.0.0.1/v1", model: "m", key: "k" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Requests to private network addresses are not allowed");
  });
});
