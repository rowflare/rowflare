import { describe, expect, it } from "vitest";
import type { Field } from "../../src/shared/types";
import { flatSteps, nextStepId, parseHm, validateAutomation, type AutomationConfig, type Step } from "../../src/shared/automations";

const fld = (id: string, name: string, type: Field["type"], tableId = "tblA", options: Field["options"] = {}): Field => ({ id, tableId, name, type, options, ord: "a" });
const schema = {
  tables: [{ id: "tblA", name: "Deals" }, { id: "tblB", name: "Tasks" }],
  fields: [
    fld("fldName", "Name", "text"),
    fld("fldStage", "Stage", "singleSelect", "tblA", { choices: [{ id: "chWon", name: "Won", color: "#eee" }] }),
    fld("fldDue", "Due", "date"),
    fld("fldCalc", "Calc", "formula"),
    fld("fldTask", "Task", "text", "tblB"),
  ],
};
const hook = { type: "webhook" as const, token: "a".repeat(32) };
const cfg = (trigger: AutomationConfig["trigger"], steps: Step[] = []): AutomationConfig => ({ trigger, steps });
const http: Step = { id: "s1", type: "http", method: "POST", url: "https://example.com/hook", headers: [] };

describe("automation validation", () => {
  it("checks AI steps", () => {
    const base = { trigger: { type: "webhook", token: "a".repeat(32) }, steps: [] } as any;
    expect(validateAutomation({ ...base, steps: [{ id: "s1", type: "ai", serviceId: "", prompt: "x", output: "text" }] }, schema)).toBe("Choose an AI service");
    expect(validateAutomation({ ...base, steps: [{ id: "s1", type: "ai", serviceId: "a", prompt: "", output: "text" }] }, schema)).toBe("Write a prompt");
    expect(validateAutomation({ ...base, steps: [{ id: "s1", type: "ai", serviceId: "a", prompt: "x", output: "xml" }] }, schema)).toBe("Choose text or JSON output");
  });
  it("accepts a record trigger with an HTTP step", () => {
    expect(validateAutomation(cfg({ type: "recordUpdated", tableId: "tblA", fieldIds: ["fldStage"] }, [http]), schema)).toBeNull();
  });

  it("rejects an unknown table", () => {
    expect(validateAutomation(cfg({ type: "recordCreated", tableId: "tblX" }), schema)).toBe("Unknown table tblX");
  });

  it("rejects conditions on another table's field", () => {
    const t = { type: "recordMatches" as const, tableId: "tblA", conditions: { conjunction: "and" as const, conditions: [{ fieldId: "fldTask", op: "eq" as const, value: "x" }] } };
    expect(validateAutomation(cfg(t), schema)).toBe("Unknown field fldTask in the trigger conditions");
  });

  it("needs a condition for recordMatches", () => {
    expect(validateAutomation(cfg({ type: "recordMatches", tableId: "tblA", conditions: { conjunction: "and", conditions: [] } }), schema)).toBe("Add at least one condition");
  });

  it("rejects a bad schedule time and time zone", () => {
    expect(validateAutomation(cfg({ type: "schedule", every: "day", at: "24:00", tz: "UTC" }), schema)).toBe("Times look like 09:30");
    expect(validateAutomation(cfg({ type: "schedule", every: "day", at: "09:00", tz: "Mars/Base" }), schema)).toBe("Unknown time zone Mars/Base");
    expect(validateAutomation(cfg({ type: "schedule", every: "week", at: "09:00", tz: "UTC" }), schema)).toBe("Choose a weekday");
  });

  it("dateReached needs a date field of the table", () => {
    expect(validateAutomation(cfg({ type: "dateReached", tableId: "tblA", fieldId: "fldName", offsetMinutes: 0, tz: "UTC" }), schema)).toBe("Choose a date field");
    expect(validateAutomation(cfg({ type: "dateReached", tableId: "tblA", fieldId: "fldDue", offsetMinutes: -1440, at: "09:00", tz: "UTC" }), schema)).toBeNull();
  });

  it("rejects writes to computed fields", () => {
    const step: Step = { id: "s1", type: "createRecord", tableId: "tblA", values: { fldCalc: "x" } };
    expect(validateAutomation(cfg(hook, [step]), schema)).toBe("The field Calc cannot be written");
  });

  it("updateRecords on the trigger record needs a trigger with a record of the same table", () => {
    const step: Step = { id: "s1", type: "updateRecords", target: "trigger", tableId: "tblA", values: { fldName: "x" } };
    expect(validateAutomation(cfg({ type: "recordCreated", tableId: "tblA" }, [step]), schema)).toBeNull();
    expect(validateAutomation(cfg(hook, [step]), schema)).toBe("This trigger has no record to update");
    expect(validateAutomation(cfg({ type: "recordCreated", tableId: "tblB" }, [step]), schema)).toBe("The table must be the trigger's table");
  });

  it("updateRecords on a step needs an earlier find or create step of the same table", () => {
    const find: Step = { id: "f1", type: "findRecords", tableId: "tblB", limit: 10 };
    const upd: Step = { id: "u1", type: "updateRecords", target: "f1", tableId: "tblB", values: { fldTask: "done" } };
    expect(validateAutomation(cfg(hook, [find, upd]), schema)).toBeNull();
    expect(validateAutomation(cfg(hook, [upd, find]), schema)).toBe("Update records must target the trigger record or an earlier find or create step of the same table");
  });

  it("allows one level of branches", () => {
    const branch: Step = { id: "b1", type: "branch", match: "all", conditions: [{ left: "{{now}}", op: "notempty" }], then: [http], else: [] };
    expect(validateAutomation(cfg(hook, [branch]), schema)).toBeNull();
    const nested = { ...branch, id: "b0", then: [{ ...branch, then: [] }] } as Step;
    expect(validateAutomation(cfg(hook, [nested]), schema)).toBe("A branch cannot contain another branch");
  });

  it("limits steps and requires unique step ids", () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ ...http, id: "s" + i }));
    expect(validateAutomation(cfg(hook, many), schema)).toBe("An automation has at most 25 steps");
    expect(validateAutomation(cfg(hook, [http, http]), schema)).toBe("Step ids must be unique");
  });

  it("limits the size of a definition", () => {
    const big: Step = { ...http, body: "x".repeat(100_001) } as Step;
    expect(validateAutomation(cfg(hook, [big]), schema)).toBe("An automation is limited to 100 KB");
  });
});

describe("automation helpers", () => {
  it("flattens branches in run order", () => {
    const b: Step = { id: "b1", type: "branch", match: "any", conditions: [], then: [{ ...http, id: "t1" }], else: [{ ...http, id: "e1" }] };
    expect(flatSteps([b, { ...http, id: "z" }]).map(s => s.id)).toEqual(["b1", "t1", "e1", "z"]);
  });

  it("numbers new steps after the highest existing one", () => {
    expect(nextStepId([])).toBe("s1");
    const b: Step = { id: "s2", type: "branch", match: "any", conditions: [], then: [{ ...http, id: "s7" }], else: [] };
    expect(nextStepId([http, b])).toBe("s8");
  });

  it("parses times", () => {
    expect(parseHm("09:05")).toEqual([9, 5]);
    expect(parseHm("9:05")).toBeNull();
  });
});
