// AI fields shared by the Durable Object, the routes, MCP and the editor: types, limits,
// prompt references, the instruction per output type, answer parsing and prompt expansion.
import type { Field, FieldType } from "./types";
import { parseDate, parseNumber } from "./cells";

export const AI_OUTPUT_TYPES = ["text", "longText", "singleSelect", "multiSelect", "number", "date", "checkbox"] as const;
export type AiOutputType = (typeof AI_OUTPUT_TYPES)[number];
export const isAiOutputType = (t: FieldType): t is AiOutputType => (AI_OUTPUT_TYPES as readonly string[]).includes(t);

export interface AiConfig {
  serviceId: string;
  model?: string;
  prompt: string;
  imageFieldIds?: string[];
  /** Missing means true. */
  autoUpdate?: boolean;
  template?: string;
}

export type AiServiceKind = "anthropic" | "openai" | "workers";

export interface AiServiceInfo {
  id: string;
  name: string;
  kind: AiServiceKind;
  model: string;
  baseUrl?: string | null;
  last4?: string | null;
  keyRejected: boolean;
  /** Calls this month. */
  calls: number;
}

export type AiCellStateName = "queued" | "running" | "error" | "edited";
export interface AiCellState {
  s: AiCellStateName;
  e?: string;
}

export interface AiProgress {
  tableId: string;
  fieldId: string;
  queued: number;
  done: number;
  total: number;
}

export const AI_LIMITS = {
  fieldsPerTable: 20,
  services: 10,
  promptChars: 8000,
  expandedChars: 32_000,
  images: 4,
  imageBytes: 5 * 1024 * 1024,
  imageFields: 2,
  concurrency: 6,
  callTimeout: 60_000,
  alarmBudget: 25_000,
  outputTokens: 8000,
  debounce: 2000,
  retryDelays: [10_000, 60_000, 300_000],
  maxRetryAfter: 300_000,
  /** Entries that cannot run now (missing service, rejected key, ended trial) look again after this. */
  pause: 600_000,
} as const;

export const WORKERS_SERVICE_ID = "workers";
export const WORKERS_TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORKERS_IMAGE_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const AI_ACTOR = { userId: "ai", name: "AI" };

/** Starting points in the field dialog; "{Field}" becomes the table's primary field. */
export const AI_TEMPLATES: { id: string; label: string; output: AiOutputType; prompt: string; choices?: string[] }[] = [
  { id: "summarize", label: "Summarize", output: "longText", prompt: "Summarize {Field} in one or two sentences." },
  { id: "translate", label: "Translate", output: "longText", prompt: "Translate {Field} into English." },
  { id: "extract", label: "Extract information", output: "text", prompt: "From {Field}, extract the company name." },
  { id: "classify", label: "Classify", output: "singleSelect", prompt: "Classify {Field} into one of the options.", choices: ["Question", "Bug", "Feature request"] },
  { id: "tag", label: "Tag", output: "multiSelect", prompt: "Pick every tag that fits {Field}.", choices: ["Pricing", "Support", "Product"] },
  { id: "sentiment", label: "Sentiment", output: "singleSelect", prompt: "What is the sentiment of {Field}?", choices: ["Positive", "Neutral", "Negative"] },
  { id: "copy", label: "Write copy", output: "longText", prompt: "Write a short, friendly product description based on {Field}." },
];

const REF = /\{([^{}\n]{1,100})\}/g;
const ID_REF = /\{(fld[A-Za-z0-9_]{3,40})\}/g;

