import { describe, expect, it } from "vitest";
import { addViewer, call, mcpClient, ownerWithBase } from "./helpers";

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("MCP dashboard tools", () => {
  it("creates a dashboard by names and reads live numbers back", async () => {
    const { token, baseId } = await ownerWithBase("mcp-dash");
    const client = await mcpClient(token);
    const created = await call(client, "create_dashboard", {
      baseId,
      name: "Pipeline",
      widgets: [
        { type: "metric", title: "Deals", table: "Deals", metric: { fn: "count" } },
        { type: "bar", title: "Amount by stage", table: "Deals", x: "Stage", metric: { fn: "sum", field: "Amount" } },
        { type: "text", text: "# Notes" },
      ],
    });
    expect(created.isError).toBeFalsy();
    const id = created.structuredContent.dashboard.id;
    const got = await call(client, "get_dashboard", { baseId, dashboard: "Pipeline" });
    const [metric, bar, note] = got.structuredContent.dashboard.widgets;
    expect(metric).toMatchObject({ type: "metric", table: "Deals", metric: { fn: "count" }, position: { x: 0, y: 0, w: 3, h: 2 } });
    expect(metric.data.groups[0].values.v).toBe(30);
    expect(bar).toMatchObject({ x: "Stage", metric: { fn: "sum", field: "Amount" } });
    const agg = await call(client, "aggregate", { baseId, table: "Deals", groupBy: [{ field: "Stage" }], metrics: [{ fn: "sum", field: "Amount", as: "v" }] });
    expect(bar.data.groups).toEqual(agg.structuredContent.groups);
    expect(note).toMatchObject({ type: "text", text: "# Notes" });
    expect(note.data).toBeUndefined();
    const list = await call(client, "list_dashboards", { baseId });
    expect(list.structuredContent.dashboards).toEqual([{ id, name: "Pipeline", widgets: 3 }]);
  });

  it("updates a dashboard: rename, edit and move, remove, add", async () => {
    const { token, baseId } = await ownerWithBase("mcp-dash-update");
    const client = await mcpClient(token);
    const created = await call(client, "create_dashboard", { baseId, name: "P", widgets: [{ type: "metric", table: "Deals", metric: { fn: "count" } }, { type: "text", text: "x" }] });
    const [m, t] = created.structuredContent.dashboard.widgets;
    const r = await call(client, "update_dashboard", {
      baseId,
      dashboard: "P",
      name: "Sales",
      update: [{ id: m.id, title: "All deals", position: { x: 6, y: 0, w: 6, h: 2 } }],
      remove: [t.id],
      add: [{ type: "pie", table: "Deals", group: "Stage", metric: { fn: "count" }, donut: true }],
    });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent.dashboard;
    expect(d.name).toBe("Sales");
    expect(d.widgets.map((w: { type: string }) => w.type)).toEqual(["metric", "pie"]);
    expect(d.widgets[0]).toMatchObject({ title: "All deals", position: { x: 6, y: 0, w: 6, h: 2 } });
    expect(d.widgets[1]).toMatchObject({ group: "Stage", donut: true });
  });

  it("checks the widgets to remove before changing anything", async () => {
    const { token, baseId } = await ownerWithBase("mcp-dash-remove");
    const client = await mcpClient(token);
    await call(client, "create_dashboard", { baseId, name: "P", widgets: [{ type: "text", text: "x" }] });
    const r = await call(client, "update_dashboard", { baseId, dashboard: "P", name: "Renamed", remove: ["wgtNope"] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('Widget wgtNope is not on dashboard \\"P\\"');
    const d = (await call(client, "get_dashboard", { baseId, dashboard: "P" })).structuredContent.dashboard;
    expect(d.name).toBe("P");
  });

  it("explains bad names and refuses viewers", async () => {
    const { c, wsId, token, baseId } = await ownerWithBase("mcp-dash-errors");
    const client = await mcpClient(token);
    const bad = await call(client, "create_dashboard", { baseId, name: "X", widgets: [{ type: "bar", table: "Deals", x: "Stagee", metric: { fn: "count" } }] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('Unknown field "Stagee" in table Deals. Fields: Name, Stage, Amount');
    const viewer = await mcpClient(await addViewer(c, wsId, "mcp-dash-viewer@example.com"));
    const denied = await call(viewer, "create_dashboard", { baseId, name: "Y" });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toBe("You have read-only access to this base");
  });
});
