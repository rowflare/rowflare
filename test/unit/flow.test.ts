import { describe, expect, it } from "vitest";
import type { Field } from "../../src/shared/types";
import type { AutomationConfig, Step } from "../../src/shared/automations";
import { defaultStep, insertStep, moveStep, offsetText, PRESETS, removeStep, replaceStep, scheduleText, toDisplayConfig, toStoredConfig, triggerSummary, variablesFor } from "../../src/web/auto/flow";
import { validateAutomation } from "../../src/shared/automations";
import { templateProblem } from "../../src/shared/template";

const fld = (id: string, name: string, type: Field["type"], tableId = "tblA", options: Field["options"] = {}): Field => ({ id, tableId, name, type, options, ord: "a" });
const s = {
  tables: [{ id: "tblA", name: "Deals", primaryFieldId: "fldName" }, { id: "tblB", name: "Tasks", primaryFieldId: "fldTask" }],
  fields: [
    fld("fldName", "Name", "text"),
    fld("fldStage", "Stage", "singleSelect", "tblA", { choices: [{ id: "chOpen", name: "Open", color: "#eee" }, { id: "chWon", name: "Won", color: "#eee" }] }),
    fld("fldDue", "Due date", "date"),
    fld("fldTask", "Task", "text", "tblB"),
  ],
};
const http = (id: string): Step => ({ id, type: "http", method: "POST", url: "", headers: [] });
const branch: Step = { id: "s2", type: "branch", match: "all", conditions: [{ left: "", op: "notempty" }], then: [http("s3")], else: [] };

describe("step tree", () => {
  it("inserts at the top level and inside branch sides", () => {
    let steps = insertStep([], { index: 0 }, http("s1"));
    steps = insertStep(steps, { index: 1 }, branch);
    steps = insertStep(steps, { parentId: "s2", side: "else", index: 0 }, http("s4"));
    expect(steps.map(x => x.id)).toEqual(["s1", "s2"]);
    expect((steps[1] as Extract<Step, { type: "branch" }>).else.map(x => x.id)).toEqual(["s4"]);
  });

  it("removes, replaces and moves steps wherever they are", () => {
    const steps = [http("s1"), branch, http("s5")];
    expect(removeStep(steps, "s3")[1]).toMatchObject({ then: [] });
    expect(replaceStep(steps, "s3", { ...http("s3"), url: "x" } as Step)[1]).toMatchObject({ then: [{ url: "x" }] });
    expect(moveStep(steps, "s5", -1).map(x => x.id)).toEqual(["s1", "s5", "s2"]);
    expect(moveStep(steps, "s1", -1).map(x => x.id)).toEqual(["s1", "s2", "s5"]);
  });

  it("numbers new steps and points updates at the trigger record when there is one", () => {
    const cfg: AutomationConfig = { trigger: { type: "recordCreated", tableId: "tblA" }, steps: [http("s1"), branch] };
    expect(defaultStep("updateRecords", cfg.steps, cfg.trigger, s)).toEqual({ id: "s4", type: "updateRecords", target: "trigger", tableId: "tblA", values: {} });
    const hook: AutomationConfig = { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "findRecords", tableId: "tblB", limit: 5 }] };
    expect(defaultStep("updateRecords", hook.steps, hook.trigger, s)).toMatchObject({ id: "s2", target: "s1", tableId: "tblB" });
  });
});

describe("variables", () => {
  it("offers the trigger record, earlier steps and general values, by field name", () => {
    const cfg: AutomationConfig = { trigger: { type: "recordCreated", tableId: "tblA" }, steps: [{ id: "s1", type: "findRecords", tableId: "tblB", limit: 5 }, http("s2"), http("s3")] };
    const t = variablesFor(cfg, "s3", s).map(v => v.template);
    expect(t).toEqual(expect.arrayContaining(["{{trigger.record}}", "{{trigger.record.Stage}}", "{{record.url}}", "{{steps.s1.records[0].Task}}", "{{steps.s1.count}}", "{{steps.s2.status}}", "{{now}}"]));
    expect(t).not.toContain("{{steps.s3.status}}");
    expect(variablesFor({ trigger: { type: "webhook", token: "" }, steps: [] }, null, s).map(v => v.template)).toContain("{{trigger.body.email}}");
    const ai = { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "ai", serviceId: "a", prompt: "x", output: "text" }, { id: "s2", type: "ai", serviceId: "a", prompt: "x", output: "json" }] } as AutomationConfig;
    const aiVars = variablesFor(ai, null, s).map(v => v.template);
    expect(aiVars).toContain("{{steps.s1.text}}");
    expect(aiVars).toContain("{{steps.s2.json.name}}");
  });
});

describe("template names", () => {
  it("shows names while editing and stores ids", () => {
    const stored: AutomationConfig = {
      trigger: { type: "recordCreated", tableId: "tblA" },
      steps: [
        { id: "s1", type: "findRecords", tableId: "tblB", conditions: { conjunction: "and", conditions: [{ fieldId: "fldTask", op: "eq", value: "{{trigger.record.fldName}}" }] }, limit: 5 },
        { id: "s2", type: "http", method: "POST", url: "https://x.test/{{trigger.record.fldStage}}", headers: [["X-Task", "{{steps.s1.records[0].fldTask}}"]] },
      ],
    };
    const shown = toDisplayConfig(stored, s.fields);
    expect((shown.steps[1] as Extract<Step, { type: "http" }>).url).toBe("https://x.test/{{trigger.record.Stage}}");
    expect((shown.steps[1] as Extract<Step, { type: "http" }>).headers[0][1]).toBe("{{steps.s1.records[0].Task}}");
    expect((shown.steps[0] as Extract<Step, { type: "findRecords" }>).conditions!.conditions[0].value).toBe("{{trigger.record.Name}}");
    expect(toStoredConfig(shown, s.fields)).toEqual(stored);
  });
});

describe("summaries and presets", () => {
  it("describes triggers and schedules", () => {
    expect(triggerSummary({ type: "recordUpdated", tableId: "tblA", fieldIds: ["fldStage"] }, s)).toBe("A record in Deals changes: Stage");
    expect(scheduleText({ type: "schedule", every: "week", weekday: 1, at: "09:00", tz: "Asia/Shanghai" })).toBe("Every Monday at 09:00 (Asia/Shanghai)");
    expect(offsetText(-1440)).toBe("1 day before");
    expect(offsetText(90)).toBe("90 minutes after");
    expect(triggerSummary({ type: "dateReached", tableId: "tblA", fieldId: "fldDue", offsetMinutes: -1440, tz: "UTC" }, s)).toBe("1 day before Due date in Deals");
  });

  it("builds presets that pass validation once stored", () => {
    for (const p of PRESETS) {
      const cfg = p.build(s, "UTC");
      expect(cfg, p.id).not.toBeNull();
      const stored = toStoredConfig(cfg!, s.fields);
      const withToken = stored.trigger.type === "webhook" ? { ...stored, trigger: { type: "webhook" as const, token: "a".repeat(32) } } : stored;
      expect(validateAutomation(withToken, s) ?? templateProblem(withToken, s), p.id).toBeNull();
    }
  });
});
