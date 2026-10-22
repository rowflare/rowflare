import { describe, expect, it } from "vitest";
import { addViewer, call, mcpClient, ownerWithBase } from "./helpers";

describe("MCP automation tools", () => {
  it("creates an automation with names, stores ids and starts it switched off", async () => {
    const x = await ownerWithBase("mcp-auto-create");
    const m = await mcpClient(x.token);
    const r = await call(m, "create_automation", {
      baseId: x.baseId,
      name: "Won deals",
      trigger: { type: "recordMatches", table: "Deals", filter: { conditions: [{ field: "Stage", op: "eq", value: "Won" }] } },
      steps: [
        { type: "http", method: "POST", url: "https://example.com/won?deal={{trigger.record.Name}}", headers: { "X-Source": "rowflare" } },
        { type: "createRecord", table: "Companies", values: { Name: "From {{trigger.record.Name}}" } },
      ],
    });
    expect(r.isError).toBeFalsy();
    const a = r.structuredContent.automation;
    expect(a).toMatchObject({ name: "Won deals", enabled: false, trigger: { type: "recordMatches", table: "Deals", filter: { conditions: [{ field: "Stage", op: "eq", value: "Won" }] } } });
    expect(a.steps).toEqual([
      { id: "s1", type: "http", method: "POST", url: "https://example.com/won?deal={{trigger.record.Name}}", headers: { "X-Source": "rowflare" } },
      { id: "s2", type: "createRecord", table: "Companies", values: { Name: "From {{trigger.record.Name}}" } },
    ]);
    const stored = (await x.c.req("GET", `/api/bases/${x.baseId}/automations`)).json.automations[0];
    expect(stored.config.steps[0].url).toMatch(/\{\{trigger\.record\.fld[A-Za-z0-9]+\}\}/);
  });

  it("updates, switches on, and reads recent runs", async () => {
    const x = await ownerWithBase("mcp-auto-update");
    const m = await mcpClient(x.token);
    await call(m, "create_automation", { baseId: x.baseId, name: "Hook", trigger: { type: "webhook" }, steps: [] });
    const u = await call(m, "update_automation", { baseId: x.baseId, automation: "Hook", name: "Inbound", enabled: true, steps: [{ type: "createRecord", table: "Deals", values: { Name: "{{trigger.body.deal}}" } }] });
    expect(u.structuredContent.automation).toMatchObject({ name: "Inbound", enabled: true, steps: [{ id: "s1", type: "createRecord", table: "Deals", values: { Name: "{{trigger.body.deal}}" } }] });
    expect(u.structuredContent.automation.webhookUrl).toMatch(new RegExp(`/api/hooks/${x.baseId}/[A-Za-z0-9]{32}$`));
    const list = await call(m, "list_automations", { baseId: x.baseId });
    expect(list.structuredContent.automations).toEqual([{ id: expect.any(String), name: "Inbound", enabled: true, trigger: "webhook", lastRun: null }]);
    const g = await call(m, "get_automation", { baseId: x.baseId, automation: "inbound" });
    expect(g.structuredContent.runs).toEqual([]);
  });

  it("reports unknown names and invalid definitions as tool errors", async () => {
    const x = await ownerWithBase("mcp-auto-errors");
    const m = await mcpClient(x.token);
    const badField = await call(m, "create_automation", { baseId: x.baseId, name: "x", trigger: { type: "recordUpdated", table: "Deals", watch: ["Nope"] }, steps: [] });
    expect(badField.isError).toBe(true);
    expect(JSON.stringify(badField.content)).toContain("Nope");
    const badRef = await call(m, "create_automation", { baseId: x.baseId, name: "x", trigger: { type: "schedule", every: "day", at: "09:00" }, steps: [{ type: "http", url: "{{trigger.body.x}}" }] });
    expect(JSON.stringify(badRef.content)).toContain("Unknown reference {{trigger.body.x}}");
  });

  it("viewers cannot read automations", async () => {
    const x = await ownerWithBase("mcp-auto-viewer");
    const viewerToken = await addViewer(x.c, x.wsId, "mcp-auto-viewer-v@example.com");
    const r = await call(await mcpClient(viewerToken), "list_automations", { baseId: x.baseId });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Only editors can see automations");
  });
});
