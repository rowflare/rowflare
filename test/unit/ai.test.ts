import { describe, expect, it } from "vitest";
import { aiFieldProblem, expandPrompt, inputHash, normalizeAi, parseAnswer, promptRefIds, promptToDisplay, promptToStored, systemInstruction } from "../../src/shared/ai";
import type { Field } from "../../src/shared/types";

const fields = [{ id: "fldName0000000001", name: "Name" }, { id: "fldNotes000000001", name: "Notes" }];
const sel = (type: "singleSelect" | "multiSelect"): Pick<Field, "type" | "options"> => ({ type, options: { choices: [{ id: "c1", name: "Urgent", color: "" }, { id: "c2", name: "Later", color: "" }] } });

describe("prompt references", () => {
  it("stores names as ids and shows them back", () => {
    const stored = promptToStored("Summarize {Name}: {notes}", fields);
    expect(stored).toBe("Summarize {fldName0000000001}: {fldNotes000000001}");
    expect(promptRefIds(stored)).toEqual(["fldName0000000001", "fldNotes000000001"]);
    expect(promptToDisplay(stored, fields)).toBe("Summarize {Name}: {Notes}");
  });
  it("braces that are not field names stay text", () => {
    const text = 'Return JSON like {"a": 1} for {Name}';
    const stored = promptToStored(text, fields);
    expect(stored).toBe('Return JSON like {"a": 1} for {fldName0000000001}');
    expect(promptRefIds(stored)).toEqual(["fldName0000000001"]);
  });
  it("keeps ids of deleted fields so the field shows as broken", () => {
    expect(promptToDisplay("{fldGone0000000001} x", fields)).toBe("{fldGone0000000001} x");
    expect(promptRefIds("{fldGone0000000001}")).toEqual(["fldGone0000000001"]);
  });
});

describe("expandPrompt", () => {
  it("inserts display text and cuts at 32,000 characters", () => {
    expect(expandPrompt("Hi {fldName0000000001}!", id => (id === "fldName0000000001" ? "Ada" : null))).toEqual({ text: "Hi Ada!", cut: false });
    const long = expandPrompt("{fldName0000000001}", () => "x".repeat(40_000));
    expect(long.text.length).toBe(32_000);
    expect(long.cut).toBe(true);
  });
});

describe("parseAnswer", () => {
  it("text keeps one line, long text keeps all", () => {
    expect(parseAnswer({ type: "text", options: {} }, '  "Hello\nworld."  ')).toEqual({ ok: true, value: "Hello" });
    expect(parseAnswer({ type: "longText", options: {} }, "Line 1\nLine 2")).toEqual({ ok: true, value: "Line 1\nLine 2" });
  });
  it("matches choices case-insensitively and rejects others", () => {
    expect(parseAnswer(sel("singleSelect"), "**urgent**.")).toEqual({ ok: true, value: "c1" });
    expect(parseAnswer(sel("singleSelect"), "Soon")).toEqual({ ok: false, error: 'The answer "Soon" is not one of the options' });
    expect(parseAnswer(sel("multiSelect"), "Urgent, later")).toEqual({ ok: true, value: ["c1", "c2"] });
    expect(parseAnswer(sel("multiSelect"), "none")).toEqual({ ok: true, value: null });
  });
  it("numbers, dates and checkboxes", () => {
    expect(parseAnswer({ type: "number", options: {} }, "About 1,234.5 dollars")).toEqual({ ok: true, value: 1234.5 });
    expect(parseAnswer({ type: "number", options: {} }, "unknown").ok).toBe(false);
    expect(parseAnswer({ type: "date", options: {} }, "It is 2026-03-04.")).toEqual({ ok: true, value: "2026-03-04" });
    expect(parseAnswer({ type: "checkbox", options: {} }, "Yes")).toEqual({ ok: true, value: true });
    expect(parseAnswer({ type: "checkbox", options: {} }, "no")).toEqual({ ok: true, value: null });
    expect(parseAnswer({ type: "checkbox", options: {} }, "maybe").ok).toBe(false);
  });
});

describe("systemInstruction", () => {
  it("lists the options for selects", () => {
    expect(systemInstruction(sel("singleSelect"))).toBe("Answer with exactly one of these options and nothing else: Urgent | Later");
    expect(systemInstruction({ type: "number", options: {} })).toBe("Answer with a single number only.");
  });
});

describe("normalizeAi", () => {
  it("fills defaults and rejects bad shapes", () => {
    expect(normalizeAi({ serviceId: "ais1", prompt: "Hi" })).toEqual({ serviceId: "ais1", prompt: "Hi", autoUpdate: true });
    expect(normalizeAi(undefined)).toBeUndefined();
    expect(() => normalizeAi({ serviceId: "", prompt: "x" })).toThrow("Choose an AI service");
    expect(() => normalizeAi({ serviceId: "a", prompt: "" })).toThrow("Write a prompt");
    expect(() => normalizeAi({ serviceId: "a", prompt: "x".repeat(8001) })).toThrow("at most 8,000");
    expect(() => normalizeAi({ serviceId: "a", prompt: "x", imageFieldIds: ["a", "b", "c"] })).toThrow("at most 2");
  });
});

describe("inputHash", () => {
  it("is stable for equal input", async () => {
    expect(await inputHash({ a: 1 })).toBe(await inputHash({ a: 1 }));
    expect(await inputHash({ a: 1 })).not.toBe(await inputHash({ a: 2 }));
  });
});

describe("aiFieldProblem", () => {
  const f = (prompt: string, imageFieldIds?: string[]) => ({ options: { ai: { serviceId: "a", prompt, imageFieldIds } } });
  const fields = [{ id: "fldName0000000001", type: "text" as const }, { id: "fldPhoto000000001", type: "attachment" as const }];
  it("names deleted references and wrong image fields", () => {
    expect(aiFieldProblem(f("{fldName0000000001}"), fields)).toBeNull();
    expect(aiFieldProblem(f("{fldGone0000000001}"), fields)).toBe("The prompt refers to a deleted field");
    expect(aiFieldProblem(f("x", ["fldName0000000001"]), fields)).toBe("An image field was deleted or changed");
    expect(aiFieldProblem(f("x", ["fldPhoto000000001"]), fields)).toBeNull();
  });
});
