import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addViewer, call, HttpClient, mcpClient, ownerWithBase, signup } from "./helpers";

const rpc = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const post = (headers: Record<string, string>, body = rpc("tools/list")) =>
  SELF.fetch("https://app.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body });

describe("MCP transport and auth", () => {
  it("rejects requests without a token", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="rowflare"');
  });

  it("rejects a session cookie without a token", async () => {
    const c = await signup("mcp-cookie@example.com");
    const res = await post({ Cookie: c.cookie, "x-rf": "1" });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown token", async () => {
    expect((await post({ Authorization: "Bearer rf_nope" })).status).toBe(401);
  });

  it("answers GET and DELETE with 405", async () => {
    const { token } = await ownerWithBase("mcp-405");
    for (const method of ["GET", "DELETE"]) {
      const res = await SELF.fetch("https://app.test/mcp", { method, headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(405);
    }
  });

  it("initializes and lists all tools", async () => {
    const { token } = await ownerWithBase("mcp-init");
    const client = await mcpClient(token);
    expect(client.getServerVersion()?.name).toBe("rowflare");
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names.sort()).toEqual(["aggregate", "create_automation", "create_dashboard", "create_field", "create_records", "create_table", "create_view", "delete_field", "delete_records", "delete_table", "describe_base", "generate_ai_field", "get_automation", "get_dashboard", "get_records", "list_ai_services", "list_automations", "list_bases", "list_dashboards", "query_records", "update_automation", "update_dashboard", "update_field", "update_records", "update_table", "update_view"]);
    const describe = (await client.listTools()).tools.find(t => t.name === "describe_base")!;
    expect(describe.annotations?.readOnlyHint).toBe(true);
  });
});

describe("MCP read tools", () => {
  it("lists bases and describes one with friendly options", async () => {
    const { token, baseId } = await ownerWithBase("mcp-describe");
    const client = await mcpClient(token);
    const bases = await call(client, "list_bases");
    expect(bases.isError).toBeFalsy();
    expect(bases.structuredContent.bases).toEqual([expect.objectContaining({ id: baseId, permission: "create" })]);
    expect(JSON.parse((bases.content[0] as { text: string }).text)).toEqual(bases.structuredContent);

    const d = await call(client, "describe_base", { baseId });
    const deals = d.structuredContent.tables.find((t: any) => t.name === "Deals");
    expect(deals.primaryField).toBe("Name");
    expect(deals.rowCount).toBe(30);
    const byName = (n: string) => deals.fields.find((f: any) => f.name === n);
    expect(byName("Stage").options.choices).toEqual(["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]);
    expect(byName("Company").options.linkedTable).toBe("Companies");
    expect(byName("Weighted").options.formula).toBe("ROUND({Amount} * {Probability})");
    expect(deals.views[0]).toEqual({ id: expect.any(String), name: "Grid view", type: "grid" });
  });

  it("returns a tool error for a base the user cannot see", async () => {
    const { token } = await ownerWithBase("mcp-nobase");
    const client = await mcpClient(token);
    const r = await call(client, "describe_base", { baseId: "appDoesNotExist000" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("Base not found");
  });
});

describe("MCP record queries", () => {
  it("queries with a structured filter, sort, fields and paging", async () => {
    const { token, baseId } = await ownerWithBase("mcp-query");
    const client = await mcpClient(token);
    const all = await call(client, "query_records", { baseId, table: "Deals", limit: 200 });
    expect(all.structuredContent.total).toBe(30);
    const won = all.structuredContent.records.filter((r: any) => r.fields.Stage === "Won").length;

    const r = await call(client, "query_records", { baseId, table: "deals", filter: { conditions: [{ field: "stage", op: "eq", value: "won" }] }, sort: [{ field: "Amount", direction: "desc" }], fields: ["Name", "Amount"] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.total).toBe(won);
    const amounts = r.structuredContent.records.map((x: any) => x.fields.Amount ?? -1);
    expect([...amounts].sort((a: number, b: number) => b - a)).toEqual(amounts);
    expect(r.structuredContent.records.every((x: any) => Object.keys(x.fields).every(k => k === "Name" || k === "Amount"))).toBe(true);

    const p1 = await call(client, "query_records", { baseId, table: "Deals", limit: 10 });
    expect(p1.structuredContent.records).toHaveLength(10);
    expect(p1.structuredContent.nextOffset).toBe(10);
    const p3 = await call(client, "query_records", { baseId, table: "Deals", limit: 10, offset: 20 });
    expect(p3.structuredContent.nextOffset).toBeUndefined();
  });

  it("resolves option names case-insensitively and reports unknown ones", async () => {
    const { token, baseId } = await ownerWithBase("mcp-options");
    const client = await mcpClient(token);
    const ok = await call(client, "query_records", { baseId, table: "Deals", filter: { conditions: [{ field: "Stage", op: "anyOf", value: ["won", "LOST"] }] } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent.records.every((r: any) => r.fields.Stage === "Won" || r.fields.Stage === "Lost")).toBe(true);
    const bad = await call(client, "query_records", { baseId, table: "Deals", filter: { conditions: [{ field: "Stage", op: "eq", value: "Closed" }] } });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toBe('Unknown option "Closed" for field Stage. Options: Lead, Qualified, Proposal, Negotiation, Won, Lost');
    const badField = await call(client, "query_records", { baseId, table: "Deals", filter: { conditions: [{ field: "Statu", op: "eq", value: "x" }] } });
    expect((badField.content[0] as { text: string }).text).toBe('Unknown field "Statu" in table Deals. Fields: Name, Stage, Amount, Close date, Company, Probability, Weighted');
  });

  it("filters by formula and combines view with filter", async () => {
    const { token, baseId, c } = await ownerWithBase("mcp-formula");
    const client = await mcpClient(token);
    const f = await call(client, "query_records", { baseId, table: "Deals", formula: "{Amount} > 0" });
    expect(f.isError).toBeFalsy();
    const bad = await call(client, "query_records", { baseId, table: "Deals", formula: "{Amount" });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(/^Invalid filterByFormula/);

    const schema = (await c.req("GET", `/api/bases/${baseId}`)).json.schema;
    const deals = schema.tables.find((t: any) => t.name === "Deals");
    const stage = schema.fields.find((x: any) => x.tableId === deals.id && x.name === "Stage");
    const won = stage.options.choices.find((ch: any) => ch.name === "Won").id;
    const v = await c.req("POST", `/api/bases/${baseId}/schema`, { op: "createView", tableId: deals.id, view: { name: "Won", type: "grid", config: { filters: { conjunction: "and", conditions: [{ fieldId: stage.id, op: "eq", value: won }] } } } });
    expect(v.status).toBe(200);
    const inView = await call(client, "query_records", { baseId, table: "Deals", view: "Won" });
    const narrowed = await call(client, "query_records", { baseId, table: "Deals", view: "Won", filter: { conditions: [{ field: "Amount", op: "gt", value: 1e12 }] } });
    expect(narrowed.structuredContent.total).toBe(0);
    expect(inView.structuredContent.records.every((r: any) => r.fields.Stage === "Won")).toBe(true);
  });

  it("gets records by id and truncates long text unless asked", async () => {
    const { token, baseId } = await ownerWithBase("mcp-get", "blank");
    const client = await mcpClient(token);
    const d = await call(client, "describe_base", { baseId });
    const table = d.structuredContent.tables[0].name;
    const q = await call(client, "query_records", { baseId, table, limit: 1 });
    const id = q.structuredContent.records[0].id;
    const api = new HttpClient(token);
    await api.req("PATCH", `/api/v1/${baseId}/${encodeURIComponent(table)}/${id}`, { fields: { Notes: "x".repeat(2500) } });
    const short = await call(client, "get_records", { baseId, table, ids: [id] });
    expect(short.structuredContent.records[0].fields.Notes).toMatch(/… \[truncated, 2500 chars\]$/);
    const full = await call(client, "get_records", { baseId, table, ids: [id], fullText: true });
    expect(full.structuredContent.records[0].fields.Notes).toHaveLength(2500);
  });

  it("aggregates by stage with names", async () => {
    const { token, baseId } = await ownerWithBase("mcp-agg");
    const client = await mcpClient(token);
    const r = await call(client, "aggregate", { baseId, table: "Deals", groupBy: [{ field: "Stage" }], metrics: [{ fn: "count" }, { fn: "sum", field: "Amount" }] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.total).toBe(30);
    const groups = r.structuredContent.groups;
    expect(groups.reduce((n: number, g: any) => n + g.values.count, 0)).toBe(30);
    expect(Object.keys(groups[0].values)).toEqual(["count", "sum Amount"]);
    const bad = await call(client, "aggregate", { baseId, table: "Deals", metrics: [{ fn: "sum", field: "Stage" }] });
    expect((bad.content[0] as { text: string }).text).toBe('sum needs a number field; "Stage" is singleSelect');
  });
});

describe("MCP record writes", () => {
  it("creates, updates and deletes records with typecast", async () => {
    const { token, baseId } = await ownerWithBase("mcp-write");
    const client = await mcpClient(token);
    const created = await call(client, "create_records", { baseId, table: "Deals", records: [{ fields: { Name: "MCP deal", Stage: "Brand new stage", Amount: 500, Company: ["Globex"] } }] });
    expect(created.isError).toBeFalsy();
    const rec = created.structuredContent.records[0];
    expect(rec.fields).toMatchObject({ Name: "MCP deal", Stage: "Brand new stage", Amount: 500 });
    expect(rec.fields.Company).toHaveLength(1);

    const upd = await call(client, "update_records", { baseId, table: "Deals", records: [{ id: rec.id, fields: { Amount: 750 } }] });
    expect(upd.structuredContent.records[0].fields.Amount).toBe(750);

    const del = await call(client, "delete_records", { baseId, table: "Deals", ids: [rec.id] });
    expect(del.structuredContent.deleted).toEqual([rec.id]);
    const after = await call(client, "get_records", { baseId, table: "Deals", ids: [rec.id] });
    expect(after.structuredContent.records).toEqual([]);
  });

  it("explains unknown and computed fields", async () => {
    const { token, baseId } = await ownerWithBase("mcp-write-err");
    const client = await mcpClient(token);
    const unknown = await call(client, "create_records", { baseId, table: "Deals", records: [{ fields: { Nmae: "x" } }] });
    expect((unknown.content[0] as { text: string }).text).toBe('Unknown field "Nmae" in table Deals. Fields: Name, Stage, Amount, Close date, Company, Probability, Weighted');
    const computed = await call(client, "create_records", { baseId, table: "Deals", records: [{ fields: { Weighted: 1 } }] });
    expect((computed.content[0] as { text: string }).text).toBe('Field "Weighted" cannot accept a value because the field is computed');
  });

  it("rejects writes from a viewer token as a tool error", async () => {
    const { c, wsId, baseId } = await ownerWithBase("mcp-viewer-owner");
    const viewerToken = await addViewer(c, wsId, "mcp-viewer@example.com");
    const client = await mcpClient(viewerToken);
    const read = await call(client, "query_records", { baseId, table: "Deals", limit: 1 });
    expect(read.isError).toBeFalsy();
    const r = await call(client, "create_records", { baseId, table: "Deals", records: [{ fields: { Name: "nope" } }] });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("You have read-only access to this base");
  });

  it("marks delete tools as destructive", async () => {
    const { token } = await ownerWithBase("mcp-annotations");
    const client = await mcpClient(token);
    const tools = (await client.listTools()).tools;
    expect(tools.find(t => t.name === "delete_records")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find(t => t.name === "create_records")!.annotations?.destructiveHint).toBe(false);
  });
});

describe("MCP schema tools", () => {
  it("builds a linked CRM with lookup, rollup and formula", async () => {
    const { token, baseId } = await ownerWithBase("mcp-build", "blank");
    const client = await mcpClient(token);
    const companies = await call(client, "create_table", { baseId, name: "Accounts", fields: [{ name: "Name", type: "text" }, { name: "Tier", type: "singleSelect", options: { choices: ["Gold", "Silver"] } }] });
    expect(companies.isError).toBeFalsy();
    expect(companies.structuredContent.table.fields.map((f: any) => f.name)).toEqual(["Name", "Tier"]);

    const opps = await call(client, "create_table", {
      baseId,
      name: "Opportunities",
      fields: [
        { name: "Title", type: "text" },
        { name: "Value", type: "number", options: { format: "currency", precision: 0 } },
        { name: "Account", type: "link", options: { linkedTable: "Accounts" } },
        { name: "Account tier", type: "lookup", options: { linkField: "Account", targetField: "Tier" } },
        { name: "Double value", type: "formula", options: { formula: "{Value} * 2" } },
      ],
    });
    expect(opps.isError).toBeFalsy();
    const oppFields = opps.structuredContent.table.fields;
    expect(oppFields.map((f: any) => f.name)).toEqual(["Title", "Value", "Account", "Account tier", "Double value"]);
    expect(oppFields.find((f: any) => f.name === "Double value").options.formula).toBe("{Value} * 2");

    const rollup = await call(client, "create_field", { baseId, table: "Accounts", field: { name: "Pipeline", type: "rollup", options: { linkField: "Opportunities", targetField: "Value", fn: "sum" } } });
    expect(rollup.isError).toBeFalsy();
    expect(rollup.structuredContent.field.options).toMatchObject({ linkField: "Opportunities", targetField: "Value", fn: "sum" });

    await call(client, "create_records", { baseId, table: "Accounts", records: [{ fields: { Name: "Globex", Tier: "Gold" } }] });
    await call(client, "create_records", { baseId, table: "Opportunities", records: [{ fields: { Title: "A", Value: 100, Account: ["Globex"] } }, { fields: { Title: "B", Value: 50, Account: ["Globex"] } }] });
    const acct = await call(client, "query_records", { baseId, table: "Accounts" });
    expect(acct.structuredContent.records[0].fields.Pipeline).toBe(150);
    const opp = await call(client, "query_records", { baseId, table: "Opportunities", filter: { conditions: [{ field: "Title", op: "eq", value: "A" }] } });
    expect(opp.structuredContent.records[0].fields["Account tier"]).toEqual(["Gold"]);
    expect(opp.structuredContent.records[0].fields["Double value"]).toBe(200);
  });

  it("rejects a computed or link first field", async () => {
    const { token, baseId } = await ownerWithBase("mcp-primary", "blank");
    const client = await mcpClient(token);
    const r = await call(client, "create_table", { baseId, name: "Bad", fields: [{ name: "Ref", type: "link", options: { linkedTable: "Table 1" } }] });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("The first field is the primary field and must be a plain type such as text, number or date; link, lookup, rollup and formula fields cannot come first");
  });

  it("update_field keeps existing select values", async () => {
    const { token, baseId } = await ownerWithBase("mcp-choices");
    const client = await mcpClient(token);
    const before = await call(client, "aggregate", { baseId, table: "Deals", groupBy: [{ field: "Stage" }], metrics: [{ fn: "count" }] });
    const u = await call(client, "update_field", { baseId, table: "Deals", field: "Stage", options: { choices: ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost", "On hold"] } });
    expect(u.isError).toBeFalsy();
    expect(u.structuredContent.field.options.choices).toHaveLength(7);
    const after = await call(client, "aggregate", { baseId, table: "Deals", groupBy: [{ field: "Stage" }], metrics: [{ fn: "count" }] });
    expect(after.structuredContent.groups).toEqual(before.structuredContent.groups);
  });

  it("renames, deletes and manages views", async () => {
    const { token, baseId } = await ownerWithBase("mcp-views");
    const client = await mcpClient(token);
    expect((await call(client, "update_table", { baseId, table: "Deals", name: "Opportunities" })).structuredContent.table.name).toBe("Opportunities");
    const view = await call(client, "create_view", { baseId, table: "Opportunities", name: "Board", type: "kanban", groupBy: "Stage", sort: [{ field: "Amount", direction: "desc" }], hiddenFields: ["Weighted"] });
    expect(view.structuredContent.view).toEqual({ id: expect.any(String), name: "Board", type: "kanban", settings: { groupBy: "Stage", sort: [{ field: "Amount", direction: "desc" }], hiddenFields: ["Weighted"] } });
    const filtered = await call(client, "update_view", { baseId, table: "Opportunities", view: "Board", filter: { conditions: [{ field: "Stage", op: "eq", value: "Won" }] } });
    expect(filtered.isError).toBeFalsy();
    const inView = await call(client, "query_records", { baseId, table: "Opportunities", view: "Board", limit: 200 });
    expect(inView.structuredContent.records.every((r: any) => r.fields.Stage === "Won")).toBe(true);
    const delField = await call(client, "delete_field", { baseId, table: "Opportunities", field: "Weighted" });
    expect(delField.isError).toBeFalsy();
    const delTable = await call(client, "delete_table", { baseId, table: "Contacts" });
    expect(delTable.isError).toBeFalsy();
    const d = await call(client, "describe_base", { baseId });
    expect(d.structuredContent.tables.map((t: any) => t.name)).toEqual(["Companies", "Opportunities"]);
  });

  it("creates calendar, timeline, gallery and grouped grid views", async () => {
    const { token, baseId, c } = await ownerWithBase("mcp-views2", "project-tracker");
    const client = await mcpClient(token);
    const config = async (viewId: string) => (await c.req("GET", `/api/bases/${baseId}`)).json.schema.views.find((v: any) => v.id === viewId).config;
    const fieldId = async (table: string, name: string) => {
      const s = (await c.req("GET", `/api/bases/${baseId}`)).json.schema;
      const t = s.tables.find((x: any) => x.name === table);
      return s.fields.find((f: any) => f.tableId === t.id && f.name === name).id;
    };
    const cal = await call(client, "create_view", { baseId, table: "Tasks", name: "Due calendar", type: "calendar", dateField: "Due", calendarMode: "week" });
    expect(cal.structuredContent.view.type).toBe("calendar");
    expect(await config(cal.structuredContent.view.id)).toMatchObject({ dateFieldId: await fieldId("Tasks", "Due"), calendarMode: "week" });

    const tl = await call(client, "create_view", { baseId, table: "Projects", name: "Roadmap", type: "timeline", dateField: "Start", endDateField: "Deadline", laneField: "Status", timelineScale: "month" });
    expect(await config(tl.structuredContent.view.id)).toMatchObject({ dateFieldId: await fieldId("Projects", "Start"), endDateFieldId: await fieldId("Projects", "Deadline"), laneFieldId: await fieldId("Projects", "Status"), timelineScale: "month" });

    const grid = await call(client, "create_view", { baseId, table: "Tasks", name: "By status", type: "grid", groupBy: [{ field: "Status" }, { field: "Priority", direction: "desc" }] });
    expect((await config(grid.structuredContent.view.id)).groups).toEqual([{ fieldId: await fieldId("Tasks", "Status"), dir: "asc" }, { fieldId: await fieldId("Tasks", "Priority"), dir: "desc" }]);

    const gal = await call(client, "create_view", { baseId, table: "Tasks", name: "Cards", type: "gallery" });
    expect(gal.isError).toBeFalsy();

    const bad = await call(client, "create_view", { baseId, table: "Tasks", name: "Bad", type: "calendar", dateField: "Nope" });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(/^Unknown field "Nope" in table Tasks/);
  });

  it("viewer cannot change schema", async () => {
    const { c, wsId, baseId } = await ownerWithBase("mcp-viewer-schema");
    const client = await mcpClient(await addViewer(c, wsId, "mcp-viewer-schema2@example.com"));
    const r = await call(client, "create_table", { baseId, name: "Nope" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("You have read-only access to this base");
  });
});

describe("MCP review fixes", () => {
  const text = (r: any) => (r.content[0] as { text: string }).text;

  it("rejects filter conditions the engine would ignore", async () => {
    const { token, baseId } = await ownerWithBase("mcp-fix-filter");
    const client = await mcpClient(token);
    const q = (condition: Record<string, unknown>) => call(client, "query_records", { baseId, table: "Deals", filter: { conditions: [condition] } });
    const sel = await q({ field: "Stage", op: "contains", value: "Won" });
    expect(sel.isError).toBe(true);
    expect(text(sel)).toBe('Filter op "contains" does not apply to field "Stage" (singleSelect). Use one of: eq, neq, anyOf, noneOf, empty, notempty');
    const num = await q({ field: "Amount", op: "gt", value: "abc" });
    expect(text(num)).toBe('Filter on "Amount" needs a number, got "abc"');
    const date = await q({ field: "Close date", op: "lt", value: "last week" });
    expect(text(date)).toBe('Filter on "Close date" needs a date like 2026-01-31, got "last week"');
    const link = await q({ field: "Company", op: "anyOf", value: ["Acme"] });
    expect(text(link)).toBe('Filter on link field "Company" needs record ids (numbers); use contains to match linked record names');
    const missing = await q({ field: "Name", op: "eq", value: null });
    expect(text(missing)).toBe('Filter op "eq" on "Name" needs a value; use empty or notempty to test for blanks');
    const many = await q({ field: "Stage", op: "anyOf", value: Array.from({ length: 51 }, () => "Won") });
    expect(text(many)).toBe("A filter value list can have at most 50 items");
    const linkName = await q({ field: "Company", op: "contains", value: "Globex" });
    expect(linkName.isError).toBeFalsy();
    expect(linkName.structuredContent.total).toBeGreaterThan(0);
  });

  it("renames a select option without losing cells and marks update_field destructive", async () => {
    const { token, baseId } = await ownerWithBase("mcp-fix-rename");
    const client = await mcpClient(token);
    const count = async (stage: string) => (await call(client, "aggregate", { baseId, table: "Deals", filter: { conditions: [{ field: "Stage", op: "eq", value: stage }] }, metrics: [{ fn: "count" }] })).structuredContent.total;
    const won = await count("Won");
    const u = await call(client, "update_field", { baseId, table: "Deals", field: "Stage", options: { choices: ["Lead", "Qualified", "Proposal", "Negotiation", { name: "Closed won", renameFrom: "Won" }, "Lost"] } });
    expect(u.isError).toBeFalsy();
    expect(await count("Closed won")).toBe(won);
    const tool = (await client.listTools()).tools.find(t => t.name === "update_field")!;
    expect(tool.annotations?.destructiveHint).toBe(true);
  });

  it("removes a half-built table when a later field fails", async () => {
    const { token, baseId } = await ownerWithBase("mcp-fix-rollback", "blank");
    const client = await mcpClient(token);
    const bad = await call(client, "create_table", { baseId, name: "Deals", fields: [{ name: "Name", type: "text" }, { name: "Twice", type: "formula", options: { formula: "{Nope} * 2" } }] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^Table "Deals" was not created: field "Twice" failed: /);
    const ok = await call(client, "create_table", { baseId, name: "Deals", fields: [{ name: "Name", type: "text" }] });
    expect(ok.structuredContent.table.name).toBe("Deals");
    const d = await call(client, "describe_base", { baseId });
    expect(d.structuredContent.tables.map((t: any) => t.name)).toEqual(["Table 1", "Deals"]);
  });
});

describe("MCP create_table edge cases", () => {
  it("without fields makes the default fields and no blank records", async () => {
    const { token, baseId } = await ownerWithBase("mcp-ct-empty", "blank");
    const client = await mcpClient(token);
    const r = await call(client, "create_table", { baseId, name: "Empty" });
    expect(r.structuredContent.table.rowCount).toBe(0);
  });
  it("lookup options on a plain field and a target without a link are explained", async () => {
    const { token, baseId } = await ownerWithBase("mcp-ct-opts", "blank");
    const client = await mcpClient(token);
    const a = await call(client, "create_table", { baseId, name: "A", fields: [{ name: "Name", type: "text" }, { name: "Note", type: "text", options: { linkField: "Name" } }] });
    expect(a.isError).toBe(true);
    expect(JSON.stringify(a.content)).toContain("linkField and targetField only apply to lookup and rollup fields");
    const b = await call(client, "create_table", { baseId, name: "B", fields: [{ name: "Name", type: "text" }, { name: "L", type: "lookup", options: { targetField: "Name" } }] });
    expect(b.isError).toBe(true);
    expect(JSON.stringify(b.content)).toContain("targetField needs linkField");
  });
});

describe("MCP view settings", () => {
  it("checks field types, clears settings with null and returns the settings by name", async () => {
    const { token, baseId } = await ownerWithBase("mcp-view-cfg", "crm");
    const client = await mcpClient(token);
    const bad = await call(client, "create_view", { baseId, table: "Deals", name: "Cal", type: "calendar", dateField: "Name" });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain('\\"Name\\" is not a date field');
    const lanes = await call(client, "create_view", { baseId, table: "Deals", name: "TL", type: "timeline", dateField: "Close date", laneField: "Amount" });
    expect(JSON.stringify(lanes.content)).toContain("Lanes need a single select, user or link field");
    const ok = await call(client, "create_view", { baseId, table: "Deals", name: "Cal", type: "calendar", dateField: "Close date", hiddenFields: ["Amount"] });
    expect(ok.structuredContent.view).toMatchObject({ name: "Cal", type: "calendar", settings: { dateField: "Close date", hiddenFields: ["Amount"] } });
    const cleared = await call(client, "update_view", { baseId, table: "Deals", view: "Cal", hiddenFields: null });
    expect(cleared.structuredContent.view.settings.hiddenFields).toBeUndefined();
  });
});

describe("MCP response size", () => {
  it("query_records and get_records stop before a response grows too large", async () => {
    const { c, token, baseId } = await ownerWithBase("mcp-budget", "blank");
    const schema = (await c.req("GET", `/api/bases/${baseId}`)).json.schema;
    const t = schema.tables[0];
    const notes = schema.fields.find((f: any) => f.tableId === t.id && f.type === "longText").id;
    const big = "x".repeat(60_000);
    const rows = Array.from({ length: 8 }, () => ({ cells: { [notes]: big } }));
    await c.req("POST", `/api/bases/${baseId}/rows`, { op: "create", tableId: t.id, rows });
    const client = await mcpClient(token);
    const q = await call(client, "query_records", { baseId, table: t.name, limit: 50 });
    expect(q.structuredContent.records.length).toBe(11);
    const ids = (await call(client, "query_records", { baseId, table: t.name, limit: 50, fields: ["Name"] })).structuredContent.records.map((r: any) => r.id);
    const full = await call(client, "get_records", { baseId, table: t.name, ids, fullText: true });
    expect(JSON.stringify(full.structuredContent).length).toBeLessThan(200_000);
    // The template's 3 blank records and 2 of the large ones fit.
    expect(full.structuredContent.records.length).toBe(5);
    expect(full.structuredContent.omitted.length).toBe(6);
    expect(full.structuredContent.note).toContain("too large");
  });
});
