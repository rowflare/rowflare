// Automation definitions shared by the Durable Object, the MCP tools and the editor: types, limits and validation.
import type { Field, FilterSpec, SortSpec, Table } from "./types";
import { COMPUTED_TYPES } from "./types";

export const TRIGGER_TYPES = ["recordCreated", "recordUpdated", "recordMatches", "schedule", "dateReached", "webhook", "button"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const STEP_TYPES = ["createRecord", "updateRecords", "findRecords", "http", "email", "branch", "ai"] as const;
export type StepType = (typeof STEP_TYPES)[number];
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const MAIL_PROVIDERS = ["system", "resend", "smtp"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];
export const BRANCH_OPS = ["eq", "neq", "contains", "ncontains", "empty", "notempty", "gt", "gte", "lt", "lte"] as const;
export type BranchOp = (typeof BRANCH_OPS)[number];

/** Text with {{...}} references; see template.ts. */
export type Template = string;

export interface ScheduleTrigger {
  type: "schedule";
  every: "hour" | "day" | "week" | "month";
  /** Hours between runs for `hour`, counted from local midnight (1 to 24). */
  interval?: number;
  /** Local time "HH:MM"; for `hour` only the minutes are used. */
  at: string;
  /** 0 is Sunday. */
  weekday?: number;
  monthday?: number;
  tz: string;
}

export interface DateTrigger {
  type: "dateReached";
  tableId: string;
  fieldId: string;
  offsetMinutes: number;
  /** Local time for date-only cells; 09:00 when missing. */
  at?: string;
  tz: string;
  conditions?: FilterSpec;
}

export type Trigger =
  | { type: "recordCreated"; tableId: string; conditions?: FilterSpec }
  | { type: "recordUpdated"; tableId: string; fieldIds?: string[]; conditions?: FilterSpec }
  | { type: "recordMatches"; tableId: string; conditions: FilterSpec }
  | ScheduleTrigger
  | DateTrigger
  | { type: "webhook"; token: string }
  | { type: "button"; tableId: string; viewerCanRun: boolean };

export interface BranchCondition {
  left: Template;
  op: BranchOp;
  right?: Template;
}

export type Step =
  | { id: string; type: "createRecord"; tableId: string; values: Record<string, Template> }
  | { id: string; type: "updateRecords"; target: string; tableId: string; values: Record<string, Template> }
  | { id: string; type: "findRecords"; tableId: string; conditions?: FilterSpec; sort?: SortSpec[]; limit: number }
  | { id: string; type: "http"; method: HttpMethod; url: Template; headers: [string, Template][]; body?: Template }
  | { id: string; type: "email"; provider: MailProvider; to: Template; cc?: Template; subject: Template; body: Template; format: "text" | "html" }
  | { id: string; type: "branch"; match: "all" | "any"; conditions: BranchCondition[]; then: Step[]; else: Step[] }
  | { id: string; type: "ai"; serviceId: string; model?: string; prompt: Template; output: "text" | "json" };

export interface AutomationConfig {
  trigger: Trigger;
  steps: Step[];
}

export type RunStatus = "queued" | "running" | "waiting_retry" | "succeeded" | "failed" | "skipped";

export interface Automation {
  id: string;
  name: string;
  ord: string;
  enabled: boolean;
  config: AutomationConfig;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
  failStreak: number;
  disabledReason: "failures" | null;
  lastRun?: { id: number; status: RunStatus; at: number } | null;
}

export interface TriggerInfo {
  type: TriggerType;
  tableId?: string;
  recordId?: number;
  body?: unknown;
  at: number;
  /** User id of whoever caused the run (a button click, a record edit). */
  by?: string;
}

export interface StepLog {
  id: string;
  type: StepType;
  status: "ok" | "error" | "skipped";
  input?: unknown;
  output?: StepOutput;
  error?: string;
  ms: number;
}

/** What later steps can reference: record ids (read again when used) and network results. */
export interface StepOutput {
  records?: { tableId: string; ids: number[] };
  count?: number;
  matched?: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  messageId?: string;
  /** AI step answers. */
  text?: string;
  json?: unknown;
}

export interface AutomationRun {
  id: number;
  automationId: string;
  status: RunStatus;
  test: boolean;
  trigger: TriggerInfo;
  chain: string[];
  steps: StepLog[];
  error: string | null;
  attempt: number;
  nextAt: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ButtonInfo {
  id: string;
  name: string;
  tableId: string;
  viewerCanRun: boolean;
  enabled: boolean;
}

export type AutomationOp =
  | { op: "create"; name: string; config: AutomationConfig; enabled?: boolean }
  | { op: "update"; id: string; name?: string; config?: AutomationConfig; ord?: string }
  | { op: "delete"; id: string }
  | { op: "setEnabled"; id: string; enabled: boolean }
  | { op: "regenerateWebhook"; id: string };

export const LIMITS = {
  automations: 50,
  steps: 25,
  configBytes: 100_000,
  findLimit: 100,
  chain: 5,
  runDays: 30,
  runsKept: 1000,
  failures: 20,
  retryDelays: [10_000, 60_000, 300_000],
  stepTimeout: 10_000,
  runTimeout: 30_000,
  alarmBudget: 2000,
  monthlyRuns: 10_000,
  webhookPerMinute: 60,
  webhookBytes: 256 * 1024,
  recipients: 50,
  systemMailPerDay: 100,
  outputBytes: 8192,
  httpBodyLog: 4096,
  httpReadBytes: 1024 * 1024,
  aiStepTimeout: 60_000,
  /** Runs with an AI step may take this long instead of runTimeout. */
  aiRunTimeout: 150_000,
} as const;

export const RECORD_TRIGGERS: ReadonlySet<TriggerType> = new Set(["recordCreated", "recordUpdated", "recordMatches"]);
/** Triggers that run with a record ({{trigger.record}}, updateRecords target "trigger"). */
export const RECORD_SOURCES: ReadonlySet<TriggerType> = new Set(["recordCreated", "recordUpdated", "recordMatches", "dateReached", "button"]);

/** How long a run may take: longer when it has an AI step, whose model call may take a minute. */
export function runLimit(cfg: Pick<AutomationConfig, "steps">): number {
  return flatSteps(cfg.steps ?? []).some(s => s.type === "ai") ? LIMITS.aiRunTimeout : LIMITS.runTimeout;
}

/** Steps in run order, branch children right after their branch. */
export function flatSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    out.push(s);
    if (s.type === "branch") out.push(...(s.then ?? []), ...(s.else ?? []));
  }
  return out;
}

