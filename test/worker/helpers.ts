import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class HttpClient {
  cookie = "";
  constructor(public token?: string) {}
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { "x-rf": "1", ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await SELF.fetch("https://app.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("Set-Cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  }
}

export async function signup(email: string, invite?: string) {
  const c = new HttpClient();
  const r = await c.req("POST", "/api/auth/signup", { email, password: "correct horse", name: email.split("@")[0], invite });
  expect(r.status).toBe(200);
  return c;
}

export async function tokenFor(c: HttpClient): Promise<string> {
  const r = await c.req("POST", "/api/tokens", { name: "mcp" });
  expect(r.status).toBe(200);
  return r.json.token;
}

export async function ownerWithBase(prefix: string, template = "crm") {
  const c = await signup(`${prefix}@example.com`);
  const ws = (await c.req("GET", "/api/auth/me")).json.workspaces[0];
  const baseId = (await c.req("POST", `/api/workspaces/${ws.id}/bases`, { template })).json.id as string;
  return { c, wsId: ws.id as string, baseId, token: await tokenFor(c) };
}

export async function addViewer(owner: HttpClient, wsId: string, email: string): Promise<string> {
  const inv = await owner.req("POST", `/api/workspaces/${wsId}/invites`, { role: "viewer" });
  const viewer = await signup(email, inv.json.id);
  return tokenFor(viewer);
}

export async function mcpClient(token?: string): Promise<Client> {
  const client = new Client({ name: "rowflare-test", version: "1.0.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  const transport = new StreamableHTTPClientTransport(new URL("https://app.test/mcp"), {
    fetch: (url, init) => SELF.fetch(url, init),
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult & { structuredContent?: any }> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult & { structuredContent?: any };
}