export function promptRefIds(stored: string): string[] {
  const out: string[] = [];
  for (const m of stored.matchAll(ID_REF)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** {Field name} to {fieldId}; braces that name no field stay as they are. */
export function promptToStored(text: string, fields: { id: string; name: string }[]): string {
  return text.replace(REF, (all, inner: string) => {
    const key = inner.trim();
    const f = fields.find(x => x.name === key) ?? fields.find(x => x.name.toLowerCase() === key.toLowerCase()) ?? fields.find(x => x.id === key);
    return f ? `{${f.id}}` : all;
  });
}

export function promptToDisplay(stored: string, fields: { id: string; name: string }[]): string {
  return stored.replace(ID_REF, (all, id: string) => {
    const f = fields.find(x => x.id === id);
    return f ? `{${f.name}}` : all;
  });
}

export function aiDeps(f: Pick<Field, "options">): string[] {
  const ai = f.options.ai;
  return ai ? [...new Set([...promptRefIds(ai.prompt), ...(ai.imageFieldIds ?? [])])] : [];
}

/** Why an AI field cannot run with these fields of its table, or null. The service is checked separately. */
export function aiFieldProblem(f: Pick<Field, "options">, fields: Pick<Field, "id" | "type">[]): string | null {
  const ai = f.options.ai;
  if (!ai) return "Not an AI field";
  const byId = new Map(fields.map(x => [x.id, x]));
  if (promptRefIds(ai.prompt).some(id => !byId.has(id))) return "The prompt refers to a deleted field";
  if ((ai.imageFieldIds ?? []).some(id => byId.get(id)?.type !== "attachment")) return "An image field was deleted or changed";
  return null;
}

const names = (f: Pick<Field, "options">) => (f.options.choices ?? []).map(c => c.name).join(" | ");

export function systemInstruction(f: Pick<Field, "type" | "options">): string {
  switch (f.type) {
    case "singleSelect":
      return `Answer with exactly one of these options and nothing else: ${names(f)}`;
    case "multiSelect":
      return `Answer with zero or more of these options, separated by commas, and nothing else: ${names(f)}`;
    case "number":
      return "Answer with a single number only.";
    case "date":
      return "Answer with a single date in the form YYYY-MM-DD only.";
    case "checkbox":
      return "Answer with yes or no only.";
    default:
      return "Answer with the result only, without preamble.";
  }
}

/** Trims quotes, Markdown emphasis, code fences and a final period. */
function clean(raw: string): string {
  let s = raw.trim().replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
  for (let i = 0; i < 3; i++) s = s.replace(/\.$/, "").trim().replace(/^(\*\*|__|\*|_|"|'|`)(.*)\1$/s, "$2").trim();
  return s.replace(/\.$/, "").trim();
}

const choiceByName = (f: Pick<Field, "options">, name: string) => {
  const n = name.trim().toLowerCase();
  return (f.options.choices ?? []).find(c => c.name.toLowerCase() === n);
};

export function parseAnswer(f: Pick<Field, "type" | "options">, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const bad = (what: string) => ({ ok: false as const, error: `The answer "${raw.trim().slice(0, 200)}" is not ${what}` });
  switch (f.type) {
    case "text":
      return { ok: true, value: clean(raw).split(/\r?\n/)[0].trim() || null };
    case "longText": {
      const s = raw.trim().replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
      return { ok: true, value: s || null };
    }
    case "singleSelect": {
      const c = choiceByName(f, clean(raw));
      return c ? { ok: true, value: c.id } : bad("one of the options");
    }
    case "multiSelect": {
      const s = clean(raw);
      if (!s || /^(none|nothing|n\/a)$/i.test(s)) return { ok: true, value: null };
      const ids: string[] = [];
      for (const part of s.split(/[,;\n]/).map(clean).filter(Boolean)) {
        const c = choiceByName(f, part);
        if (!c) return bad("one of the options");
        if (!ids.includes(c.id)) ids.push(c.id);
      }
      return { ok: true, value: ids };
    }
    case "number": {
      const m = /-?\d[\d,]*(\.\d+)?|-?\.\d+/.exec(clean(raw));
      const n = m ? parseNumber(m[0].replace(/,/g, "")) : null;
      return n === null ? bad("a number") : { ok: true, value: n };
    }
    case "date": {
      const s = clean(raw);
      const iso = /\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/.exec(s)?.[0];
      const d = parseDate(iso ?? s, !!f.options.includeTime);
      return d ? { ok: true, value: d } : bad("a date");
    }
    case "checkbox": {
      const s = clean(raw).toLowerCase();
      if (/^(yes|true|1|y)$/.test(s)) return { ok: true, value: true };
      if (/^(no|false|0|n)$/.test(s)) return { ok: true, value: null };
      return bad("yes or no");
    }
    default:
      return { ok: false, error: "This field type cannot hold AI answers" };
  }
}

export function expandPrompt(stored: string, text: (fieldId: string) => string | null): { text: string; cut: boolean } {
  const out = stored.replace(ID_REF, (all, id: string) => text(id) ?? all);
  return out.length > AI_LIMITS.expandedChars ? { text: out.slice(0, AI_LIMITS.expandedChars), cut: true } : { text: out, cut: false };
}

export async function inputHash(v: unknown): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Shape checks for options.ai; references are checked against the schema by the store. */
export function normalizeAi(raw: unknown): AiConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid AI settings");
  const o = raw as Record<string, unknown>;
  const serviceId = typeof o.serviceId === "string" ? o.serviceId.trim() : "";
  if (!serviceId) throw new Error("Choose an AI service");
  const prompt = typeof o.prompt === "string" ? o.prompt : "";
  if (!prompt.trim()) throw new Error("Write a prompt");
  if (prompt.length > AI_LIMITS.promptChars) throw new Error("A prompt can have at most 8,000 characters");
  const out: AiConfig = { serviceId, prompt, autoUpdate: o.autoUpdate !== false };
  if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim().slice(0, 200);
  if (o.imageFieldIds !== undefined) {
    if (!Array.isArray(o.imageFieldIds) || o.imageFieldIds.some(x => typeof x !== "string")) throw new Error("Invalid image fields");
    if (o.imageFieldIds.length > AI_LIMITS.imageFields) throw new Error("Choose at most 2 image fields");
    if (o.imageFieldIds.length) out.imageFieldIds = [...new Set(o.imageFieldIds as string[])];
  }
  if (typeof o.template === "string" && o.template) out.template = o.template.slice(0, 40);
  return out;
}