export function triggerTableId(t: Trigger): string | undefined {
  return "tableId" in t ? t.tableId : undefined;
}

export function parseHm(at: unknown): [number, number] | null {
  const m = typeof at === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "s<n>" after the highest numbered step, so ids stay short and templates stay readable. */
export function nextStepId(steps: Step[]): string {
  const max = flatSteps(steps).reduce((m, s) => Math.max(m, /^s(\d+)$/.test(s.id) ? Number(s.id.slice(1)) : 0), 0);
  return "s" + (max + 1);
}

export interface AutomationSchema {
  tables: Pick<Table, "id" | "name">[];
  fields: Field[];
}

const STEP_ID = /^[A-Za-z0-9_]{1,40}$/;
const has = (list: readonly string[], v: unknown) => typeof v === "string" && list.includes(v);

/** The first problem with a definition, or null. Template references are checked by templateProblem in template.ts. */
export function validateAutomation(cfg: AutomationConfig, s: AutomationSchema): string | null {
  if (!cfg || typeof cfg !== "object") return "Invalid automation";
  if (JSON.stringify(cfg).length > LIMITS.configBytes) return "An automation is limited to 100 KB";
  const tables = new Set(s.tables.map(t => t.id));
  const fieldsOf = (tableId: string) => new Map(s.fields.filter(f => f.tableId === tableId).map(f => [f.id, f]));
  const tableErr = (id: unknown) => (typeof id === "string" && tables.has(id) ? null : `Unknown table ${String(id)}`);
  const condErr = (spec: FilterSpec | undefined, tableId: string, where: string): string | null => {
    if (spec === undefined) return null;
    if (!spec || !Array.isArray(spec.conditions) || (spec.conjunction !== "and" && spec.conjunction !== "or")) return `Invalid conditions in ${where}`;
    const fields = fieldsOf(tableId);
    for (const c of spec.conditions) if (!fields.has(c?.fieldId)) return `Unknown field ${String(c?.fieldId)} in ${where}`;
    return null;
  };

  const t = cfg.trigger;
  if (!t || !has(TRIGGER_TYPES, t.type)) return "Unknown trigger type";
  switch (t.type) {
    case "recordCreated":
    case "recordUpdated":
    case "recordMatches": {
      const e = tableErr(t.tableId) ?? condErr(t.conditions, t.tableId, "the trigger conditions");
      if (e) return e;
      if (t.type === "recordMatches" && !t.conditions?.conditions.length) return "Add at least one condition";
      if (t.type === "recordUpdated" && t.fieldIds !== undefined) {
        if (!Array.isArray(t.fieldIds)) return "Invalid watched fields";
        const fields = fieldsOf(t.tableId);
        for (const id of t.fieldIds) if (!fields.has(id)) return `Unknown field ${String(id)} in the watched fields`;
      }
      break;
    }
    case "schedule":
      if (!has(["hour", "day", "week", "month"], t.every)) return "Choose how often to run";
      if (!parseHm(t.at)) return "Times look like 09:30";
      if (!isValidTimeZone(t.tz)) return `Unknown time zone ${String(t.tz)}`;
      if (t.every === "hour" && t.interval !== undefined && !(Number.isInteger(t.interval) && t.interval >= 1 && t.interval <= 24)) return "Run every 1 to 24 hours";
      if (t.every === "week" && !(Number.isInteger(t.weekday) && t.weekday! >= 0 && t.weekday! <= 6)) return "Choose a weekday";
      if (t.every === "month" && !(Number.isInteger(t.monthday) && t.monthday! >= 1 && t.monthday! <= 31)) return "Choose a day of the month";
      break;
    case "dateReached": {
      const e = tableErr(t.tableId) ?? condErr(t.conditions, t.tableId, "the trigger conditions");
      if (e) return e;
      if (fieldsOf(t.tableId).get(t.fieldId)?.type !== "date") return "Choose a date field";
      if (!Number.isInteger(t.offsetMinutes) || Math.abs(t.offsetMinutes) > 525_600) return "The offset must be within a year";
      if (t.at !== undefined && !parseHm(t.at)) return "Times look like 09:30";
      if (!isValidTimeZone(t.tz)) return `Unknown time zone ${String(t.tz)}`;
      break;
    }
    case "webhook":
      if (typeof t.token !== "string" || !/^[A-Za-z0-9]{24,64}$/.test(t.token)) return "Invalid webhook token";
      break;
    case "button": {
      const e = tableErr(t.tableId);
      if (e) return e;
      if (typeof t.viewerCanRun !== "boolean") return "Invalid button setting";
      break;
    }
  }

  if (!Array.isArray(cfg.steps)) return "Invalid steps";
  for (const st of cfg.steps) if (st?.type === "branch" && [...(st.then ?? []), ...(st.else ?? [])].some(x => x?.type === "branch")) return "A branch cannot contain another branch";
  const flat = flatSteps(cfg.steps);
  if (flat.length > LIMITS.steps) return `An automation has at most ${LIMITS.steps} steps`;
  const ids = new Set<string>();
  for (const st of flat) {
    if (!st || typeof st.id !== "string" || !STEP_ID.test(st.id) || ids.has(st.id)) return "Step ids must be unique";
    ids.add(st.id);
  }
  const seen = new Map<string, Step>();
  for (const st of flat) {
    const e = stepProblem(st);
    if (e) return e;
    seen.set(st.id, st);
  }
  return null;

  function stepProblem(st: Step): string | null {
    switch (st.type) {
      case "createRecord":
      case "updateRecords": {
        const e = tableErr(st.tableId);
        if (e) return e;
        if (!st.values || typeof st.values !== "object" || Array.isArray(st.values)) return "Invalid values";
        const fields = fieldsOf(st.tableId);
        for (const [fid, v] of Object.entries(st.values)) {
          const f = fields.get(fid);
          if (!f) return `Unknown field ${fid}`;
          if (COMPUTED_TYPES.has(f.type)) return `The field ${f.name} cannot be written`;
          if (typeof v !== "string") return `Invalid value for ${f.name}`;
        }
        if (st.type === "updateRecords") {
          if (st.target === "trigger") {
            if (!RECORD_SOURCES.has(t.type)) return "This trigger has no record to update";
            if (triggerTableId(t) !== st.tableId) return "The table must be the trigger's table";
          } else {
            const src = seen.get(st.target);
            if (!src || (src.type !== "findRecords" && src.type !== "createRecord") || src.tableId !== st.tableId) return "Update records must target the trigger record or an earlier find or create step of the same table";
          }
        }
        return null;
      }
      case "findRecords": {
        const e = tableErr(st.tableId) ?? condErr(st.conditions, st.tableId, "the find conditions");
        if (e) return e;
        if (!Number.isInteger(st.limit) || st.limit < 1 || st.limit > LIMITS.findLimit) return `Find at most ${LIMITS.findLimit} records`;
        const fields = fieldsOf(st.tableId);
        for (const so of st.sort ?? []) if (!fields.has(so?.fieldId)) return `Unknown sort field ${String(so?.fieldId)}`;
        return null;
      }
      case "http":
        if (!has(HTTP_METHODS, st.method)) return "Unknown HTTP method";
        if (typeof st.url !== "string" || !st.url.trim()) return "Enter a URL";
        if (!Array.isArray(st.headers) || st.headers.length > 20 || st.headers.some(h => !Array.isArray(h) || typeof h[0] !== "string" || typeof h[1] !== "string")) return "Invalid headers";
        if (st.body !== undefined && typeof st.body !== "string") return "Invalid body";
        return null;
      case "email":
        if (!has(MAIL_PROVIDERS, st.provider)) return "Choose how to send the email";
        if (typeof st.to !== "string" || !st.to.trim()) return "Enter at least one recipient";
        if (typeof st.subject !== "string" || typeof st.body !== "string") return "Enter a subject and a message";
        if (st.cc !== undefined && typeof st.cc !== "string") return "Invalid cc";
        if (st.format !== "text" && st.format !== "html") return "Invalid email format";
        return null;
      case "branch":
        if (st.match !== "all" && st.match !== "any") return "Invalid branch";
        if (!Array.isArray(st.conditions) || !st.conditions.length) return "Add at least one branch condition";
        if (st.conditions.some(c => !c || !has(BRANCH_OPS, c.op) || typeof c.left !== "string" || (c.right !== undefined && typeof c.right !== "string"))) return "Invalid branch condition";
        if (!Array.isArray(st.then) || !Array.isArray(st.else)) return "Invalid branch";
        return null;
      case "ai":
        if (typeof st.serviceId !== "string" || !st.serviceId.trim()) return "Choose an AI service";
        if (typeof st.prompt !== "string" || !st.prompt.trim()) return "Write a prompt";
        if (st.prompt.length > 8000) return "A prompt can have at most 8,000 characters";
        if (st.output !== "text" && st.output !== "json") return "Choose text or JSON output";
        if (st.model !== undefined && typeof st.model !== "string") return "Invalid model";
        return null;
      default:
        return "Unknown step type";
    }
  }
}
