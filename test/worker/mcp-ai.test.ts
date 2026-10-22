import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, mcpClient, ownerWithBase } from "./helpers";

describe("MCP AI fields", () => {
  it("create an AI field by names, describe it, list services and generate", async () => {
    const { c, wsId, baseId, token } = await ownerWithBase("mcp-ai-1", "blank");
    await c.req("POST", `/api/workspaces/${wsId}/ai-services`, { name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", key: "sk-1" });
    const client = await mcpClient(token);
    const services = await call(client, "list_ai_services", { baseId });
    expect(services.structuredContent.services).toEqual([{ id: expect.stringMatching(/^ais/), name: "DeepSeek", kind: "openai", model: "deepseek-flash" }]);
    const tbl = await call(client, "create_table", { baseId, name: "Leads", fields: [{ name: "Name", type: "text" }, { name: "Intro", type: "longText", options: { ai: { service: "deepseek", prompt: "Write one line about {Name}" } } }] });
    const intro = tbl.structuredContent.table.fields.find((f: any) => f.name === "Intro");
    expect(intro.options.ai).toEqual({ service: expect.stringMatching(/^ais/), prompt: "Write one line about {Name}", autoUpdate: true });
    const gen = await call(client, "generate_ai_field", { baseId, table: "Leads", field: "Intro", missingOnly: true });
    expect(gen.structuredContent).toEqual({ queued: 0 });
  });
  it("explains an unknown service", async () => {
    const { baseId, token } = await ownerWithBase("mcp-ai-2", "blank");
    const client = await mcpClient(token);
    const r = await call(client, "create_table", { baseId, name: "T", fields: [{ name: "Name", type: "text" }, { name: "X", type: "text", options: { ai: { service: "nope", prompt: "{Name}" } } }] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('Unknown AI service \\"nope\\"');
  });
});
