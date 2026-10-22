import { describe, expect, it } from "vitest";
import type { Field, Row } from "../../src/shared/types";
import { fromDisplay, parseTemplate, renderText, renderValue, templateProblem, toDisplay, type TemplateContext, type TemplateEnv } from "../../src/shared/template";

const fld = (id: string, name: string, type: Field["type"], tableId = "tblA", options: Field["options"] = {}): Field => ({ id, tableId, name, type, options, ord: "a" });
const fields = [
  fld("fldName", "Name", "text"),
  fld("fldStage", "Stage", "singleSelect", "tblA", { choices: [{ id: "chWon", name: "Won", color: "#eee" }] }),
  fld("fldAmount", "Amount", "number"),
  fld("fldTags", "Tags", "multiSelect", "tblA", { choices: [{ id: "t1", name: "x", color: "#eee" }, { id: "t2", name: "y", color: "#eee" }] }),
  fld("fldDue", "Due date", "date"),
  fld("fldOwner", "Owner", "user"),
  fld("fldTasks", "Tasks", "link", "tblA", { linkedTableId: "tblB" }),
  fld("fldTask", "Task", "text", "tblB"),
];
const row = (id: number, cells: Row["cells"]): Row => ({ id, ord: "a", createdAt: 0, updatedAt: 0, createdBy: null, updatedBy: null, cells });
const deal = row(7, { fldName: "Acme", fldStage: "chWon", fldAmount: 1200, fldTags: ["t1", "t2"], fldDue: "2026-10-20", fldOwner: "usr1", fldTasks: [{ id: 3, t: "Call" }] });
const tasks = [row(3, { fldTask: "Call" }), row(4, { fldTask: "Send quote" })];
const env: TemplateEnv = {
  field: id => fields.find(f => f.id === id),
  table: id => ({ id, primaryFieldId: id === "tblA" ? "fldName" : "fldTask" }),
  rows: (tableId, ids) => (tableId === "tblB" ? tasks.filter(r => ids.includes(r.id)) : ids.includes(7) ? [deal] : []),
  userName: id => (id === "usr1" ? "Ada" : id),
};
const ctx: TemplateContext = {
  trigger: { record: { tableId: "tblA", row: deal }, body: { email: "a@b.co", items: [{ sku: "X1" }] } },
  steps: { s1: { records: { tableId: "tblB", ids: [3, 4] }, count: 2 }, s2: { status: 201, body: { ok: true } } },
  now: Date.UTC(2026, 9, 13, 9, 30),
  automationName: "Won deals",
  baseUrl: "https://app.test/base/appX",
};

describe("templates", () => {
  it("AI step outputs", () => {
    const c = { trigger: {}, steps: { s1: { text: "Hi", json: { a: { b: 2 } } } }, now: 0, automationName: "A", baseUrl: "" } as any;
    expect(renderText("{{steps.s1.text}} {{steps.s1.json.a.b}}", c, env)).toBe("Hi 2");
  });
  it("splits text and references", () => {
    expect(parseTemplate("Hi {{trigger.record.fldName}}!")).toEqual([{ text: "Hi " }, { path: ["trigger", "record", "fldName"] }, { text: "!" }]);
  });

  it("renders record fields as display text", () => {
    expect(renderText("{{trigger.record.fldName}} is {{trigger.record.fldStage}} at {{trigger.record.fldAmount}} by {{trigger.record.fldOwner}}", ctx, env)).toBe("Acme is Won at 1200 by Ada");
  });

  it("joins multiple values and renders missing values as empty text", () => {
    expect(renderText("[{{trigger.record.fldTags}}] [{{trigger.record.fldNope}}] [{{steps.s9.count}}]", ctx, env)).toBe("[x, y] [] []");
  });

  it("renders dates as ISO and now as an ISO timestamp", () => {
    expect(renderText("{{trigger.record.fldDue}} {{now}}", ctx, env)).toBe("2026-10-20 2026-10-13T09:30:00.000Z");
  });

  it("reads webhook bodies and step outputs by path", () => {
    expect(renderText("{{trigger.body.email}} {{trigger.body.items[0].sku}} {{steps.s2.status}} {{steps.s2.body}}", ctx, env)).toBe('a@b.co X1 201 {"ok":true}');
  });

  it("reads found records, by index or all of them", () => {
    expect(renderText("{{steps.s1.records[1].fldTask}} | {{steps.s1.records.fldTask}} | {{steps.s1.count}}", ctx, env)).toBe("Send quote | Call, Send quote | 2");
  });

  it("keeps the type of a template that is a single reference", () => {
    expect(renderValue("{{trigger.record.fldAmount}}", ctx, env)).toBe(1200);
    expect(renderValue(" {{trigger.record.fldTags}} ", ctx, env)).toEqual(["x", "y"]);
    expect(renderValue("{{trigger.record}}", ctx, env)).toEqual([{ id: 7 }]);
    expect(renderValue("{{steps.s1.records}}", ctx, env)).toEqual([{ id: 3 }, { id: 4 }]);
    expect(renderValue("Total {{trigger.record.fldAmount}}", ctx, env)).toBe("Total 1200");
  });

  it("writes plain numbers for HTTP requests and formatted ones elsewhere", () => {
    const money = { ...env, field: (id: string) => (id === "fldAmount" ? fld("fldAmount", "Amount", "number", "tblA", { format: "currency", symbol: "$" }) : env.field(id)) };
    expect(renderText("{{trigger.record.fldAmount}}", ctx, money)).toMatch(/^\$1,?200$/);
    expect(renderText('{"amount": {{trigger.record.fldAmount}}}', ctx, money, undefined, { plainNumbers: true })).toBe('{"amount": 1200}');
  });

  it("escapes values inside JSON strings and keeps whole values outside them", () => {
    const c = { ...ctx, trigger: { body: { note: 'say "hi"\nnow', obj: { a: 1 }, path: "a b/c&d", url: "https://x.test/cb?a=1" } } };
    const json = { plainNumbers: true, json: true };
    expect(renderText('{"note": "{{trigger.body.note}}", "obj": {{trigger.body.obj}}}', c, env, undefined, json)).toBe('{"note": "say \\"hi\\"\\nnow", "obj": {"a":1}}');
    expect(JSON.parse(renderText('{"note": "{{trigger.body.note}}"}', c, env, undefined, json))).toEqual({ note: 'say "hi"\nnow' });
    expect(renderText('{"q": "a \\" {{trigger.body.path}}"}', c, env, undefined, json)).toBe('{"q": "a \\" a b/c&d"}');
  });

  it("encodes values placed after the host of a URL and keeps a whole URL as it is", () => {
    const c = { ...ctx, trigger: { body: { path: "a b/c&d", url: "https://x.test/cb?a=1" } } };
    expect(renderText("https://api.test/items/{{trigger.body.path}}?q={{trigger.body.path}}", c, env, undefined, { url: true })).toBe("https://api.test/items/a%20b%2Fc%26d?q=a%20b%2Fc%26d");
    expect(renderText("{{trigger.body.url}}", c, env, undefined, { url: true })).toBe("https://x.test/cb?a=1");
  });

  it("links back to the trigger record", () => {
    expect(renderText("{{record.url}}", ctx, env)).toBe("https://app.test/base/appX/tblA?record=7");
  });

  it("escapes inserted values only", () => {
    const html = (s: string) => s.replace(/</g, "&lt;");
    expect(renderText("<b>{{trigger.body.email}}</b>", { ...ctx, trigger: { body: { email: "<x>" } } }, env, html)).toBe("<b>&lt;x></b>");
  });

  it("shows field names in the editor and stores ids", () => {
    const names = { fields, triggerTableId: "tblA", stepTableId: (id: string) => (id === "s1" ? "tblB" : undefined) };
    const stored = "{{trigger.record.fldStage}} {{steps.s1.records[0].fldTask}} {{now}}";
    const shown = toDisplay(stored, names);
    expect(shown).toBe("{{trigger.record.Stage}} {{steps.s1.records[0].Task}} {{now}}");
    expect(fromDisplay(shown, names)).toBe(stored);
    expect(fromDisplay("{{trigger.record.Due date}} {{trigger.record.stage}}", names)).toBe("{{trigger.record.fldDue}} {{trigger.record.fldStage}}");
  });
});

describe("template references", () => {
  const schema = { tables: [{ id: "tblA", name: "Deals" }, { id: "tblB", name: "Tasks" }], fields };
  const http = (url: string) => ({ id: "h1", type: "http" as const, method: "POST" as const, url, headers: [] as [string, string][] });

  it("accepts known references", () => {
    expect(templateProblem({ trigger: { type: "recordCreated", tableId: "tblA" }, steps: [http("https://x.test/{{trigger.record.fldName}}?t={{now}}&u={{record.url}}")] }, schema)).toBeNull();
  });

  it("rejects fields of another table, later steps and bodies outside webhooks", () => {
    expect(templateProblem({ trigger: { type: "recordCreated", tableId: "tblA" }, steps: [http("{{trigger.record.fldTask}}")] }, schema)).toBe("Unknown reference {{trigger.record.fldTask}}");
    expect(templateProblem({ trigger: { type: "recordCreated", tableId: "tblA" }, steps: [http("{{steps.f1.count}}"), { id: "f1", type: "findRecords", tableId: "tblB", limit: 5 }] }, schema)).toBe("Unknown reference {{steps.f1.count}}");
    expect(templateProblem({ trigger: { type: "schedule", every: "day", at: "09:00", tz: "UTC" }, steps: [http("{{trigger.body.x}}")] }, schema)).toBe("Unknown reference {{trigger.body.x}}");
  });
});
