# Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-base automations (record, schedule, date, webhook and button triggers; create, update, find, HTTP, email and if/else steps) with run history, retries, loop protection, quotas, an editor page, a button field, workspace mail settings, MCP tools and a stored verification record.

**Architecture:** Everything runs inside the base's Durable Object. Trigger detection hooks into `BaseStore.run()` and queues runs in `_auto_runs` in the same transaction as the write. The DO's single alarm is set to the earliest of pending jobs, queued runs, retries, schedules and date triggers; the alarm handler executes runs with an executor whose network side (HTTP, email) is injected, so worker tests drive it with fakes. Definitions are not part of the broadcast schema; editors fetch them from their own endpoint, and the schema only carries button stubs.

**Tech Stack:** Cloudflare Workers, Durable Objects (SQLite), D1, Hono, React 18, Vitest (unit + workerd pool), `cloudflare:sockets` for SMTP, the `send_email` binding for Cloudflare Email Service, Playwright MCP for UI checks.

**Spec:** `docs/superpowers/specs/2026-10-13-automations-design.md`

## Global Constraints

- No git operations (user rule). Each task's last step is "Checkpoint": run the task's tests and record the result in the ledger.
- No Chinese in code or comments. Never output the em dash character; use "-".
- No new npm dependencies. The SMTP client is written in this repo (`src/worker/auto/smtp.ts`).
- Limits (from `LIMITS` in `src/shared/automations.ts`): 50 automations per base; 25 steps per automation, branch steps included; 100 KB per definition; find at most 100 records; chain depth 5; runs kept 30 days and at most 1,000 per automation; auto-disable after 20 failed runs in a row; retries after 10 s, 1 min, 5 min; 10 s per network step; 30 s per run; about 2 s of work per alarm; 10,000 runs per base per month by default (`AUTOMATION_MONTHLY_RUNS`, `0` means no limit); 60 webhook calls per minute per base; 256 KB webhook bodies; 50 recipients per email; 100 system emails per workspace per day in cloud mode; step outputs truncated at 8 KB; HTTP response bodies logged up to 4 KB and read up to 1 MB.
- New environment settings: `SECRET_KEY` (encrypts mail secrets), `EMAIL` (`send_email` binding, optional), `EMAIL_FROM`, `AUTOMATION_ALLOW_PRIVATE`, `AUTOMATION_MONTHLY_RUNS`.
- Writes by automations use the actor `{ userId: "auto:<id>", name: "Automation: <name>" }` and typecast.
- Triggers fire for writes from the UI, the REST API, MCP, forms and automations. CSV import (`source: "import"`), Airtable import, templates and background jobs do not fire them.
- Step ids are short and stable (`s1`, `s2`, ...), assigned by the editor and by MCP; templates refer to them.
- Template inputs in the editor show field names (`{{trigger.record.Stage}}`) and are stored with field ids (`{{trigger.record.fldXXXX}}`).
- Docker and `wrangler dev` behave the same, except the system email provider, which exists only on Cloudflare.
- Verification record for automations in `docs/verification/`; local `wrangler dev` numbers labeled as local.

## Review Focus

- The Durable Object is evicted while a run waits on an HTTP response: the run is left `running` and must be picked up again by a later alarm, resuming at the step that did not finish, not lost and not repeated from the start (Task 7 test "a run left running by an eviction resumes at its unfinished step").
- A paste of 1,000 rows into a table with a record trigger: the write must stay fast, and the alarm must drain the runs over several alarms without blocking edits for more than about 2 s at a time (Task 7 test "the alarm stops after its time budget and continues later", Task 16 bench).
- A daily schedule at 02:30 in America/New_York on the spring-forward day must still run once that day (Task 3 test "still runs once on a spring-forward day").
- An automation that updates its own trigger record ("when Stage changes, set Last touched") must not loop (Task 5 test "an automation does not trigger itself through its own writes").
- A webhook called with a broken JSON body or a body over 256 KB must get 400 or 413, not a 500, and must not queue a run (Task 10 tests).

---

### Task 1: Shared automation types and validation

**Files:**
- Create: `src/shared/automations.ts`
- Modify: `src/shared/ids.ts`
- Modify: `src/shared/types.ts` (`Schema.buttons`, `ServerMessage` `automations`)
- Test: `test/unit/automations.test.ts`

**Interfaces:**
- Produces (from `src/shared/automations.ts`): `TRIGGER_TYPES`, `TriggerType`, `STEP_TYPES`, `StepType`, `HTTP_METHODS`, `HttpMethod`, `MAIL_PROVIDERS`, `MailProvider`, `BRANCH_OPS`, `BranchOp`, `Template`, `ScheduleTrigger`, `DateTrigger`, `Trigger`, `BranchCondition`, `Step`, `AutomationConfig`, `RunStatus`, `Automation`, `TriggerInfo`, `StepLog`, `StepOutput`, `AutomationRun`, `ButtonInfo`, `AutomationOp`, `LIMITS`, `RECORD_TRIGGERS`, `RECORD_SOURCES`, `flatSteps(steps)`, `triggerTableId(t)`, `parseHm(at)`, `isValidTimeZone(tz)`, `nextStepId(steps)`, `AutomationSchema`, `validateAutomation(cfg, s): string | null`.
- Produces (from `src/shared/ids.ts`): `newAutomationId()`, `newWebhookToken()`.
- Produces (from `src/shared/types.ts`): `Schema.buttons?: ButtonInfo[]`; `ServerMessage` member `{ type: "automations" }`.

- [ ] **Step 1: Write the failing test**

`test/unit/automations.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/automations.test.ts`
Expected: FAIL with "Failed to load url ../../src/shared/automations" (module does not exist).

- [ ] **Step 3: Write the implementation**

`src/shared/ids.ts`, add after `newWidgetId`:

```ts
export const newAutomationId = () => randomId("aut");
export const newWebhookToken = () => randomId("", 32);
```

`src/shared/types.ts`: add at the top `import type { ButtonInfo } from "./automations";`, add to `Schema` after `dashboards: Dashboard[];`:

```ts
  /** Automations with a button trigger; definitions themselves are only sent to editors. */
  buttons?: ButtonInfo[];
```

and add to the `ServerMessage` union:

```ts
  | { type: "automations" }
```

`src/shared/automations.ts`:

```ts
// Automation definitions shared by the Durable Object, the MCP tools and the editor: types, limits and validation.
import type { Field, FilterSpec, SortSpec, Table } from "./types";
import { COMPUTED_TYPES } from "./types";

export const TRIGGER_TYPES = ["recordCreated", "recordUpdated", "recordMatches", "schedule", "dateReached", "webhook", "button"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const STEP_TYPES = ["createRecord", "updateRecords", "findRecords", "http", "email", "branch"] as const;
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
  | { id: string; type: "branch"; match: "all" | "any"; conditions: BranchCondition[]; then: Step[]; else: Step[] };

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
} as const;

export const RECORD_TRIGGERS: ReadonlySet<TriggerType> = new Set(["recordCreated", "recordUpdated", "recordMatches"]);
/** Triggers that run with a record ({{trigger.record}}, updateRecords target "trigger"). */
export const RECORD_SOURCES: ReadonlySet<TriggerType> = new Set(["recordCreated", "recordUpdated", "recordMatches", "dateReached", "button"]);

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
      default:
        return "Unknown step type";
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/automations.test.ts && npm run typecheck`
Expected: PASS (15 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Record in the ledger: `Task 1: automations.test.ts 15/15, typecheck clean`.

---

### Task 2: Templates

**Files:**
- Create: `src/shared/template.ts`
- Test: `test/unit/template.test.ts`

**Interfaces:**
- Consumes: `AutomationConfig`, `AutomationSchema`, `Step`, `StepOutput`, `Template`, `Trigger`, `flatSteps`, `RECORD_SOURCES`, `triggerTableId` (Task 1); `displayCell`, `formulaValue` from `src/shared/cells.ts`.
- Produces: `Part`, `parseTemplate(tpl)`, `splitPath(s)`, `templatePaths(tpl)`, `RecordRef { tableId; row }`, `TemplateContext { trigger: { record?: RecordRef; body?: unknown }; steps: Record<string, StepOutput>; now: number; automationName: string; baseUrl: string }`, `TemplateEnv { field(id); table(id); rows(tableId, ids); userName(id) }`, `renderText(tpl, ctx, env, escape?: (s: string) => string): string` (escape applies to inserted values only, for HTML email bodies), `renderValue(tpl, ctx, env): unknown`, `recordUrl(baseUrl, tableId, id)`, `stepTemplates(step): string[]`, `templateProblem(cfg, s): string | null`, `NameContext { fields: Field[]; triggerTableId?: string; stepTableId(id): string | undefined }`, `toDisplay(tpl, n)`, `fromDisplay(text, n)`.

- [ ] **Step 1: Write the failing test**

`test/unit/template.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/template.test.ts`
Expected: FAIL with "Failed to load url ../../src/shared/template".

- [ ] **Step 3: Write the implementation**

`src/shared/template.ts`:

```ts
// {{...}} references in automation steps: parsing, rendering as text or typed values,
// checking references against the schema, and showing field names in the editor.
import type { Field, Row, Table } from "./types";
import { displayCell, formulaValue } from "./cells";
import { flatSteps, RECORD_SOURCES, triggerTableId, type AutomationConfig, type AutomationSchema, type Step, type StepOutput, type Template, type Trigger } from "./automations";

export type Part = { text: string } | { path: string[] };

const REF = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function parseTemplate(tpl: Template): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of tpl.matchAll(REF)) {
    if (m.index! > last) out.push({ text: tpl.slice(last, m.index) });
    out.push({ path: splitPath(m[1]) });
    last = m.index! + m[0].length;
  }
  if (last < tpl.length) out.push({ text: tpl.slice(last) });
  return out;
}

/** "steps.s1.records[0].fldA" becomes ["steps", "s1", "records", "0", "fldA"]. */
export function splitPath(s: string): string[] {
  return s.replace(/\[(\d+)\]/g, ".$1").split(".").map(x => x.trim()).filter(Boolean);
}

export function templatePaths(tpl: Template): string[][] {
  return parseTemplate(tpl).flatMap(p => ("path" in p ? [p.path] : []));
}

export interface RecordRef {
  tableId: string;
  row: Row;
}

export interface TemplateContext {
  trigger: { record?: RecordRef; body?: unknown };
  steps: Record<string, StepOutput>;
  now: number;
  automationName: string;
  /** Origin plus /base/<id>, without a trailing slash. */
  baseUrl: string;
}

export interface TemplateEnv {
  field(id: string): Field | undefined;
  table(id: string): Pick<Table, "id" | "primaryFieldId"> | undefined;
  /** Rows by id, in the given order; missing ids are skipped. */
  rows(tableId: string, ids: number[]): Row[];
  userName(id: string): string;
}

interface Resolved {
  value: unknown;
  text: string;
}

const EMPTY: Resolved = { value: undefined, text: "" };
const plain = (s: string): Resolved => ({ value: s, text: s });

export function recordUrl(baseUrl: string, tableId: string, id: number): string {
  return `${baseUrl}/${tableId}?record=${id}`;
}

function cellOf(f: Field, r: Row): unknown {
  if (f.type === "createdTime") return r.createdAt;
  if (f.type === "modifiedTime") return r.updatedAt;
  if (f.type === "autonumber") return r.id;
  return r.cells[f.id];
}

function fieldValue(f: Field, row: Row, env: TemplateEnv): Resolved {
  const raw = cellOf(f, row);
  if (raw === undefined || raw === null) return EMPTY;
  const ctx = { userName: env.userName };
  let value: unknown;
  if (f.type === "link") value = (raw as { id: number }[]).map(x => ({ id: x.id }));
  else if (f.type === "user" || f.type === "attachment") value = raw;
  else value = formulaValue(f, raw, ctx);
  return { value, text: displayCell(f, raw, ctx) };
}

function title(r: RecordRef, env: TemplateEnv): string {
  const t = env.table(r.tableId);
  const f = t && env.field(t.primaryFieldId);
  return f ? displayCell(f, cellOf(f, r.row), { userName: env.userName }) : String(r.row.id);
}

function recordPath(list: RecordRef[], tail: string[], env: TemplateEnv): Resolved {
  if (!list.length) return EMPTY;
  // The records themselves: ids for link fields, titles as text.
  if (!tail.length) return { value: list.map(r => ({ id: r.row.id })), text: list.map(r => title(r, env)).join(", ") };
  const f = env.field(tail[0]);
  if (!f) return EMPTY;
  const parts = list.map(r => fieldValue(f, r.row, env));
  if (parts.length === 1) return parts[0];
  return {
    value: parts.flatMap(p => (Array.isArray(p.value) ? p.value : p.value === undefined ? [] : [p.value])),
    text: parts.map(p => p.text).filter(Boolean).join(", "),
  };
}

function jsonPath(v: unknown, path: string[]): Resolved {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return EMPTY;
    cur = Array.isArray(cur) ? cur[Number(k)] : (cur as Record<string, unknown>)[k];
  }
  if (cur === undefined || cur === null) return EMPTY;
  return { value: cur, text: typeof cur === "string" ? cur : typeof cur === "number" || typeof cur === "boolean" ? String(cur) : JSON.stringify(cur) };
}

function resolve(path: string[], ctx: TemplateContext, env: TemplateEnv): Resolved {
  const [head, ...rest] = path;
  if (head === "now" && !rest.length) return plain(new Date(ctx.now).toISOString());
  if (head === "automation" && rest[0] === "name") return plain(ctx.automationName);
  if (head === "base" && rest[0] === "url") return plain(ctx.baseUrl);
  if (head === "record" && rest[0] === "url") {
    const r = ctx.trigger.record;
    return r ? plain(recordUrl(ctx.baseUrl, r.tableId, r.row.id)) : EMPTY;
  }
  if (head === "trigger") {
    if (rest[0] === "record") return ctx.trigger.record ? recordPath([ctx.trigger.record], rest.slice(1), env) : EMPTY;
    if (rest[0] === "body") return jsonPath(ctx.trigger.body, rest.slice(1));
    return EMPTY;
  }
  if (head === "steps") {
    const out = ctx.steps[rest[0]];
    if (!out) return EMPTY;
    const key = rest[1];
    if (key === "records" || key === "record") {
      const recs = out.records;
      if (!recs) return EMPTY;
      let tail = rest.slice(2);
      let ids = recs.ids;
      if (key === "record") ids = ids.slice(0, 1);
      else if (tail.length && /^\d+$/.test(tail[0])) {
        ids = ids.slice(Number(tail[0]), Number(tail[0]) + 1);
        tail = tail.slice(1);
      }
      return recordPath(env.rows(recs.tableId, ids).map(row => ({ tableId: recs.tableId, row })), tail, env);
    }
    if (key === "body") return jsonPath(out.body, rest.slice(2));
    if (key === "count" || key === "status" || key === "matched" || key === "messageId") return jsonPath(out[key], []);
    return EMPTY;
  }
  return EMPTY;
}

/** Text with every reference replaced; `escape` applies to inserted values only (HTML email bodies). */
export function renderText(tpl: Template, ctx: TemplateContext, env: TemplateEnv, escape?: (s: string) => string): string {
  return parseTemplate(tpl)
    .map(p => {
      if ("text" in p) return p.text;
      const t = resolve(p.path, ctx, env).text;
      return escape ? escape(t) : t;
    })
    .join("");
}

/** A template that is exactly one reference keeps the referenced value's type; anything else renders as text. */
export function renderValue(tpl: Template, ctx: TemplateContext, env: TemplateEnv): unknown {
  const parts = parseTemplate(tpl.trim());
  if (parts.length === 1 && "path" in parts[0]) return resolve(parts[0].path, ctx, env).value;
  return renderText(tpl, ctx, env);
}

/** Every template string inside a step (not its children). */
export function stepTemplates(st: Step): string[] {
  switch (st.type) {
    case "createRecord":
    case "updateRecords":
      return Object.values(st.values ?? {});
    case "findRecords":
      return (st.conditions?.conditions ?? []).flatMap(c => (typeof c.value === "string" ? [c.value] : []));
    case "http":
      return [st.url, ...(st.headers ?? []).map(h => h[1]), ...(st.body !== undefined ? [st.body] : [])];
    case "email":
      return [st.to, st.cc ?? "", st.subject, st.body];
    case "branch":
      return st.conditions.flatMap(c => [c.left, c.right ?? ""]);
  }
}

const OUTPUT_KEYS: Record<Step["type"], string[]> = {
  createRecord: ["record", "records"],
  updateRecords: ["record", "records", "count"],
  findRecords: ["record", "records", "count"],
  http: ["status", "body"],
  email: ["messageId"],
  branch: ["matched"],
};

function pathOk(path: string[], trigger: Trigger, before: Map<string, Step>, fieldsOf: (tableId: string) => Set<string>): boolean {
  const [head, ...rest] = path;
  if (head === "now") return !rest.length;
  if (head === "automation") return rest.length === 1 && rest[0] === "name";
  if (head === "base") return rest.length === 1 && rest[0] === "url";
  if (head === "record") return rest.length === 1 && rest[0] === "url" && RECORD_SOURCES.has(trigger.type);
  if (head === "trigger") {
    if (rest[0] === "body") return trigger.type === "webhook";
    if (rest[0] !== "record" || !RECORD_SOURCES.has(trigger.type)) return false;
    return rest.length === 1 || (rest.length === 2 && fieldsOf(triggerTableId(trigger) ?? "").has(rest[1]));
  }
  if (head === "steps") {
    const st = before.get(rest[0]);
    const key = rest[1];
    if (!st || !key || !OUTPUT_KEYS[st.type].includes(key)) return false;
    if (key !== "record" && key !== "records") return key === "body" || rest.length === 2;
    let tail = rest.slice(2);
    if (key === "records" && tail.length && /^\d+$/.test(tail[0])) tail = tail.slice(1);
    return !tail.length || (tail.length === 1 && "tableId" in st && fieldsOf(st.tableId).has(tail[0]));
  }
  return false;
}

/** The first template that refers to something that does not exist at that point of the run, or null. */
export function templateProblem(cfg: AutomationConfig, s: AutomationSchema): string | null {
  const fieldsOf = (tableId: string) => new Set(s.fields.filter(f => f.tableId === tableId).map(f => f.id));
  const before = new Map<string, Step>();
  for (const st of flatSteps(cfg.steps)) {
    for (const tpl of stepTemplates(st)) {
      for (const path of templatePaths(tpl)) if (!pathOk(path, cfg.trigger, before, fieldsOf)) return `Unknown reference {{${path.join(".")}}}`;
    }
    before.set(st.id, st);
  }
  return null;
}

export interface NameContext {
  fields: Field[];
  triggerTableId?: string;
  stepTableId(id: string): string | undefined;
}

/** The table and the field part of a record reference, or null for other references. */
function fieldRef(inner: string, n: NameContext): { prefix: string; tableId: string; rest: string } | null {
  let m = /^(trigger\.record)\.(.+)$/.exec(inner);
  if (m && n.triggerTableId) return { prefix: m[1], tableId: n.triggerTableId, rest: m[2] };
  m = /^(steps\.([A-Za-z0-9_]+)\.(?:records(?:\[\d+\])?|record))\.(.+)$/.exec(inner);
  const tableId = m ? n.stepTableId(m[2]) : undefined;
  if (m && tableId) return { prefix: m[1], tableId, rest: m[3] };
  return null;
}

function mapRefs(tpl: string, n: NameContext, map: (tableId: string, rest: string) => string | undefined): string {
  return tpl.replace(REF, (all, inner: string) => {
    const r = fieldRef(inner.trim(), n);
    if (!r) return all;
    const next = map(r.tableId, r.rest);
    return next === undefined ? all : `{{${r.prefix}.${next}}}`;
  });
}

/** Stored ids to field names, for editing. */
export function toDisplay(tpl: Template, n: NameContext): string {
  return mapRefs(tpl, n, (tableId, id) => n.fields.find(f => f.tableId === tableId && f.id === id)?.name);
}

/** Field names back to ids; unknown names are kept, so validation reports them. */
export function fromDisplay(text: string, n: NameContext): Template {
  return mapRefs(text, n, (tableId, name) => {
    const list = n.fields.filter(f => f.tableId === tableId);
    const key = name.trim();
    return (list.find(f => f.name === key) ?? list.find(f => f.name.toLowerCase() === key.toLowerCase()) ?? list.find(f => f.id === key))?.id;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/template.test.ts && npm run typecheck`
Expected: PASS (12 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Record in the ledger: `Task 2: template.test.ts 12/12, typecheck clean`.

---

### Task 3: Schedules, date triggers and time zones

**Files:**
- Create: `src/shared/schedule.ts`
- Test: `test/unit/schedule.test.ts`

**Interfaces:**
- Consumes: `ScheduleTrigger`, `DateTrigger`, `parseHm` (Task 1).
- Produces: `ZonedParts { y; m; d; hh; mm; wd }`, `zonedParts(ms, tz)`, `zonedToUtc(y, m, d, hh, mm, tz): number`, `nextScheduleTime(t: ScheduleTrigger, after: number): number` (strictly after `after`), `dateDue(value: unknown, t: Pick<DateTrigger, "offsetMinutes" | "at" | "tz">): number | null`, `dueDayWindow(from, to, offsetMinutes): [string, string]`.

- [ ] **Step 1: Write the failing test**

`test/unit/schedule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dateDue, dueDayWindow, nextScheduleTime, zonedParts, zonedToUtc } from "../../src/shared/schedule";

const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

describe("time zones", () => {
  it("converts a wall clock time to UTC", () => {
    expect(iso(zonedToUtc(2026, 10, 13, 9, 0, "Asia/Shanghai"))).toBe("2026-10-13T01:00:00.000Z");
    expect(iso(zonedToUtc(2026, 7, 1, 9, 0, "America/New_York"))).toBe("2026-07-01T13:00:00.000Z");
  });

  it("moves a time skipped by DST to the same clock time after the change", () => {
    expect(iso(zonedToUtc(2026, 3, 8, 2, 30, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(zonedToUtc(2026, 3, 8, 3, 30, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
  });

  it("takes the first of two repeated times", () => {
    expect(iso(zonedToUtc(2026, 11, 1, 1, 30, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(zonedToUtc(2026, 10, 25, 1, 30, "Europe/London"))).toBe("2026-10-25T00:30:00.000Z");
  });

  it("reads local parts", () => {
    expect(zonedParts(Date.UTC(2026, 9, 12, 23, 30), "Asia/Tokyo")).toEqual({ y: 2026, m: 10, d: 13, hh: 8, mm: 30, wd: 2 });
  });
});

describe("next schedule time", () => {
  it("runs daily at the local time", () => {
    const t = { type: "schedule" as const, every: "day" as const, at: "09:00", tz: "Asia/Shanghai" };
    expect(iso(nextScheduleTime(t, at("2026-10-13T00:00:00Z")))).toBe("2026-10-13T01:00:00.000Z");
    expect(iso(nextScheduleTime(t, at("2026-10-13T01:00:00Z")))).toBe("2026-10-14T01:00:00.000Z");
  });

  it("runs weekly on the weekday", () => {
    const t = { type: "schedule" as const, every: "week" as const, weekday: 1, at: "08:00", tz: "UTC" };
    expect(iso(nextScheduleTime(t, at("2026-10-13T12:00:00Z")))).toBe("2026-10-19T08:00:00.000Z");
  });

  it("runs monthly, on the last day when the month is shorter", () => {
    const t = { type: "schedule" as const, every: "month" as const, monthday: 31, at: "10:00", tz: "UTC" };
    expect(iso(nextScheduleTime(t, at("2026-02-01T00:00:00Z")))).toBe("2026-02-28T10:00:00.000Z");
    expect(iso(nextScheduleTime(t, at("2028-02-01T00:00:00Z")))).toBe("2028-02-29T10:00:00.000Z");
    expect(iso(nextScheduleTime(t, at("2026-02-28T10:00:00Z")))).toBe("2026-03-31T10:00:00.000Z");
  });

  it("runs every N hours from local midnight", () => {
    const t = { type: "schedule" as const, every: "hour" as const, interval: 6, at: "00:15", tz: "UTC" };
    expect(iso(nextScheduleTime(t, at("2026-10-13T06:15:00Z")))).toBe("2026-10-13T12:15:00.000Z");
  });

  it("still runs once on a spring-forward day", () => {
    const t = { type: "schedule" as const, every: "day" as const, at: "02:30", tz: "America/New_York" };
    expect(iso(nextScheduleTime(t, at("2026-03-08T00:00:00Z")))).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(nextScheduleTime(t, at("2026-03-08T07:30:00Z")))).toBe("2026-03-09T06:30:00.000Z");
  });
});

describe("date triggers", () => {
  it("uses the trigger's time for date-only cells", () => {
    expect(iso(dateDue("2026-10-20", { offsetMinutes: -1440, at: "09:00", tz: "Asia/Shanghai" })!)).toBe("2026-10-19T01:00:00.000Z");
    expect(iso(dateDue("2026-10-20", { offsetMinutes: 0, tz: "UTC" })!)).toBe("2026-10-20T09:00:00.000Z");
  });

  it("uses the instant of date-and-time cells", () => {
    expect(iso(dateDue("2026-10-20T15:00:00.000Z", { offsetMinutes: -60, tz: "UTC" })!)).toBe("2026-10-20T14:00:00.000Z");
  });

  it("ignores empty or invalid cells", () => {
    expect(dateDue(undefined, { offsetMinutes: 0, tz: "UTC" })).toBeNull();
    expect(dateDue("soon", { offsetMinutes: 0, tz: "UTC" })).toBeNull();
  });

  it("widens the day window by two days on each side", () => {
    expect(dueDayWindow(at("2026-10-13T00:00:00Z"), at("2026-10-14T00:00:00Z"), -1440)).toEqual(["2026-10-12", "2026-10-17"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/schedule.test.ts`
Expected: FAIL with "Failed to load url ../../src/shared/schedule".

- [ ] **Step 3: Write the implementation**

`src/shared/schedule.ts`:

```ts
// Time zone arithmetic for schedule and date triggers, with Intl only (no time zone data is bundled).
import { parseHm, type DateTrigger, type ScheduleTrigger } from "./automations";

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  /** 0 is Sunday. */
  wd: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formats.set(tz, f);
  }
  return f;
}

export function zonedParts(ms: number, tz: string): ZonedParts {
  const p = Object.fromEntries(format(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute), wd: WEEKDAYS.indexOf(p.weekday) };
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetAt(ms: number, tz: string): number {
  const z = zonedParts(ms, tz);
  return (Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm) - Math.floor(ms / 60000) * 60000) / 60000;
}

function shows(ms: number, tz: string, y: number, m: number, d: number, hh: number, mm: number): boolean {
  const z = zonedParts(ms, tz);
  return z.y === y && z.m === m && z.d === d && z.hh === hh && z.mm === mm;
}

/**
 * The instant of a local wall clock time. A time skipped by a DST change maps to the same clock time
 * after the change (02:30 on a spring-forward day becomes 03:30); a repeated time takes its first occurrence.
 */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offsetAt(wall, tz);
  let t = wall - o1 * 60000;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) {
    const t2 = wall - o2 * 60000;
    if (shows(t2, tz, y, m, d, hh, mm)) t = t2;
  }
  if (shows(t - 3_600_000, tz, y, m, d, hh, mm)) t -= 3_600_000;
  return t;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const hoursOf = (n: number) => Array.from({ length: 24 }, (_, i) => i).filter(i => i % n === 0);

/** The next run strictly after `after`. */
export function nextScheduleTime(t: ScheduleTrigger, after: number): number {
  const [h, m] = parseHm(t.at) ?? [9, 0];
  const start = zonedParts(after, t.tz);
  // Walking local days from the day of `after`; 400 days covers every monthly schedule.
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (t.every === "week" && day.getUTCDay() !== t.weekday) continue;
    if (t.every === "month" && d !== Math.min(t.monthday ?? 1, daysIn(y, mo))) continue;
    for (const hh of t.every === "hour" ? hoursOf(t.interval ?? 1) : [h]) {
      const ms = zonedToUtc(y, mo, d, hh, m, t.tz);
      if (ms > after) return ms;
    }
  }
  return after + 86_400_000;
}

/** When a date cell fires a dateReached trigger: its instant (or its day at `at`, 09:00 by default, in the trigger's zone) plus the offset. */
export function dateDue(value: unknown, t: Pick<DateTrigger, "offsetMinutes" | "at" | "tz">): number | null {
  if (typeof value !== "string") return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  let base: number;
  if (day) {
    const [h, m] = parseHm(t.at) ?? [9, 0];
    base = zonedToUtc(Number(day[1]), Number(day[2]), Number(day[3]), h, m, t.tz);
  } else {
    base = Date.parse(value);
    if (!Number.isFinite(base)) return null;
  }
  return base + t.offsetMinutes * 60000;
}

/** Days (YYYY-MM-DD) of cells that can fall due within (from, to]: a superset, so callers check dateDue exactly. */
export function dueDayWindow(from: number, to: number, offsetMinutes: number): [string, string] {
  // A zone and the `at` time move a day's instant by less than two days.
  const pad = 2 * 86_400_000;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [day(from - offsetMinutes * 60000 - pad), day(to - offsetMinutes * 60000 + pad)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/schedule.test.ts && npm run typecheck`
Expected: PASS (13 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Record in the ledger: `Task 3: schedule.test.ts 13/13, typecheck clean`.

---
### Task 4: Automation storage, operations and the editor list endpoint

**Files:**
- Create: `src/worker/auto/repo.ts`
- Create: `src/worker/routes-automations.ts`
- Modify: `src/worker/base/store.ts` (`schemaLike` public, `buttonsOf` hook, `schema()` returns `buttons`)
- Modify: `src/worker/base-do.ts` (repo, `monthlyRuns`, RPC `automationList`, `automationOp`, `automationRuns`, `Result.status`)
- Modify: `src/worker/access.ts` (`BaseStub` keys)
- Modify: `src/worker/env.ts` (`AUTOMATION_MONTHLY_RUNS`)
- Modify: `src/worker/index.ts` (mount the routes)
- Test: `test/worker/automations.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `validateAutomation`, `LIMITS`, `RECORD_TRIGGERS`, `triggerTableId`, `newAutomationId`, `newWebhookToken`; Task 2 `templateProblem`.
- Produces (from `src/worker/auto/repo.ts`): `NEVER`, `STALE_AFTER`, `RunRecord extends AutomationRun { snapshot: { name; config } }`, `NewRun`, `RunPatch`, class `AutomationRepo` with `onChange?: (id, now) => void`, `all()`, `get(id)`, `withLastRun()`, `buttons()`, `recordTriggers(tableId)`, `apply(actor, op, now): { id?: string }`, `timers()`, `setTimer(id, nextAt, watermark?)`, `earliestTimer()`, `insertRun(r: NewRun): number`, `enqueue(a, trigger, chain, now, monthlyLimit): number`, `getRun(id): RunRecord | undefined`, `runs(automationId, q): AutomationRun[]`, `saveRun(id, p: RunPatch)`, `dueRuns(now, limit): number[]`, `stale(before): number[]`, `nextRunAt(): number | null`, `usage(now): number`, `recordOutcome(id, failed): boolean`, `byToken(token)`.
- Produces (DO): `automations: AutomationRepo`, `monthlyRuns: number`, `automationList(origin)`, `automationOp(actor, op, origin)`, `automationRuns(id, q)`; `Result<T>` failure may carry `status?: number`.
- Produces (routes): `automationRoutes` (Hono), mounted at `/api`; `GET /api/bases/:base/automations`, `POST /api/bases/:base/automations`, `GET /api/bases/:base/automations/:id/runs`.
- Produces (store): `schemaLike()` public; `buttonsOf?: () => ButtonInfo[]`.

- [ ] **Step 1: Write the failing test**

`test/worker/automations.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import { addViewer, HttpClient, ownerWithBase } from "./helpers";

const actor = { userId: "u1", name: "Tester" };
const hookCfg = { trigger: { type: "webhook", token: "" }, steps: [] };

async function crm(prefix: string) {
  const o = await ownerWithBase(prefix);
  const { schema } = (await o.c.req("GET", `/api/bases/${o.baseId}`)).json;
  const deals = schema.tables.find((t: any) => t.name === "Deals");
  const field = (name: string) => schema.fields.find((f: any) => f.tableId === deals.id && f.name === name);
  return { ...o, schema, deals, field, url: `/api/bases/${o.baseId}/automations` };
}

describe("automation definitions", () => {
  it("editors create, list, rename and delete automations", async () => {
    const x = await crm("auto-crud");
    const step = { id: "s1", type: "http", method: "POST", url: "https://example.com/{{trigger.record." + x.field("Name").id + "}}", headers: [] };
    const created = await x.c.req("POST", x.url, { op: "create", name: "Notify", config: { trigger: { type: "recordCreated", tableId: x.deals.id }, steps: [step] } });
    expect(created.status).toBe(200);
    const id = created.json.id;
    expect(created.json.automations).toHaveLength(1);
    expect(created.json.automations[0]).toMatchObject({ id, name: "Notify", enabled: false, failStreak: 0, disabledReason: null, lastRun: null, createdBy: expect.any(String) });
    expect((await x.c.req("POST", x.url, { op: "update", id, name: "Notify team" })).status).toBe(200);
    const list = await x.c.req("GET", x.url);
    expect(list.json.automations[0].name).toBe("Notify team");
    expect(list.json.usage).toEqual({ used: 0, limit: 10000 });
    expect((await x.c.req("POST", x.url, { op: "delete", id })).status).toBe(200);
    expect((await x.c.req("GET", x.url)).json.automations).toEqual([]);
  });

  it("rejects invalid definitions with 400", async () => {
    const x = await crm("auto-invalid");
    const bad = await x.c.req("POST", x.url, { op: "create", name: "x", config: { trigger: { type: "recordCreated", tableId: "tblNope" }, steps: [] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("Unknown table tblNope");
    const ref = await x.c.req("POST", x.url, { op: "create", name: "x", config: { trigger: { type: "recordCreated", tableId: x.deals.id }, steps: [{ id: "s1", type: "http", method: "GET", url: "{{trigger.body.x}}", headers: [] }] } });
    expect(ref.json.error).toBe("Unknown reference {{trigger.body.x}}");
    expect((await x.c.req("POST", x.url, { op: "explode" })).json.error).toBe("Unknown automation operation");
  });

  it("assigns webhook tokens on the server and keeps them across edits", async () => {
    const x = await crm("auto-token");
    const r = await x.c.req("POST", x.url, { op: "create", name: "Hook", config: { trigger: { type: "webhook", token: "mine" }, steps: [] } });
    const token = r.json.automations[0].config.trigger.token;
    expect(token).toMatch(/^[A-Za-z0-9]{32}$/);
    await x.c.req("POST", x.url, { op: "update", id: r.json.id, config: { trigger: { type: "webhook", token: "other" }, steps: [] } });
    expect((await x.c.req("GET", x.url)).json.automations[0].config.trigger.token).toBe(token);
    await x.c.req("POST", x.url, { op: "regenerateWebhook", id: r.json.id });
    expect((await x.c.req("GET", x.url)).json.automations[0].config.trigger.token).not.toBe(token);
  });

  it("viewers cannot read definitions and the schema carries only button stubs", async () => {
    const x = await crm("auto-viewer");
    await x.c.req("POST", x.url, { op: "create", name: "Secret hook", config: hookCfg });
    await x.c.req("POST", x.url, { op: "create", name: "Approve", config: { trigger: { type: "button", tableId: x.deals.id, viewerCanRun: true }, steps: [] } });
    const viewer = new HttpClient(await addViewer(x.c, x.wsId, "auto-viewer-v@example.com"));
    expect((await viewer.req("GET", x.url)).status).toBe(403);
    expect((await viewer.req("POST", x.url, { op: "delete", id: "autX" })).status).toBe(403);
    const schema = (await viewer.req("GET", `/api/bases/${x.baseId}`)).json.schema;
    expect(schema.buttons).toEqual([{ id: expect.any(String), name: "Approve", tableId: x.deals.id, viewerCanRun: true, enabled: false }]);
    expect(JSON.stringify(schema)).not.toContain("Secret hook");
  });

  it("holds at most 50 automations per base", async () => {
    const x = await crm("auto-limit");
    for (let i = 0; i < 50; i++) expect((await x.c.req("POST", x.url, { op: "create", name: "A" + i, config: hookCfg })).status).toBe(200);
    expect((await x.c.req("POST", x.url, { op: "create", name: "One more", config: hookCfg })).json.error).toBe("A base holds at most 50 automations");
  });

  it("keeps 1,000 finished runs per automation and none older than 30 days, but never drops queued runs", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("auto-retention"));
    await runInDurableObject(stub, async (i: BaseDO) => {
      if (!i.store.initialized) i.store.init("auto-retention");
      const t = i.store.createTable(actor, { name: "T" }).tableId;
      const { id } = i.automations.apply(actor, { op: "create", name: "R", config: { trigger: { type: "recordCreated", tableId: t }, steps: [] } }, 0);
      const a = i.automations.get(id!);
      const day = 86_400_000;
      const trigger = { type: "recordCreated" as const, at: 0 };
      i.automations.insertRun({ automation: a, status: "skipped", trigger, chain: [], now: day });
      const queued = i.automations.insertRun({ automation: a, status: "queued", trigger, chain: [], now: day });
      for (let k = 0; k < 1001; k++) i.automations.insertRun({ automation: a, status: "skipped", trigger, chain: [], now: 40 * day });
      const runs = i.automations.runs(id!, { limit: 2000 });
      expect(runs.filter(r => r.status === "skipped")).toHaveLength(1000);
      expect(runs.some(r => r.id === queued)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project worker test/worker/automations.test.ts`
Expected: FAIL; the first tests get 404 from `/api/bases/:base/automations`, the retention test fails with "Cannot read properties of undefined (reading 'apply')".

- [ ] **Step 3: Write the implementation**

`src/worker/auto/repo.ts`:

```ts
// Automation definitions and runs, kept in the base's SQLite next to its tables.
import { generateKeyBetween } from "fractional-indexing";
import { UserError, type Actor, type BaseStore } from "../base/store";
import { LIMITS, RECORD_TRIGGERS, triggerTableId, validateAutomation, type Automation, type AutomationConfig, type AutomationOp, type AutomationRun, type ButtonInfo, type RunStatus, type StepLog, type TriggerInfo } from "../../shared/automations";
import { templateProblem } from "../../shared/template";
import { newAutomationId, newWebhookToken } from "../../shared/ids";

interface AutoRow {
  id: string;
  name: string;
  ord: string;
  enabled: number;
  config: string;
  created_by: string | null;
  updated_by: string | null;
  updated_at: number | null;
  fail_streak: number;
  disabled_reason: string | null;
}

interface RunRow {
  id: number;
  automation_id: string;
  status: string;
  test: number;
  snapshot: string;
  trigger_info: string;
  chain: string;
  steps: string;
  error: string | null;
  attempt: number;
  next_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface RunRecord extends AutomationRun {
  /** The definition when the run was queued; later edits do not change it. */
  snapshot: { name: string; config: AutomationConfig };
}

export interface NewRun {
  automation: Automation;
  status: "queued" | "running" | "skipped";
  test?: boolean;
  trigger: TriggerInfo;
  chain: string[];
  error?: string;
  now: number;
}

export interface RunPatch {
  status?: RunStatus;
  steps?: StepLog[];
  error?: string | null;
  attempt?: number;
  nextAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

/** next_at of an enabled timer with nothing ahead (a date trigger without future dates). */
export const NEVER = 8.64e15;
/** A run still marked running this long after it started was cut off (the object was evicted). */
export const STALE_AFTER = LIMITS.runTimeout + 30_000;
const DAY = 86_400_000;
const FINISHED = "('succeeded', 'failed', 'skipped')";
const monthKey = (now: number) => "autoUsage:" + new Date(now).toISOString().slice(0, 7);
const cleanName = (name: unknown, fallback = "Automation") => String(name ?? "").trim().slice(0, 100) || fallback;

export class AutomationRepo {
  private list?: Automation[];
  /** Called after a definition changes or is switched on or off, to reset its timer. */
  onChange?: (id: string, now: number) => void;

  constructor(private store: BaseStore) {
    const sql = store.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS _automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord TEXT NOT NULL, enabled INTEGER NOT NULL, config TEXT NOT NULL, created_by TEXT, updated_by TEXT, updated_at INTEGER, fail_streak INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT, next_at INTEGER, watermark INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS _auto_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, automation_id TEXT NOT NULL, status TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL, trigger_info TEXT NOT NULL, chain TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', error TEXT, attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS _auto_runs_due ON _auto_runs (status, next_at)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS _auto_runs_by ON _auto_runs (automation_id, id)`);
  }

  // ---------- definitions ----------

  private toAutomation(r: AutoRow): Automation {
    return {
      id: r.id,
      name: r.name,
      ord: r.ord,
      enabled: !!r.enabled,
      config: JSON.parse(r.config),
      createdBy: r.created_by,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      failStreak: r.fail_streak,
      disabledReason: r.disabled_reason === "failures" ? "failures" : null,
    };
  }

  all(): Automation[] {
    if (!this.list) this.list = this.store.all<AutoRow>("SELECT id, name, ord, enabled, config, created_by, updated_by, updated_at, fail_streak, disabled_reason FROM _automations ORDER BY ord").map(r => this.toAutomation(r));
    return this.list;
  }

  get(id: string): Automation {
    const a = this.all().find(x => x.id === id);
    if (!a) throw new UserError("Automation not found");
    return a;
  }

  byToken(token: string): Automation | undefined {
    return this.all().find(a => a.config.trigger.type === "webhook" && a.config.trigger.token === token);
  }

  /** Enabled automations whose trigger watches records of this table. */
  recordTriggers(tableId: string): Automation[] {
    return this.all().filter(a => a.enabled && RECORD_TRIGGERS.has(a.config.trigger.type) && triggerTableId(a.config.trigger) === tableId);
  }

  withLastRun(): Automation[] {
    const rows = this.store.all<{ automation_id: string; id: number; status: string; at: number }>(
      "SELECT automation_id, id, status, coalesce(finished_at, started_at, created_at) at FROM _auto_runs WHERE id IN (SELECT max(id) FROM _auto_runs WHERE test = 0 GROUP BY automation_id)",
    );
    const last = new Map(rows.map(r => [r.automation_id, r]));
    return this.all().map(a => {
      const r = last.get(a.id);
      return { ...a, lastRun: r ? { id: r.id, status: r.status as RunStatus, at: r.at } : null };
    });
  }

  buttons(): ButtonInfo[] {
    return this.all().flatMap(a => (a.config.trigger.type === "button" ? [{ id: a.id, name: a.name, tableId: a.config.trigger.tableId, viewerCanRun: a.config.trigger.viewerCanRun, enabled: a.enabled }] : []));
  }

  private checked(cfg: AutomationConfig): AutomationConfig {
    const s = this.store.schemaLike();
    const err = validateAutomation(cfg, s) ?? templateProblem(cfg, s);
    if (err) throw new UserError(err);
    return cfg;
  }

  /** Webhook tokens come from the server: a new one for a new webhook, the old one across edits. */
  private withToken(cfg: AutomationConfig, previous?: AutomationConfig): AutomationConfig {
    if (cfg?.trigger?.type !== "webhook") return cfg;
    const token = previous?.trigger.type === "webhook" ? previous.trigger.token : newWebhookToken();
    return { ...cfg, trigger: { type: "webhook", token } };
  }

  private changed(id: string, now: number) {
    this.list = undefined;
    this.onChange?.(id, now);
  }

  apply(actor: Actor, op: AutomationOp, now: number): { id?: string } {
    const sql = this.store.sql;
    switch (op?.op) {
      case "create": {
        if (this.all().length >= LIMITS.automations) throw new UserError(`A base holds at most ${LIMITS.automations} automations`);
        const config = this.checked(this.withToken(op.config));
        const id = newAutomationId();
        const ord = generateKeyBetween(this.all().at(-1)?.ord ?? null, null);
        sql.exec("INSERT INTO _automations (id, name, ord, enabled, config, created_by, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, cleanName(op.name), ord, op.enabled ? 1 : 0, JSON.stringify(config), actor.userId, actor.userId, now);
        this.changed(id, now);
        return { id };
      }
      case "update": {
        const a = this.get(op.id);
        const config = op.config ? this.checked(this.withToken(op.config, a.config)) : a.config;
        const name = op.name !== undefined ? cleanName(op.name, a.name) : a.name;
        const ord = op.ord !== undefined ? String(op.ord) : a.ord;
        sql.exec("UPDATE _automations SET name = ?, ord = ?, config = ?, updated_by = ?, updated_at = ? WHERE id = ?", name, ord, JSON.stringify(config), actor.userId, now, a.id);
        this.changed(a.id, now);
        return { id: a.id };
      }
      case "delete":
        this.get(op.id);
        sql.exec("DELETE FROM _automations WHERE id = ?", op.id);
        sql.exec("DELETE FROM _auto_runs WHERE automation_id = ?", op.id);
        this.list = undefined;
        return {};
      case "setEnabled": {
        const a = this.get(op.id);
        // The schema may have changed since the automation was saved.
        if (op.enabled) this.checked(a.config);
        const on = op.enabled ? 1 : 0;
        sql.exec(
          "UPDATE _automations SET enabled = ?, fail_streak = CASE WHEN ? = 1 THEN 0 ELSE fail_streak END, disabled_reason = CASE WHEN ? = 1 THEN NULL ELSE disabled_reason END, updated_by = ?, updated_at = ? WHERE id = ?",
          on, on, on, actor.userId, now, a.id,
        );
        this.changed(a.id, now);
        return { id: a.id };
      }
      case "regenerateWebhook": {
        const a = this.get(op.id);
        if (a.config.trigger.type !== "webhook") throw new UserError("This automation has no webhook");
        const config: AutomationConfig = { ...a.config, trigger: { type: "webhook", token: newWebhookToken() } };
        sql.exec("UPDATE _automations SET config = ?, updated_by = ?, updated_at = ? WHERE id = ?", JSON.stringify(config), actor.userId, now, a.id);
        this.list = undefined;
        return { id: a.id };
      }
      default:
        throw new UserError("Unknown automation operation");
    }
  }

  /** Counts failed runs in a row and switches the automation off at the limit. Returns true when it was switched off now. */
  recordOutcome(id: string, failed: boolean): boolean {
    const a = this.all().find(x => x.id === id);
    if (!a) return false;
    const streak = failed ? a.failStreak + 1 : 0;
    const disable = failed && a.enabled && streak >= LIMITS.failures;
    if (streak === a.failStreak && !disable) return false;
    this.store.sql.exec(
      "UPDATE _automations SET fail_streak = ?, enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END, disabled_reason = CASE WHEN ? = 1 THEN 'failures' ELSE disabled_reason END WHERE id = ?",
      streak, disable ? 1 : 0, disable ? 1 : 0, id,
    );
    this.list = undefined;
    return disable;
  }

  // ---------- timers (schedules and date triggers) ----------

  timers(): { automation: Automation; nextAt: number | null; watermark: number | null }[] {
    const rows = new Map(this.store.all<{ id: string; next_at: number | null; watermark: number | null }>("SELECT id, next_at, watermark FROM _automations WHERE enabled = 1").map(r => [r.id, r]));
    return this.all()
      .filter(a => a.enabled && rows.has(a.id) && (a.config.trigger.type === "schedule" || a.config.trigger.type === "dateReached"))
      .map(a => ({ automation: a, nextAt: rows.get(a.id)!.next_at, watermark: rows.get(a.id)!.watermark }));
  }

  setTimer(id: string, nextAt: number | null, watermark?: number | null) {
    if (watermark === undefined) this.store.sql.exec("UPDATE _automations SET next_at = ? WHERE id = ?", nextAt, id);
    else this.store.sql.exec("UPDATE _automations SET next_at = ?, watermark = ? WHERE id = ?", nextAt, watermark, id);
  }

  /** Earliest timer of an enabled schedule or date trigger; 0 when one has not been computed yet. */
  earliestTimer(): number | null {
    const r = this.store.one<{ t: number | null }>(
      "SELECT min(coalesce(next_at, 0)) t FROM _automations WHERE enabled = 1 AND json_extract(config, '$.trigger.type') IN ('schedule', 'dateReached') AND coalesce(next_at, 0) < ?",
      NEVER,
    );
    return r?.t ?? null;
  }

  // ---------- runs ----------

  private toRun(r: RunRow): RunRecord {
    return {
      id: r.id,
      automationId: r.automation_id,
      status: r.status as RunStatus,
      test: !!r.test,
      trigger: JSON.parse(r.trigger_info),
      chain: JSON.parse(r.chain),
      steps: JSON.parse(r.steps),
      error: r.error,
      attempt: r.attempt,
      nextAt: r.next_at,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      snapshot: JSON.parse(r.snapshot),
    };
  }

  insertRun(r: NewRun): number {
    const id = this.store.one<{ id: number }>(
      "INSERT INTO _auto_runs (automation_id, status, test, snapshot, trigger_info, chain, error, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      r.automation.id, r.status, r.test ? 1 : 0, JSON.stringify({ name: r.automation.name, config: r.automation.config }), JSON.stringify(r.trigger), JSON.stringify(r.chain),
      r.error ?? null, r.now, r.status === "running" ? r.now : null, r.status === "skipped" ? r.now : null,
    )!.id;
    this.prune(r.automation.id, r.now);
    return id;
  }

  /** Queues a run, or records a skipped one when the month's quota is used up (0 means no quota). */
  enqueue(a: Automation, trigger: TriggerInfo, chain: string[], now: number, monthlyLimit: number): number {
    if (monthlyLimit > 0 && this.usage(now) >= monthlyLimit) {
      return this.insertRun({ automation: a, status: "skipped", trigger, chain, error: `This base used its ${monthlyLimit.toLocaleString("en-US")} automation runs for this month`, now });
    }
    this.store.setMeta(monthKey(now), String(this.usage(now) + 1));
    return this.insertRun({ automation: a, status: "queued", trigger, chain, now });
  }

  /** Finished runs older than 30 days or past the newest 1,000 of an automation are deleted; pending runs stay. */
  private prune(automationId: string, now: number) {
    this.store.sql.exec(`DELETE FROM _auto_runs WHERE automation_id = ? AND status IN ${FINISHED} AND created_at < ?`, automationId, now - LIMITS.runDays * DAY);
    const cut = this.store.one<{ id: number }>(`SELECT id FROM _auto_runs WHERE automation_id = ? AND status IN ${FINISHED} ORDER BY id DESC LIMIT 1 OFFSET ?`, automationId, LIMITS.runsKept);
    if (cut) this.store.sql.exec(`DELETE FROM _auto_runs WHERE automation_id = ? AND status IN ${FINISHED} AND id <= ?`, automationId, cut.id);
  }

  getRun(id: number): RunRecord | undefined {
    const r = this.store.one<RunRow>("SELECT * FROM _auto_runs WHERE id = ?", id);
    return r ? this.toRun(r) : undefined;
  }

  runs(automationId: string, q: { status?: string; before?: number; limit: number }): AutomationRun[] {
    const where = ["automation_id = ?"];
    const params: unknown[] = [automationId];
    if (q.status) { where.push("status = ?"); params.push(q.status); }
    if (q.before) { where.push("id < ?"); params.push(q.before); }
    return this.store.all<RunRow>(`SELECT * FROM _auto_runs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...params, q.limit).map(r => {
      const { snapshot: _, ...run } = this.toRun(r);
      return run;
    });
  }

  saveRun(id: number, p: RunPatch) {
    const cols: [string, unknown][] = [];
    if (p.status !== undefined) cols.push(["status", p.status]);
    if (p.steps !== undefined) cols.push(["steps", JSON.stringify(p.steps)]);
    if (p.error !== undefined) cols.push(["error", p.error]);
    if (p.attempt !== undefined) cols.push(["attempt", p.attempt]);
    if (p.nextAt !== undefined) cols.push(["next_at", p.nextAt]);
    if (p.startedAt !== undefined) cols.push(["started_at", p.startedAt]);
    if (p.finishedAt !== undefined) cols.push(["finished_at", p.finishedAt]);
    if (!cols.length) return;
    this.store.sql.exec(`UPDATE _auto_runs SET ${cols.map(([c]) => c + " = ?").join(", ")} WHERE id = ?`, ...(cols.map(([, v]) => v) as SqlStorageValue[]), id);
  }

  dueRuns(now: number, limit: number): number[] {
    return this.store.all<{ id: number }>("SELECT id FROM _auto_runs WHERE status = 'queued' OR (status = 'waiting_retry' AND next_at <= ?) ORDER BY id LIMIT ?", now, limit).map(r => r.id);
  }

  /** Runs marked running since before `before` (cut off by an eviction). Test runs answer a request and are not resumed. */
  stale(before: number): number[] {
    return this.store.all<{ id: number }>("SELECT id FROM _auto_runs WHERE status = 'running' AND test = 0 AND started_at < ?", before).map(r => r.id);
  }

  /** When pending runs need the alarm: now for queued ones, their retry time, or when a running one counts as cut off. */
  nextRunAt(): number | null {
    const r = this.store.one<{ t: number | null }>(
      "SELECT min(CASE status WHEN 'queued' THEN 0 WHEN 'waiting_retry' THEN next_at ELSE started_at + ? END) t FROM _auto_runs WHERE status IN ('queued', 'waiting_retry') OR (status = 'running' AND test = 0)",
      STALE_AFTER,
    );
    return r?.t ?? null;
  }

  usage(now: number): number {
    return Number(this.store.meta(monthKey(now)) ?? "0");
  }
}
```

`src/worker/base/store.ts`:
- Add `ButtonInfo` to the imports: `import type { ButtonInfo } from "../../shared/automations";`
- Add to the class fields, after `onSchemaChange?: () => void;`:

```ts
  /** Button stubs for the schema; set by the Durable Object. */
  buttonsOf?: () => ButtonInfo[];
```

- Change `private schemaLike()` to `schemaLike()` (dashboards keep using it).
- In `schema()`, add `buttons: this.buttonsOf?.() ?? []` after `dashboards: [...c.dashboards.values()],`.

`src/worker/env.ts`, add to `Env`:

```ts
  /** Automation runs per base per month; "0" means no limit. Default 10000. */
  AUTOMATION_MONTHLY_RUNS?: string;
```

`src/worker/base-do.ts`:
- Imports:

```ts
import { AutomationRepo } from "./auto/repo";
import { LIMITS, type Automation, type AutomationOp, type AutomationRun } from "../shared/automations";
```

- Replace the `Result` type:

```ts
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };
```

- Fields and constructor (after `this.importer = ...`):

```ts
  automations: AutomationRepo;
  /** Monthly run quota; tests lower it. */
  monthlyRuns: number;
```

```ts
    this.automations = new AutomationRepo(this.store);
    this.store.buttonsOf = () => this.automations.buttons();
    const quota = env.AUTOMATION_MONTHLY_RUNS;
    this.monthlyRuns = quota === undefined || quota === "" ? LIMITS.monthlyRuns : Math.max(0, Number(quota) || 0);
```

- A new section before `// ---------- jobs ----------`:

```ts
  // ---------- automations ----------

  automationList(origin: string): { automations: Automation[]; usage: { used: number; limit: number }; origin: string } {
    this.store.setMeta("origin", origin);
    return { automations: this.automations.withLastRun(), usage: { used: this.automations.usage(Date.now()), limit: this.monthlyRuns }, origin };
  }

  async automationOp(actor: Actor, op: AutomationOp, origin: string): Promise<Result<{ id?: string; automations: Automation[] }>> {
    this.store.setMeta("origin", origin);
    const res = this.safe(() => this.automations.apply(actor, op, Date.now()));
    if (!res.ok) return res;
    // Button stubs travel with the schema; editors refetch definitions on "automations".
    this.broadcast({ type: "schema", schema: this.store.schema() });
    this.broadcast({ type: "automations" });
    return { ok: true, value: { id: res.value.id, automations: this.automations.withLastRun() } };
  }

  automationRuns(id: string, q: { status?: string; before?: number; limit: number }): Result<AutomationRun[]> {
    return this.safe(() => {
      this.automations.get(id);
      return this.automations.runs(id, q);
    });
  }
```

`src/worker/access.ts`: add `"automationList" | "automationOp" | "automationRuns"` to the `BaseStub` key union.

`src/worker/routes-automations.ts`:

```ts
// Automation routes: definitions and runs for editors, webhooks, and workspace mail settings.
import { Hono } from "hono";
import { baseAccess, HttpError, ROLE_RANK, type AppContext, type Vars } from "./access";
import type { Env } from "./env";
import type { AutomationOp } from "../shared/automations";

export const automationRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

async function body<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string; status?: number }): T {
  if (!r.ok) throw new HttpError(r.status ?? 400, r.error);
  return r.value;
}

const origin = (c: AppContext) => c.env.APP_URL || new URL(c.req.url).origin;

/** Editors and owners may read definitions and runs, also after a trial ends. */
async function editorAccess(c: AppContext, baseId: string) {
  const a = await baseAccess(c, baseId, "read");
  if (ROLE_RANK[a.role] < ROLE_RANK.editor) throw new HttpError(403, "Only editors can see automations");
  return a;
}

automationRoutes.get("/bases/:base/automations", async c => {
  const a = await editorAccess(c, c.req.param("base"));
  return c.json(await a.stub.automationList(origin(c)));
});

automationRoutes.post("/bases/:base/automations", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<AutomationOp>(c);
  return c.json(unwrap(await a.stub.automationOp(a.actor, b, origin(c))));
});

automationRoutes.get("/bases/:base/automations/:id/runs", async c => {
  const a = await editorAccess(c, c.req.param("base"));
  const q = c.req.query();
  return c.json(unwrap(await a.stub.automationRuns(c.req.param("id"), { status: q.status || undefined, before: q.before ? Number(q.before) : undefined, limit: Math.min(100, Math.max(1, Number(q.limit) || 50)) })));
});
```

`src/worker/index.ts`: add `import { automationRoutes } from "./routes-automations";` and, before `app.route("/api/v1", apiV1);`:

```ts
app.route("/api", automationRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project worker test/worker/automations.test.ts && npm run typecheck`
Expected: PASS (6 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: all existing tests still pass. Record in the ledger: `Task 4: automations.test.ts 6/6, suite <N>/<N>`.

---

### Task 5: Record trigger detection

**Files:**
- Create: `src/worker/auto/triggers.ts`
- Modify: `src/worker/base/store.ts` (write tracking, `onWrite`, `withWriteContext`, `noTriggers`, `matchRows`, `matchSnapshots`)
- Modify: `src/worker/base-do.ts` (`RowOp` `source`, hook wiring)
- Modify: `src/worker/airtable.ts:235,315,345`, `src/worker/templates.ts:340` (`noTriggers: true`)
- Modify: `src/web/base/Imports.tsx:77` (`source: "import"`)
- Test: `test/worker/automation-triggers.test.ts`

**Interfaces:**
- Consumes: `AutomationRepo.recordTriggers`, `AutomationRepo.enqueue` (Task 4); `LIMITS.chain`.
- Produces (store): `WrittenRow { tableId; id; isNew; before: { data: string; createdAt: number; updatedAt: number } | null; changed: Set<string> }`, `WriteInfo { actor; rows: WrittenRow[]; chain: string[] }`, `onWrite?: (w: WriteInfo) => void`, `withWriteContext<T>(c: { chain: string[]; silent?: boolean }, fn: () => T): T`, `createRows`/`updateRows` option `noTriggers?: boolean`, `matchRows(tableId, filters, ids): number[]`, `matchSnapshots(tableId, filters, snaps): number[]`.
- Produces: `detectTriggers(store, repo, w: WriteInfo, now, monthlyLimit): number` (runs queued); `RowOp` create `source?: "import"`.

- [ ] **Step 1: Write the failing test**

`test/worker/automation-triggers.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { AutomationConfig } from "../../src/shared/automations";
import { ownerWithBase } from "./helpers";

const actor = { userId: "u1", name: "Tester" };

async function withDO<R>(name: string, fn: (i: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    return fn(i);
  });
}

/** A Tasks table with Name, Status (Todo, Done) and Points. */
function setup(i: BaseDO) {
  const s = i.store;
  const t = s.createTable(actor, {
    name: "Tasks",
    fields: [
      { name: "Name", type: "text" },
      { name: "Status", type: "singleSelect", options: { choices: [{ id: "chTodo", name: "Todo", color: "#eee" }, { id: "chDone", name: "Done", color: "#eee" }] } },
      { name: "Points", type: "number" },
    ],
  }).tableId;
  const f = (n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
  const F = { name: f("Name"), status: f("Status"), points: f("Points") };
  const add = (config: AutomationConfig, name = "A") => i.automations.apply(actor, { op: "create", name, config, enabled: true }, Date.now()).id!;
  const runsOf = (id: string) => i.automations.runs(id, { limit: 100 });
  const create = (cells: Record<string, unknown>) => s.createRows(actor, t, [{ cells }]).changes.find(c => c.tableId === t)!.rows[0].id;
  return { s, t, F, add, runsOf, create };
}

const isDone = (F: { status: string }) => ({ conjunction: "and" as const, conditions: [{ fieldId: F.status, op: "eq" as const, value: "chDone" }] });

describe("record triggers", () => {
  it("recordCreated queues one run per created record that matches", async () => {
    await withDO("trg-created", i => {
      const { t, F, add, runsOf, s } = setup(i);
      const id = add({ trigger: { type: "recordCreated", tableId: t, conditions: isDone(F) }, steps: [] });
      s.createRows(actor, t, [{ cells: { [F.status]: "chDone" } }, { cells: { [F.status]: "chTodo" } }, { cells: { [F.status]: "chDone" } }]);
      const runs = runsOf(id);
      expect(runs).toHaveLength(2);
      expect(runs.every(r => r.status === "queued" && r.trigger.type === "recordCreated" && r.trigger.by === "u1" && r.trigger.tableId === t)).toBe(true);
      expect(runs[0].chain).toEqual([id]);
    });
  });

  it("recordUpdated fires only for the watched fields and only on real changes", async () => {
    await withDO("trg-updated", i => {
      const { t, F, add, runsOf, s, create } = setup(i);
      const id = add({ trigger: { type: "recordUpdated", tableId: t, fieldIds: [F.status] }, steps: [] });
      const rid = create({ [F.name]: "a" });
      s.updateRows(actor, t, [{ id: rid, cells: { [F.name]: "b" } }]);
      expect(runsOf(id)).toHaveLength(0);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chDone" } }]);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chDone" } }]);
      expect(runsOf(id).map(r => r.trigger.recordId)).toEqual([rid]);
    });
  });

  it("recordMatches fires when a record starts to match, not while it keeps matching", async () => {
    await withDO("trg-matches", i => {
      const { t, F, add, runsOf, s, create } = setup(i);
      const id = add({ trigger: { type: "recordMatches", tableId: t, conditions: isDone(F) }, steps: [] });
      const rid = create({ [F.status]: "chTodo" });
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chDone" } }]);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.points]: 3 } }]);
      expect(runsOf(id)).toHaveLength(1);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chTodo" } }]);
      s.updateRows(actor, t, [{ id: rid, cells: { [F.status]: "chDone" } }]);
      expect(runsOf(id)).toHaveLength(2);
      create({ [F.status]: "chDone" });
      expect(runsOf(id)).toHaveLength(3);
    });
  });

  it("disabled automations, imports and silent writes do not fire", async () => {
    await withDO("trg-quiet", i => {
      const { t, F, add, runsOf, s } = setup(i);
      const id = add({ trigger: { type: "recordCreated", tableId: t }, steps: [] });
      s.createRows(actor, t, [{ cells: { [F.name]: "imported" } }], { noTriggers: true });
      s.withWriteContext({ chain: [], silent: true }, () => s.createRows(actor, t, [{ cells: { [F.name]: "test run" } }]));
      i.automations.apply(actor, { op: "setEnabled", id, enabled: false }, Date.now());
      s.createRows(actor, t, [{ cells: { [F.name]: "while off" } }]);
      expect(runsOf(id)).toHaveLength(0);
    });
  });

  it("an automation does not trigger itself through its own writes, and chains stop at 5", async () => {
    await withDO("trg-chain", i => {
      const { t, F, add, runsOf, s, create } = setup(i);
      const self = add({ trigger: { type: "recordUpdated", tableId: t }, steps: [] }, "Self");
      const rid = create({ [F.name]: "x" });
      s.withWriteContext({ chain: [self] }, () => s.updateRows(actor, t, [{ id: rid, cells: { [F.name]: "y" } }]));
      expect(runsOf(self)).toHaveLength(0);
      s.withWriteContext({ chain: ["a1", "a2", "a3", "a4"] }, () => s.updateRows(actor, t, [{ id: rid, cells: { [F.name]: "z" } }]));
      expect(runsOf(self).map(r => r.chain)).toEqual([["a1", "a2", "a3", "a4", self]]);
      s.withWriteContext({ chain: ["a1", "a2", "a3", "a4", "a5"] }, () => s.updateRows(actor, t, [{ id: rid, cells: { [F.name]: "w" } }]));
      expect(runsOf(self)).toHaveLength(1);
    });
  });

  it("only rows written directly fire, not linked rows updated as a side effect", async () => {
    await withDO("trg-direct", i => {
      const { t, F, add, runsOf, s, create } = setup(i);
      const other = s.createTable(actor, { name: "Projects", fields: [{ name: "Name", type: "text" }] }).tableId;
      const link = s.createField(t, { name: "Project", type: "link", options: { linkedTableId: other } }).fieldId;
      const pid = s.createRows(actor, other, [{ cells: {} }]).changes.find(c => c.tableId === other)!.rows[0].id;
      const id = add({ trigger: { type: "recordUpdated", tableId: other }, steps: [] });
      const rid = create({ [F.name]: "x" });
      s.updateRows(actor, t, [{ id: rid, cells: { [link]: [pid] } }]);
      expect(runsOf(id)).toHaveLength(0);
    });
  });

  it("over the monthly quota, runs are recorded as skipped", async () => {
    await withDO("trg-quota", i => {
      const { t, add, runsOf, s } = setup(i);
      i.monthlyRuns = 2;
      const id = add({ trigger: { type: "recordCreated", tableId: t }, steps: [] });
      s.createRows(actor, t, [{ cells: {} }, { cells: {} }, { cells: {} }]);
      expect(runsOf(id).map(r => r.status).sort()).toEqual(["queued", "queued", "skipped"]);
      expect(runsOf(id).find(r => r.status === "skipped")!.error).toBe("This base used its 2 automation runs for this month");
    });
  });

  it("CSV import does not fire, the rows endpoint does", async () => {
    const x = await ownerWithBase("trg-http");
    const { schema } = (await x.c.req("GET", `/api/bases/${x.baseId}`)).json;
    const deals = schema.tables.find((t: any) => t.name === "Deals");
    const r = await x.c.req("POST", `/api/bases/${x.baseId}/automations`, { op: "create", name: "New deal", enabled: true, config: { trigger: { type: "recordCreated", tableId: deals.id }, steps: [] } });
    await x.c.req("POST", `/api/bases/${x.baseId}/rows`, { op: "create", tableId: deals.id, rows: [{ cells: {} }], source: "import" });
    await x.c.req("POST", `/api/bases/${x.baseId}/rows`, { op: "create", tableId: deals.id, rows: [{ cells: {} }] });
    const runs = await x.c.req("GET", `/api/bases/${x.baseId}/automations/${r.json.id}/runs`);
    expect(runs.json).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project worker test/worker/automation-triggers.test.ts`
Expected: FAIL; runs lists are empty (no detection yet) and `s.withWriteContext is not a function`.

- [ ] **Step 3: Write the implementation**

`src/worker/base/store.ts`:

1. Add `FilterSpec` to the type import from `../../shared/types`.
2. After the `MutationResult` interface, add:

```ts
/** A row a write touched directly, with its stored state before the write (null for new rows). */
export interface WrittenRow {
  tableId: string;
  id: number;
  isNew: boolean;
  before: { data: string; createdAt: number; updatedAt: number } | null;
  /** Field ids whose values changed, computed fields of the same row included. */
  changed: Set<string>;
}

export interface WriteInfo {
  actor: Actor;
  rows: WrittenRow[];
  /** Automations that led to this write (empty for people). */
  chain: string[];
}
```

3. `RowRec` gets `orig?: { data: string; createdAt: number; updatedAt: number };` and `parseRec` sets it:

```ts
      orig: { data: r.data as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number },
```

4. `Tx` gets:

```ts
  /** Per row key, the fields whose values changed. */
  fields = new Map<string, Set<string>>();
  noTriggers = false;
```

5. Class fields after `buttonsOf`:

```ts
  /** Called inside each write's transaction with the rows it touched directly, so automation runs are queued atomically. */
  onWrite?: (w: WriteInfo) => void;
  private writeCtx: { chain: string[]; silent: boolean } = { chain: [], silent: false };

  /** Writes made inside fn carry this automation chain; silent writes (test runs) fire no triggers. */
  withWriteContext<T>(c: { chain: string[]; silent?: boolean }, fn: () => T): T {
    const prev = this.writeCtx;
    this.writeCtx = { chain: c.chain, silent: !!c.silent };
    try {
      return fn();
    } finally {
      this.writeCtx = prev;
    }
  }
```

6. Add a helper next to `markChanged`, and call it from `markChanged` and `propagate`:

```ts
  private noteField(tx: Tx, k: string, fieldId: string) {
    let s = tx.fields.get(k);
    if (!s) tx.fields.set(k, (s = new Set()));
    s.add(fieldId);
  }
```

In `markChanged`, after `(force ? p.force : p.changed).add(fieldId);`:

```ts
    if (!force && fieldId !== "__new") this.noteField(tx, k, fieldId);
```

In `propagate`, inside `if (!same(next, r.data[f.id])) {`, after `changed.add(f.id);`:

```ts
          this.noteField(tx, k, f.id);
```

7. Replace `run`:

```ts
  private run(actor: Actor | undefined, fn: (tx: Tx) => void): MutationResult {
    let out!: MutationResult;
    this.storage.transactionSync(() => {
      const tx = new Tx();
      fn(tx);
      this.propagate(tx);
      out = this.flush(tx, actor);
      if (actor && !tx.noTriggers && !this.writeCtx.silent && this.onWrite) this.onWrite(this.written(tx, actor));
    });
    this.aggCache.clear();
    return out;
  }

  private written(tx: Tx, actor: Actor): WriteInfo {
    const rows: WrittenRow[] = [];
    for (const [k, r] of tx.rows) {
      if (!r.touched) continue;
      rows.push({ tableId: k.slice(0, k.lastIndexOf(":")), id: r.id, isNew: !r.orig, before: r.orig ?? null, changed: tx.fields.get(k) ?? new Set() });
    }
    return { actor, rows, chain: this.writeCtx.chain };
  }
```

8. `createRows` options become `{ afterId?: number; beforeId?: number; typecast?: boolean; noTriggers?: boolean }` and its `run` callback starts with `tx.noTriggers = !!opts.noTriggers;`. `updateRows` options become `{ typecast?: boolean; noTriggers?: boolean }` with the same first line.

9. After `aggregateRecords`, add:

```ts
  /** Ids among `ids` whose current values match the filter, in the given order; all of them without a filter. */
  matchRows(tableId: string, filters: FilterSpec | undefined, ids: number[]): number[] {
    if (!ids.length) return [];
    const f = filterSql(filters, this.fieldMap(tableId));
    if (!f) return ids;
    const t = this.table(tableId);
    const hit = new Set(this.all<{ id: number }>(`SELECT id FROM ${t.phys} WHERE id IN (SELECT value FROM json_each(?)) AND ${f.sql}`, JSON.stringify(ids), ...f.params).map(r => r.id));
    return ids.filter(id => hit.has(id));
  }

  /** The same test against earlier versions of rows (data as stored JSON text), with the view filter SQL. */
  matchSnapshots(tableId: string, filters: FilterSpec | undefined, snaps: { id: number; data: string; createdAt: number; updatedAt: number }[]): number[] {
    if (!snaps.length) return [];
    const f = filterSql(filters, this.fieldMap(tableId));
    if (!f) return snaps.map(s => s.id);
    const json = "[" + snaps.map(s => `{"id":${s.id},"data":${s.data},"c":${s.createdAt},"u":${s.updatedAt}}`).join(",") + "]";
    const hit = new Set(
      this.all<{ id: number }>(
        `WITH s AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.data') AS data, json_extract(value, '$.c') AS created_at, json_extract(value, '$.u') AS updated_at FROM json_each(?)) SELECT id FROM s WHERE ${f.sql}`,
        json, ...f.params,
      ).map(r => r.id),
    );
    return snaps.map(s => s.id).filter(id => hit.has(id));
  }
```

`src/worker/auto/triggers.ts`:

```ts
// Finds the record triggers a write fires and queues their runs, inside the write's transaction.
import type { BaseStore, WriteInfo, WrittenRow } from "../base/store";
import { LIMITS, type Automation } from "../../shared/automations";
import type { AutomationRepo } from "./repo";

/** Record ids of `rows` that fire this automation's trigger. */
function firing(store: BaseStore, a: Automation, rows: WrittenRow[]): number[] {
  const t = a.config.trigger;
  if (t.type === "recordCreated") return store.matchRows(t.tableId, t.conditions, rows.filter(r => r.isNew).map(r => r.id));
  if (t.type === "recordUpdated") {
    const watch = t.fieldIds?.length ? new Set(t.fieldIds) : null;
    const ids = rows.filter(r => !r.isNew && (watch ? [...r.changed].some(f => watch.has(f)) : r.changed.size > 0)).map(r => r.id);
    return store.matchRows(t.tableId, t.conditions, ids);
  }
  if (t.type === "recordMatches") {
    const now = store.matchRows(t.tableId, t.conditions, rows.map(r => r.id));
    const nowSet = new Set(now);
    const earlier = rows.filter(r => r.before && nowSet.has(r.id)).map(r => ({ id: r.id, ...r.before! }));
    const before = new Set(store.matchSnapshots(t.tableId, t.conditions, earlier));
    return now.filter(id => !before.has(id));
  }
  return [];
}

/** Queues a run per fired trigger and record. A broken automation is skipped, never the write. */
export function detectTriggers(store: BaseStore, repo: AutomationRepo, w: WriteInfo, now: number, monthlyLimit: number): number {
  let queued = 0;
  const byTable = new Map<string, WrittenRow[]>();
  for (const r of w.rows) byTable.set(r.tableId, [...(byTable.get(r.tableId) ?? []), r]);
  for (const [tableId, rows] of byTable) {
    for (const a of repo.recordTriggers(tableId)) {
      if (w.chain.length >= LIMITS.chain || w.chain.includes(a.id)) continue;
      let ids: number[];
      try {
        ids = firing(store, a, rows);
      } catch (e) {
        console.error("automation trigger check failed", a.id, e);
        continue;
      }
      for (const id of ids) {
        repo.enqueue(a, { type: a.config.trigger.type, tableId, recordId: id, at: now, by: w.actor.userId }, [...w.chain, a.id], now, monthlyLimit);
        queued++;
      }
    }
  }
  return queued;
}
```

`src/worker/base-do.ts`:
- `RowOp` create member gains `source?: "import"`, and the `create` case passes `noTriggers: op.source === "import"` to `createRows`.
- Import `detectTriggers` from `./auto/triggers` and, at the end of the constructor:

```ts
    this.store.onWrite = w => detectTriggers(this.store, this.automations, w, Date.now(), this.monthlyRuns);
```

`src/worker/airtable.ts`: add `noTriggers: true` to the options of the three store calls (lines 235, 315, 345; line 315 gets a new options object `{ noTriggers: true }`).

`src/worker/templates.ts:340`: `{ typecast: true, noTriggers: true }`.

`src/web/base/Imports.tsx:77`: add `source: "import"` to the posted body.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project worker test/worker/automation-triggers.test.ts && npm run typecheck`
Expected: PASS (8 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: whole suite passes. Record in the ledger: `Task 5: automation-triggers.test.ts 8/8, suite <N>/<N>`.

---

### Task 6: Run executor

**Files:**
- Create: `src/worker/auto/types.ts`
- Create: `src/worker/auto/executor.ts`
- Modify: `src/worker/base/store.ts` (`MutationResult.created`, `maybeTable`, `maybeField`, `memberName`)
- Test: `test/worker/automation-executor.test.ts`

**Interfaces:**
- Consumes: `RunRecord` (Task 4); `withWriteContext`, `createRows`, `updateRows`, `query`, `getRows` (store); Task 2 `renderText`, `renderValue`, `TemplateContext`, `TemplateEnv`.
- Produces (from `src/worker/auto/types.ts`): `HttpRequest { method; url; headers: [string, string][]; body? }`, `HttpResult { status; headers: Record<string,string>; body: string }`, `MailRequest { provider; to: string[]; cc: string[]; subject; body; format }`, `Net { http(req, timeoutMs); email(req, timeoutMs) }`, `class StepError(message, retry = false, output?)`, `NO_NET`.
- Produces (from `src/worker/auto/executor.ts`): `RunOutcome { status: "succeeded" | "failed" | "waiting_retry"; steps: StepLog[]; error: string | null; nextAt: number | null; results: MutationResult[] }`, `ExecutorDeps { store; net; baseUrl; now; onStep? }`, `executeRun(run: RunRecord, d: ExecutorDeps): Promise<RunOutcome>`, `templateEnv(store)`, `compareValues(op, left, right)`.
- Produces (store): `MutationResult.created?: number[]` (ids made by `createRows`, in order), `maybeTable(id)`, `maybeField(id)`, `memberName(id)`.

- [ ] **Step 1: Write the failing test**

`test/worker/automation-executor.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { AutomationConfig, StepLog, TriggerInfo } from "../../src/shared/automations";
import { executeRun } from "../../src/worker/auto/executor";
import type { HttpRequest, HttpResult, MailRequest, Net } from "../../src/worker/auto/types";

const actor = { userId: "u1", name: "Tester" };

async function withDO<R>(name: string, fn: (i: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    return fn(i);
  });
}

function fakeNet(http?: (r: HttpRequest) => HttpResult) {
  const calls = { http: [] as HttpRequest[], email: [] as MailRequest[] };
  const net: Net = {
    async http(r) {
      calls.http.push(r);
      return http ? http(r) : { status: 200, headers: {}, body: '{"ok":true}' };
    },
    async email(r) {
      calls.email.push(r);
      return { messageId: "m1" };
    },
  };
  return { net, calls };
}

/** Tasks (Name, Status, Points) and Log (Message, Task linking to Tasks). */
function setup(i: BaseDO) {
  const s = i.store;
  const tasks = s.createTable(actor, {
    name: "Tasks",
    fields: [
      { name: "Name", type: "text" },
      { name: "Status", type: "singleSelect", options: { choices: [{ id: "chTodo", name: "Todo", color: "#eee" }, { id: "chDone", name: "Done", color: "#eee" }] } },
      { name: "Points", type: "number" },
    ],
  }).tableId;
  const log = s.createTable(actor, { name: "Log", fields: [{ name: "Message", type: "text" }] }).tableId;
  const link = s.createField(log, { name: "Task", type: "link", options: { linkedTableId: tasks } }).fieldId;
  const f = (t: string, n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
  const F = { name: f(tasks, "Name"), status: f(tasks, "Status"), points: f(tasks, "Points"), message: f(log, "Message"), link };
  const add = (config: AutomationConfig, name = "A") => i.automations.apply(actor, { op: "create", name, config, enabled: true }, Date.now()).id!;
  const row = (cells: Record<string, unknown>) => s.createRows(actor, tasks, [{ cells }], { noTriggers: true }).created![0];
  return { s, tasks, log, F, add, row };
}

async function execute(i: BaseDO, id: string, trigger: TriggerInfo, net: Net, opts: { test?: boolean; steps?: StepLog[]; attempt?: number } = {}) {
  const a = i.automations.get(id);
  const runId = i.automations.insertRun({ automation: a, status: "queued", test: opts.test, trigger, chain: [id], now: Date.now() });
  const run = { ...i.automations.getRun(runId)!, steps: opts.steps ?? [], attempt: opts.attempt ?? 0 };
  return executeRun(run, { store: i.store, net, baseUrl: "https://app.test/base/x", now: () => Date.now() });
}

describe("automation steps", () => {
  it("creates a record from the trigger record and links it back", async () => {
    await withDO("ex-create", async i => {
      const { s, tasks, log, F, add, row } = setup(i);
      const rid = row({ [F.name]: "Write docs", [F.points]: 3 });
      const id = add({ trigger: { type: "recordCreated", tableId: tasks }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [F.message]: `New task {{trigger.record.${F.name}}} ({{trigger.record.${F.points}}})`, [F.link]: "{{trigger.record}}" } }] });
      const out = await execute(i, id, { type: "recordCreated", tableId: tasks, recordId: rid, at: Date.now() }, fakeNet().net);
      expect(out.status).toBe("succeeded");
      const created = out.steps[0].output!.records!.ids;
      const r = s.getRows(log, created)[0];
      expect(r.cells[F.message]).toBe("New task Write docs (3)");
      expect(r.cells[F.link]).toEqual([{ id: rid, t: "Write docs" }]);
      expect(r.createdBy).toBe("auto:" + id);
      expect(out.steps[0].input).toEqual({ values: { Message: "New task Write docs (3)", Task: [{ id: rid }] } });
      expect(out.results).toHaveLength(1);
    });
  });

  it("finds records by a webhook value and updates them with typecast", async () => {
    await withDO("ex-find", async i => {
      const { s, tasks, F, add, row } = setup(i);
      const a = row({ [F.name]: "a" }), b = row({ [F.name]: "b" });
      const id = add({
        trigger: { type: "webhook", token: "" },
        steps: [
          { id: "s1", type: "findRecords", tableId: tasks, conditions: { conjunction: "and", conditions: [{ fieldId: F.name, op: "eq", value: "{{trigger.body.name}}" }] }, limit: 10 },
          { id: "s2", type: "updateRecords", target: "s1", tableId: tasks, values: { [F.status]: "Blocked" } },
        ],
      });
      const out = await execute(i, id, { type: "webhook", body: { name: "B" }, at: Date.now() }, fakeNet().net);
      expect(out.status).toBe("succeeded");
      expect(out.steps.map(l => l.output?.count)).toEqual([1, 1]);
      const blocked = s.maybeField(F.status)!.options.choices!.find(c => c.name === "Blocked")!;
      expect(s.getRows(tasks, [a, b]).map(r => r.cells[F.status])).toEqual([undefined, blocked.id]);
      const none = await execute(i, id, { type: "webhook", body: {}, at: Date.now() }, fakeNet().net);
      expect(none.steps.map(l => l.output?.count)).toEqual([0, 0]);
      expect(s.getRows(tasks, [a]).map(r => r.cells[F.status])).toEqual([undefined]);
    });
  });

  it("branches run one side and skip the other", async () => {
    await withDO("ex-branch", async i => {
      const { tasks, F, add, row } = setup(i);
      const rid = row({ [F.points]: 8 });
      const id = add({
        trigger: { type: "recordCreated", tableId: tasks },
        steps: [
          {
            id: "s1", type: "branch", match: "all",
            conditions: [{ left: `{{trigger.record.${F.points}}}`, op: "gt", right: "5" }],
            then: [{ id: "s2", type: "http", method: "POST", url: "https://example.com/big", headers: [], body: `{{trigger.record.${F.points}}}` }],
            else: [{ id: "s3", type: "email", provider: "resend", to: "a@example.com", subject: "small", body: "x", format: "text" }],
          },
          { id: "s4", type: "http", method: "GET", url: "https://example.com/after", headers: [] },
        ],
      });
      const { net, calls } = fakeNet();
      const out = await execute(i, id, { type: "recordCreated", tableId: tasks, recordId: rid, at: Date.now() }, net);
      expect(out.steps.map(l => l.id)).toEqual(["s1", "s2", "s4"]);
      expect(out.steps[0].output).toEqual({ matched: true });
      expect(calls.http.map(r => r.url)).toEqual(["https://example.com/big", "https://example.com/after"]);
      expect(calls.http[0].body).toBe("8");
      expect(calls.email).toHaveLength(0);
    });
  });

  it("HTTP masks secrets in the log, and a 4xx fails the run without a retry", async () => {
    await withDO("ex-http", async i => {
      const { tasks, F, add, row } = setup(i);
      const rid = row({ [F.name]: "a b" });
      const id = add({ trigger: { type: "recordCreated", tableId: tasks }, steps: [{ id: "s1", type: "http", method: "POST", url: `https://example.com/t/{{trigger.record.${F.name}}}`, headers: [["Authorization", "Bearer abc"], ["X-Kind", "task"]], body: `{"n":"{{trigger.record.${F.name}}}"}` }] });
      const { net, calls } = fakeNet(() => ({ status: 404, headers: {}, body: "nope" }));
      const out = await execute(i, id, { type: "recordCreated", tableId: tasks, recordId: rid, at: Date.now() }, net);
      expect(out).toMatchObject({ status: "failed", error: "The server answered 404", nextAt: null });
      expect(out.steps[0].input).toMatchObject({ url: "https://example.com/t/a b", headers: [["Authorization", "***"], ["X-Kind", "task"]], body: '{"n":"a b"}' });
      expect(out.steps[0].output).toEqual({ status: 404, body: "nope" });
      expect(calls.http[0].headers).toEqual([["Authorization", "Bearer abc"], ["X-Kind", "task"]]);
    });
  });

  it("a 5xx waits for a retry, the retry resumes at the failed step, and the fourth failure fails", async () => {
    await withDO("ex-retry", async i => {
      const { s, log, F, add } = setup(i);
      const id = add({ trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [F.message]: "once" } }, { id: "s2", type: "http", method: "POST", url: "https://example.com/x", headers: [] }] });
      let status = 503;
      const { net, calls } = fakeNet(() => ({ status, headers: {}, body: "" }));
      const first = await execute(i, id, { type: "webhook", at: Date.now() }, net);
      expect(first.status).toBe("waiting_retry");
      expect(first.nextAt! - Date.now()).toBeGreaterThan(9000);
      status = 200;
      const second = await execute(i, id, { type: "webhook", at: Date.now() }, net, { steps: first.steps, attempt: 1 });
      expect(second.status).toBe("succeeded");
      expect(s.rowCount(log)).toBe(1);
      expect(calls.http).toHaveLength(2);
      status = 503;
      expect((await execute(i, id, { type: "webhook", at: Date.now() }, net, { steps: first.steps, attempt: 3 })).status).toBe("failed");
      expect((await execute(i, id, { type: "webhook", at: Date.now() }, net, { test: true })).status).toBe("failed");
    });
  });

  it("a deleted field fails the step with a clear message", async () => {
    await withDO("ex-deleted", async i => {
      const { s, log, add } = setup(i);
      const extra = s.createField(log, { name: "Extra", type: "text" }).fieldId;
      const id = add({ trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [extra]: "x" } }] });
      s.deleteField(extra);
      const out = await execute(i, id, { type: "webhook", at: Date.now() }, fakeNet().net);
      expect(out).toMatchObject({ status: "failed", error: `The field ${extra} no longer exists` });
    });
  });

  it("email splits recipients, escapes values in HTML and checks addresses", async () => {
    await withDO("ex-email", async i => {
      const { tasks, F, add, row } = setup(i);
      const rid = row({ [F.name]: "<script>" });
      const trigger = { type: "recordCreated" as const, tableId: tasks, recordId: rid, at: Date.now() };
      const mk = (to: string) => add({ trigger: { type: "recordCreated", tableId: tasks }, steps: [{ id: "s1", type: "email", provider: "smtp", to, subject: `Task {{trigger.record.${F.name}}}`, body: `<b>{{trigger.record.${F.name}}}</b>`, format: "html" }] }, to.slice(0, 20));
      const { net, calls } = fakeNet();
      expect((await execute(i, mk("a@x.co, b@x.co; c@x.co"), trigger, net)).status).toBe("succeeded");
      expect(calls.email[0]).toMatchObject({ provider: "smtp", to: ["a@x.co", "b@x.co", "c@x.co"], cc: [], subject: "Task <script>", body: "<b>&lt;script&gt;</b>", format: "html" });
      const many = Array.from({ length: 51 }, (_, k) => `u${k}@x.co`).join(",");
      expect((await execute(i, mk(many), trigger, net)).error).toBe("An email can have at most 50 recipients");
      expect((await execute(i, mk("not-an-address"), trigger, net)).error).toBe("Invalid email address not-an-address");
    });
  });

  it("test runs write but do not trigger other automations", async () => {
    await withDO("ex-test", async i => {
      const { log, F, add } = setup(i);
      const a = add({ trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [F.message]: "hi" } }] }, "A");
      const b = add({ trigger: { type: "recordCreated", tableId: log }, steps: [] }, "B");
      await execute(i, a, { type: "webhook", at: Date.now() }, fakeNet().net, { test: true });
      expect(i.automations.runs(b, { limit: 10 })).toHaveLength(0);
      await execute(i, a, { type: "webhook", at: Date.now() }, fakeNet().net);
      expect(i.automations.runs(b, { limit: 10 }).map(r => r.chain)).toEqual([[a, b]]);
      expect(i.store.rowCount(log)).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project worker test/worker/automation-executor.test.ts`
Expected: FAIL with "Failed to load url ../../src/worker/auto/executor".

- [ ] **Step 3: Write the implementation**

`src/worker/base/store.ts`:
- `MutationResult` gets `/** Ids of records made by createRows, in input order. */ created?: number[];`
- `createRows` collects ids: declare `const created: number[] = [];` before `return this.run(...)`, push `id` after each `insertRow`, and replace `return this.run(actor, tx => {...});` with `const out = this.run(actor, tx => {...}); out.created = created; return out;`.
- After `findTable`, add:

```ts
  maybeTable(id: string): Table | undefined {
    return this.c.tables.get(id);
  }
  maybeField(id: string): Field | undefined {
    return this.c.fields.get(id);
  }
  memberName(id: string): string {
    return this.userName(id);
  }
```

`src/worker/auto/types.ts`:

```ts
// The network side of automation steps; the Durable Object provides the real one, tests a fake.
import type { MailProvider, StepOutput } from "../../shared/automations";

export interface HttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MailRequest {
  provider: MailProvider;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  format: "text" | "html";
}

export interface Net {
  http(req: HttpRequest, timeoutMs: number): Promise<HttpResult>;
  email(req: MailRequest, timeoutMs: number): Promise<{ messageId?: string }>;
}

/** A step failure. `retry` marks failures worth trying again: timeouts, connection errors, 5xx and 429. */
export class StepError extends Error {
  constructor(message: string, readonly retry = false, readonly output?: StepOutput) {
    super(message);
  }
}

export const NO_NET: Net = {
  http: async () => {
    throw new StepError("HTTP requests are not available");
  },
  email: async () => {
    throw new StepError("Email sending is not set up for this workspace");
  },
};
```

`src/worker/auto/executor.ts`:

```ts
// Executes one automation run: steps in order with templates filled from the trigger and earlier steps,
// record steps through the store, network steps through an injected Net. A run resumes after its last finished step.
import type { BaseStore, MutationResult } from "../base/store";
import type { Cells, FilterSpec } from "../../shared/types";
import { LIMITS, type BranchOp, type Step, type StepLog, type StepOutput } from "../../shared/automations";
import { renderText, renderValue, type TemplateContext, type TemplateEnv } from "../../shared/template";
import type { RunRecord } from "./repo";
import { StepError, type Net } from "./types";

export interface RunOutcome {
  status: "succeeded" | "failed" | "waiting_retry";
  steps: StepLog[];
  error: string | null;
  nextAt: number | null;
  /** Row changes made by the run, for realtime clients. */
  results: MutationResult[];
}

export interface ExecutorDeps {
  store: BaseStore;
  net: Net;
  /** Origin plus /base/<id>. */
  baseUrl: string;
  now: () => number;
  /** Called after every step with the log so far, so a run cut off by an eviction resumes after its last finished step. */
  onStep?: (steps: StepLog[]) => void;
}

const SECRET_HEADER = /authorization|cookie|key|token|secret/i;
const EMAIL = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inputs are logged up to the output limit. */
function fit(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  return s.length <= LIMITS.outputBytes ? v : { truncated: true, preview: s.slice(0, LIMITS.outputBytes) };
}

/** HTTP bodies are logged up to 4 KB; the full body stays available to later steps of the same attempt. */
function logOutput(o: StepOutput): StepOutput {
  if (o.body === undefined) return o;
  const s = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  return s.length <= LIMITS.httpBodyLog ? o : { ...o, body: s.slice(0, LIMITS.httpBodyLog) };
}

export function templateEnv(store: BaseStore): TemplateEnv {
  return {
    field: id => store.maybeField(id),
    table: id => store.maybeTable(id),
    rows: (tableId, ids) => (store.maybeTable(tableId) ? store.getRows(tableId, ids) : []),
    userName: id => store.memberName(id),
  };
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
}

/** Branch tests: text tests ignore case; order tests compare numbers when both sides are numbers, text otherwise. */
export function compareValues(op: BranchOp, left: { text: string; value?: unknown }, right: { text: string; value?: unknown }): boolean {
  const a = left.text.trim(), b = right.text.trim();
  const la = a.toLowerCase(), lb = b.toLowerCase();
  switch (op) {
    case "empty":
      return a === "";
    case "notempty":
      return a !== "";
    case "eq":
      return la === lb;
    case "neq":
      return la !== lb;
    case "contains":
      return la.includes(lb);
    case "ncontains":
      return !la.includes(lb);
    default: {
      const x = Number.isFinite(asNumber(left.value)) ? asNumber(left.value) : asNumber(a);
      const y = Number.isFinite(asNumber(right.value)) ? asNumber(right.value) : asNumber(b);
      const c = Number.isFinite(x) && Number.isFinite(y) ? x - y : a < b ? -1 : a > b ? 1 : 0;
      return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
    }
  }
}

export async function executeRun(run: RunRecord, d: ExecutorDeps): Promise<RunOutcome> {
  const { store } = d;
  const { name, config } = run.snapshot;
  const deadline = d.now() + LIMITS.runTimeout;
  const done = new Map(run.steps.filter(l => l.status === "ok").map(l => [l.id, l]));
  const outputs: Record<string, StepOutput> = {};
  for (const l of done.values()) if (l.output) outputs[l.id] = l.output;
  const logs: StepLog[] = [];
  const results: MutationResult[] = [];
  const env = templateEnv(store);
  const actor = { userId: `auto:${run.automationId}`, name: `Automation: ${name}` };
  const writeCtx = { chain: run.chain, silent: run.test };
  const tr = run.trigger;

  const ctx = (): TemplateContext => {
    const row = tr.tableId && tr.recordId !== undefined && store.maybeTable(tr.tableId) ? store.getRows(tr.tableId, [tr.recordId])[0] : undefined;
    return { trigger: { record: row ? { tableId: tr.tableId!, row } : undefined, body: tr.body }, steps: outputs, now: d.now(), automationName: name, baseUrl: d.baseUrl };
  };
  const timeout = () => Math.max(1, Math.min(LIMITS.stepTimeout, deadline - d.now()));
  const write = (fn: () => MutationResult): MutationResult => {
    const r = store.withWriteContext(writeCtx, fn);
    results.push(r);
    return r;
  };
  const needTable = (id: string) => {
    if (!store.maybeTable(id)) throw new StepError("The table no longer exists");
  };
  const cellsFor = (tableId: string, values: Record<string, string>, c: TemplateContext) => {
    const cells: Cells = {};
    const shown: Record<string, unknown> = {};
    for (const [fid, tpl] of Object.entries(values)) {
      const f = store.maybeField(fid);
      if (!f || f.tableId !== tableId) throw new StepError(`The field ${fid} no longer exists`);
      const v = renderValue(tpl, c, env);
      cells[fid] = v === undefined || v === "" ? null : v;
      shown[f.name] = v ?? null;
    }
    return { cells, shown };
  };

  async function step(st: Step, setInput: (i: unknown) => void): Promise<StepOutput> {
    const c = ctx();
    switch (st.type) {
      case "createRecord": {
        needTable(st.tableId);
        const { cells, shown } = cellsFor(st.tableId, st.values, c);
        setInput({ values: shown });
        const r = write(() => store.createRows(actor, st.tableId, [{ cells }], { typecast: true }));
        return { records: { tableId: st.tableId, ids: r.created ?? [] }, count: r.created?.length ?? 0 };
      }
      case "updateRecords": {
        needTable(st.tableId);
        const src = st.target === "trigger" ? (tr.tableId === st.tableId && tr.recordId !== undefined ? [tr.recordId] : []) : outputs[st.target]?.records?.tableId === st.tableId ? outputs[st.target]!.records!.ids : [];
        const { cells, shown } = cellsFor(st.tableId, st.values, c);
        setInput({ records: src, values: shown });
        const ids = src.length ? store.getRows(st.tableId, src).map(r => r.id) : [];
        if (ids.length) write(() => store.updateRows(actor, st.tableId, ids.map(id => ({ id, cells })), { typecast: true }));
        return { records: { tableId: st.tableId, ids }, count: ids.length };
      }
      case "findRecords": {
        needTable(st.tableId);
        let blank = false;
        const conditions: FilterSpec | undefined = st.conditions && {
          ...st.conditions,
          conditions: st.conditions.conditions.map(cond => {
            if (typeof cond.value !== "string" || !cond.value.includes("{{")) return cond;
            const value = renderText(cond.value, c, env);
            if (!value.trim() && cond.op !== "empty" && cond.op !== "notempty") blank = true;
            return { ...cond, value };
          }),
        };
        setInput({ conditions: conditions?.conditions ?? [], limit: st.limit });
        // A condition whose template came out empty would be ignored by the filter and match every record.
        const ids = blank ? [] : store.query(st.tableId, { filters: conditions, sorts: st.sort, limit: 0 }).ids.slice(0, st.limit);
        return { records: { tableId: st.tableId, ids }, count: ids.length };
      }
      case "http": {
        const url = renderText(st.url, c, env).trim();
        const headers = (st.headers ?? []).map(([k, v]) => [k.trim(), renderText(v, c, env)] as [string, string]).filter(([k]) => k);
        const body = st.body !== undefined && st.method !== "GET" ? renderText(st.body, c, env) : undefined;
        setInput({ method: st.method, url, headers: headers.map(([k, v]) => [k, SECRET_HEADER.test(k) ? "***" : v]), body: body?.slice(0, LIMITS.httpBodyLog) });
        const res = await d.net.http({ method: st.method, url, headers, body }, timeout());
        if (res.status >= 400) throw new StepError(`The server answered ${res.status}`, res.status >= 500 || res.status === 429, { status: res.status, body: res.body.slice(0, LIMITS.httpBodyLog) });
        let parsed: unknown = res.body;
        try {
          parsed = JSON.parse(res.body);
        } catch {
          // Plain text answers stay text.
        }
        return { status: res.status, body: parsed };
      }
      case "email": {
        const list = (tpl?: string) => (tpl ? renderText(tpl, c, env) : "").split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
        const to = list(st.to), cc = list(st.cc);
        const subject = renderText(st.subject, c, env).replace(/[\r\n]+/g, " ").slice(0, 300);
        const body = renderText(st.body, c, env, st.format === "html" ? escapeHtml : undefined);
        setInput({ provider: st.provider, to, cc, subject, body: body.slice(0, LIMITS.httpBodyLog) });
        if (!to.length) throw new StepError("The email has no recipients");
        if (to.length + cc.length > LIMITS.recipients) throw new StepError(`An email can have at most ${LIMITS.recipients} recipients`);
        const bad = [...to, ...cc].find(a => !EMAIL.test(a));
        if (bad) throw new StepError(`Invalid email address ${bad}`);
        const r = await d.net.email({ provider: st.provider, to, cc, subject, body, format: st.format }, timeout());
        return { messageId: r.messageId };
      }
      case "branch": {
        const side = (tpl: string) => ({ text: renderText(tpl, c, env), value: renderValue(tpl, c, env) });
        const checks = st.conditions.map(cond => {
          const l = side(cond.left), r = side(cond.right ?? "");
          return { left: l.text, op: cond.op, right: r.text, ok: compareValues(cond.op, l, r) };
        });
        setInput({ match: st.match, conditions: checks });
        return { matched: st.match === "all" ? checks.every(x => x.ok) : checks.some(x => x.ok) };
      }
      default:
        throw new StepError("Unknown step type");
    }
  }

  async function runAll(steps: Step[]): Promise<StepError | null> {
    for (const st of steps) {
      const prev = done.get(st.id);
      let out = prev?.output;
      if (prev) logs.push(prev);
      else {
        if (d.now() > deadline) return new StepError(`The run took longer than ${LIMITS.runTimeout / 1000} seconds`);
        const t0 = d.now();
        let input: unknown;
        try {
          out = await step(st, i => (input = i));
          outputs[st.id] = out;
          logs.push({ id: st.id, type: st.type, status: "ok", input: fit(input), output: logOutput(out), ms: d.now() - t0 });
        } catch (e) {
          const err = e instanceof StepError ? e : new StepError(e instanceof Error ? e.message : String(e));
          logs.push({ id: st.id, type: st.type, status: "error", input: fit(input), output: err.output, error: err.message, ms: d.now() - t0 });
          d.onStep?.(logs);
          return err;
        }
        d.onStep?.(logs);
      }
      if (st.type === "branch") {
        const e = await runAll(out?.matched ? st.then : st.else);
        if (e) return e;
      }
    }
    return null;
  }

  const err = await runAll(config.steps);
  if (!err) return { status: "succeeded", steps: logs, error: null, nextAt: null, results };
  if (err.retry && !run.test && run.attempt < LIMITS.retryDelays.length) return { status: "waiting_retry", steps: logs, error: err.message, nextAt: d.now() + LIMITS.retryDelays[run.attempt], results };
  return { status: "failed", steps: logs, error: err.message, nextAt: null, results };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project worker test/worker/automation-executor.test.ts && npm run typecheck`
Expected: PASS (8 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: whole suite passes. Record in the ledger: `Task 6: automation-executor.test.ts 8/8, suite <N>/<N>`.

---

### Task 7: Engine, alarm, schedules and date triggers

**Files:**
- Create: `src/worker/auto/engine.ts`
- Modify: `src/worker/base/store.ts` (`dateValues`)
- Modify: `src/worker/base-do.ts` (engine, `net`, `baseUrl()`, `wake()`, new `alarm()`, `kickJobs()` through `wake()`, write hook adds `touchDates`)
- Test: `test/worker/automation-engine.test.ts`

**Interfaces:**
- Consumes: `AutomationRepo` (Task 4) incl. `NEVER`, `STALE_AFTER`, `timers`, `setTimer`, `earliestTimer`, `dueRuns`, `stale`, `nextRunAt`, `recordOutcome`, `enqueue`; `executeRun` (Task 6); `NO_NET`, `Net` (Task 6); `nextScheduleTime`, `dateDue`, `dueDayWindow` (Task 3); `WrittenRow`, `matchRows` (Task 5).
- Produces: `EngineHost { store; repo; net(); baseUrl(); monthlyRuns(); publish(results); automationsChanged() }`, class `AutomationEngine` with `resetTimer(id, now)`, `touchDates(tableId, rows)`, `enqueueDue(now)`, `nextWake(): number | null`, `drain(now?)`, `execute(runId, now?): Promise<RunRecord>`.
- Produces (DO): `engine: AutomationEngine`, `net: Net` (default `NO_NET`; Task 8 sets the real one), `private wake()`, `baseUrl()`.
- Produces (store): `dateValues(tableId, fieldId, fromDay, toDay | null, limit): { id: number; value: string }[]`.

- [ ] **Step 1: Write the failing test**

`test/worker/automation-engine.test.ts`:

```ts
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { AutomationConfig } from "../../src/shared/automations";
import type { HttpRequest } from "../../src/worker/auto/types";

const actor = { userId: "u1", name: "Tester" };

async function withDO<R>(name: string, fn: (i: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (i: BaseDO) => {
    if (!i.store.initialized) i.store.init(name);
    return fn(i);
  });
}

const httpStep = { id: "s1", type: "http" as const, method: "POST" as const, url: "https://example.com/x", headers: [] as [string, string][] };
const create = (i: BaseDO, config: AutomationConfig, now = Date.now(), name = "A") => i.automations.apply(actor, { op: "create", name, config, enabled: true }, now).id!;

describe("automation engine", () => {
  it("a record edit queues a run that the next alarm executes", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("eng-alarm"));
    const calls: HttpRequest[] = [];
    await runInDurableObject(stub, async (i: BaseDO) => {
      i.store.init("eng-alarm");
      i.net = { http: async r => (calls.push(r), { status: 200, headers: {}, body: "" }), email: async () => ({}) };
      const tableId = i.store.createTable(actor, { name: "T" }).tableId;
      create(i, { trigger: { type: "recordCreated", tableId }, steps: [httpStep] });
      expect((await i.rowOp(actor, { op: "create", tableId, rows: [{ cells: {} }] })).ok).toBe(true);
      expect(await (i as any).ctx.storage.getAlarm()).not.toBeNull();
    });
    // Miniflare may also fire the alarm on its own; either way the run executes exactly once.
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, (i: BaseDO) => i.engine.drain());
    expect(calls).toHaveLength(1);
  });

  it("the alarm stops after its time budget and continues later", async () => {
    await withDO("eng-budget", async i => {
      let clock = Date.parse("2026-10-13T00:00:00Z");
      i.net = { http: async () => ((clock += 300), { status: 200, headers: {}, body: "" }), email: async () => ({}) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] }, clock);
      const a = i.automations.get(id);
      for (let k = 0; k < 10; k++) i.automations.enqueue(a, { type: "webhook", at: clock }, [id], clock, 0);
      const count = (st: string) => i.automations.runs(id, { limit: 20 }).filter(r => r.status === st).length;
      await i.engine.drain(() => clock);
      expect([count("succeeded"), count("queued")]).toEqual([7, 3]);
      await i.engine.drain(() => clock);
      expect(count("succeeded")).toBe(10);
    });
  });

  it("retries after 10 s, 1 min and 5 min, then fails", async () => {
    await withDO("eng-retry", async i => {
      let clock = Date.parse("2026-10-13T00:00:00Z");
      let calls = 0;
      i.net = { http: async () => (calls++, { status: 503, headers: {}, body: "" }), email: async () => ({}) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] }, clock);
      i.automations.enqueue(i.automations.get(id), { type: "webhook", at: clock }, [id], clock, 0);
      const run = () => i.automations.runs(id, { limit: 1 })[0];
      await i.engine.drain(() => clock);
      expect(run()).toMatchObject({ status: "waiting_retry", attempt: 1, nextAt: clock + 10_000 });
      clock += 5_000;
      await i.engine.drain(() => clock);
      expect(calls).toBe(1);
      clock += 5_000;
      await i.engine.drain(() => clock);
      expect(run()).toMatchObject({ attempt: 2, nextAt: clock + 60_000 });
      clock += 60_000;
      await i.engine.drain(() => clock);
      expect(run()).toMatchObject({ attempt: 3, nextAt: clock + 300_000 });
      clock += 300_000;
      await i.engine.drain(() => clock);
      expect(run()).toMatchObject({ status: "failed", attempt: 3, error: "The server answered 503" });
      expect(calls).toBe(4);
    });
  });

  it("20 failed runs in a row turn the automation off; a success resets the count", async () => {
    await withDO("eng-streak", async i => {
      let status = 400;
      i.net = { http: async () => ({ status, headers: {}, body: "" }), email: async () => ({}) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [httpStep] });
      const queue = (n: number) => { for (let k = 0; k < n; k++) i.automations.enqueue(i.automations.get(id), { type: "webhook", at: 0 }, [id], Date.now(), 0); };
      queue(19);
      await i.engine.drain(() => 0);
      expect(i.automations.get(id)).toMatchObject({ enabled: true, failStreak: 19 });
      status = 200;
      queue(1);
      await i.engine.drain(() => 0);
      expect(i.automations.get(id).failStreak).toBe(0);
      status = 400;
      queue(20);
      await i.engine.drain(() => 0);
      expect(i.automations.get(id)).toMatchObject({ enabled: false, disabledReason: "failures", failStreak: 20 });
      queue(1);
      await i.engine.drain(() => 0);
      expect(i.automations.runs(id, { limit: 1 })[0]).toMatchObject({ status: "skipped", error: "The automation was turned off" });
    });
  });

  it("a run left running by an eviction resumes at its unfinished step", async () => {
    await withDO("eng-stale", async i => {
      const s = i.store;
      const log = s.createTable(actor, { name: "Log", fields: [{ name: "Message", type: "text" }] }).tableId;
      const msg = s.fieldsOf(log)[0].id;
      const calls: string[] = [];
      i.net = { http: async r => (calls.push(r.url), { status: 200, headers: {}, body: "" }), email: async () => ({}) };
      const id = create(i, { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: log, values: { [msg]: "once" } }, { ...httpStep, id: "s2" }] });
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", at: 0 }, [id], Date.now(), 0);
      const first = s.createRows(actor, log, [{ cells: { [msg]: "once" } }], { noTriggers: true }).created![0];
      const t = Date.now();
      i.automations.saveRun(runId, { status: "running", startedAt: t - 120_000, steps: [{ id: "s1", type: "createRecord", status: "ok", output: { records: { tableId: log, ids: [first] }, count: 1 }, ms: 3 }] });
      expect(i.engine.nextWake()).toBe(t - 120_000 + 60_000);
      await i.engine.drain(() => t);
      expect(i.automations.getRun(runId)).toMatchObject({ status: "succeeded" });
      expect(s.rowCount(log)).toBe(1);
      expect(calls).toEqual(["https://example.com/x"]);
    });
  });

  it("schedules queue one run at their time, even after missed times", async () => {
    await withDO("eng-schedule", async i => {
      const t0 = Date.parse("2026-10-13T08:00:00Z");
      const id = create(i, { trigger: { type: "schedule", every: "day", at: "09:00", tz: "UTC" }, steps: [] }, t0);
      const nextAt = () => i.automations.timers().find(x => x.automation.id === id)!.nextAt!;
      const first = nextAt();
      expect(new Date(first).toISOString()).toBe("2026-10-13T09:00:00.000Z");
      expect(i.engine.nextWake()).toBe(first);
      i.engine.enqueueDue(first - 1);
      expect(i.automations.runs(id, { limit: 10 })).toHaveLength(0);
      i.engine.enqueueDue(first + 60_000);
      expect(i.automations.runs(id, { limit: 10 })).toHaveLength(1);
      i.engine.enqueueDue(first + 3 * 86_400_000);
      expect(i.automations.runs(id, { limit: 10 })).toHaveLength(2);
      expect(new Date(nextAt()).toISOString()).toBe("2026-10-17T09:00:00.000Z");
      i.automations.apply(actor, { op: "setEnabled", id, enabled: false }, t0);
      expect(i.automations.timers()).toEqual([]);
    });
  });

  it("date triggers fire once when a date plus its offset is reached", async () => {
    await withDO("eng-date", async i => {
      const s = i.store;
      const t = s.createTable(actor, { name: "Tasks", fields: [{ name: "Name", type: "text" }, { name: "Due", type: "date" }] }).tableId;
      const due = s.fieldsOf(t).find(f => f.name === "Due")!.id;
      const mk = (d: string) => s.createRows(actor, t, [{ cells: { [due]: d } }]).created![0];
      const r13 = mk("2026-10-13");
      mk("2026-10-14");
      mk("2026-10-09");
      const t0 = Date.parse("2026-10-10T00:00:00Z");
      const id = create(i, { trigger: { type: "dateReached", tableId: t, fieldId: due, offsetMinutes: -60, at: "09:00", tz: "UTC" }, steps: [] }, t0);
      const nextAt = () => new Date(i.automations.timers().find(x => x.automation.id === id)!.nextAt!).toISOString();
      expect(nextAt()).toBe("2026-10-13T08:00:00.000Z");
      const r11 = mk("2026-10-11");
      expect(nextAt()).toBe("2026-10-11T08:00:00.000Z");
      i.engine.enqueueDue(Date.parse("2026-10-13T08:30:00Z"));
      const fired = () => i.automations.runs(id, { limit: 10 }).map(r => r.trigger.recordId);
      expect(fired().sort()).toEqual([r11, r13].sort());
      expect(nextAt()).toBe("2026-10-14T08:00:00.000Z");
      i.engine.enqueueDue(Date.parse("2026-10-13T09:00:00Z"));
      expect(fired()).toHaveLength(2);
      i.engine.enqueueDue(Date.parse("2026-10-14T08:00:00Z"));
      expect(fired()).toHaveLength(3);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project worker test/worker/automation-engine.test.ts`
Expected: FAIL; `i.engine` is undefined and the alarm test sees no alarm.

- [ ] **Step 3: Write the implementation**

`src/worker/base/store.ts`, after `matchSnapshots`:

```ts
  /** Rows whose date cell (its YYYY-MM-DD prefix) lies in [from, to], ordered by the cell; for date triggers. */
  dateValues(tableId: string, fieldId: string, from: string, to: string | null, limit: number): { id: number; value: string }[] {
    const t = this.c.tables.get(tableId);
    if (!t || !isSafeId(fieldId)) return [];
    const e = `json_extract(data, '$.${fieldId}')`;
    const rows = to
      ? this.all<{ id: number; v: string }>(`SELECT id, ${e} v FROM ${t.phys} WHERE substr(${e}, 1, 10) >= ? AND substr(${e}, 1, 10) <= ? ORDER BY ${e} LIMIT ?`, from, to, limit)
      : this.all<{ id: number; v: string }>(`SELECT id, ${e} v FROM ${t.phys} WHERE substr(${e}, 1, 10) >= ? ORDER BY ${e} LIMIT ?`, from, limit);
    return rows.map(r => ({ id: r.id, value: r.v }));
  }
```

`src/worker/auto/engine.ts`:

```ts
// Runs automations from the base's alarm: due schedules and date triggers become runs,
// queued runs and retries execute within a time budget, and runs cut off by an eviction resume.
import type { BaseStore, MutationResult, WrittenRow } from "../base/store";
import { LIMITS, type DateTrigger } from "../../shared/automations";
import { dateDue, dueDayWindow, nextScheduleTime } from "../../shared/schedule";
import { NEVER, STALE_AFTER, type AutomationRepo, type RunRecord } from "./repo";
import { executeRun } from "./executor";
import type { Net } from "./types";

export interface EngineHost {
  store: BaseStore;
  repo: AutomationRepo;
  net(): Net;
  baseUrl(): string;
  monthlyRuns(): number;
  /** Row changes made by runs, for realtime clients. */
  publish(results: MutationResult[]): void;
  /** An automation was switched off after repeated failures. */
  automationsChanged(): void;
}

export class AutomationEngine {
  constructor(private h: EngineHost) {}

  /** Recomputes an automation's timer after it was created, edited, or switched on or off. */
  resetTimer(id: string, now: number) {
    const a = this.h.repo.all().find(x => x.id === id);
    const t = a?.config.trigger;
    if (!a || !a.enabled || !t || (t.type !== "schedule" && t.type !== "dateReached")) return this.h.repo.setTimer(id, null, null);
    if (t.type === "schedule") return this.h.repo.setTimer(id, nextScheduleTime(t, now), null);
    this.h.repo.setTimer(id, this.nextDue(t, now) ?? NEVER, now);
  }

  /** A write changed date cells: bring the next check forward when one of them falls due sooner. */
  touchDates(tableId: string, rows: WrittenRow[]) {
    for (const { automation: a, nextAt, watermark } of this.h.repo.timers()) {
      const t = a.config.trigger;
      if (t.type !== "dateReached" || t.tableId !== tableId) continue;
      const ids = rows.filter(r => r.isNew || r.changed.has(t.fieldId)).map(r => r.id);
      if (!ids.length) continue;
      const current = nextAt ?? NEVER;
      let best = current;
      for (const r of this.h.store.getRows(tableId, ids)) {
        const due = dateDue(r.cells[t.fieldId], t);
        if (due !== null && due > (watermark ?? 0) && due < best) best = due;
      }
      if (best !== current) this.h.repo.setTimer(a.id, best);
    }
  }

  private nextDue(t: DateTrigger, after: number): number | null {
    if (!this.h.store.maybeField(t.fieldId)) return null;
    const [from] = dueDayWindow(after, after, t.offsetMinutes);
    let best: number | null = null;
    for (const v of this.h.store.dateValues(t.tableId, t.fieldId, from, null, 500)) {
      const due = dateDue(v.value, t);
      if (due !== null && due > after && (best === null || due < best)) best = due;
    }
    return best;
  }

  /** Schedules and date triggers that are due become queued runs. */
  enqueueDue(now: number) {
    const { repo, store } = this.h;
    const limit = this.h.monthlyRuns();
    for (const { automation: a, nextAt, watermark } of repo.timers()) {
      const t = a.config.trigger;
      if (t.type !== "schedule" && t.type !== "dateReached") continue;
      if (nextAt === null) {
        this.resetTimer(a.id, now);
        continue;
      }
      if (nextAt > now) continue;
      if (t.type === "schedule") {
        // A missed time (the object was not running) runs once, not once per missed slot.
        repo.enqueue(a, { type: "schedule", at: now }, [a.id], now, limit);
        repo.setTimer(a.id, nextScheduleTime(t, now), null);
        continue;
      }
      const from = watermark ?? now;
      if (store.maybeField(t.fieldId)) {
        const [lo, hi] = dueDayWindow(from, now, t.offsetMinutes);
        const due = store
          .dateValues(t.tableId, t.fieldId, lo, hi, 5000)
          .filter(v => {
            const at = dateDue(v.value, t);
            return at !== null && at > from && at <= now;
          })
          .map(v => v.id);
        for (const id of store.matchRows(t.tableId, t.conditions, due)) repo.enqueue(a, { type: "dateReached", tableId: t.tableId, recordId: id, at: now }, [a.id], now, limit);
      }
      repo.setTimer(a.id, this.nextDue(t, now) ?? NEVER, now);
    }
  }

  /** When the alarm must next fire for automations, or null. */
  nextWake(): number | null {
    const times = [this.h.repo.nextRunAt(), this.h.repo.earliestTimer()].filter((x): x is number => x !== null);
    return times.length ? Math.min(...times) : null;
  }

  /** Executes due runs for about LIMITS.alarmBudget ms; the rest wait for the next alarm. */
  async drain(now: () => number = Date.now) {
    const start = now();
    for (const id of this.h.repo.stale(start - STALE_AFTER)) this.h.repo.saveRun(id, { status: "waiting_retry", nextAt: start });
    while (now() - start < LIMITS.alarmBudget) {
      const [id] = this.h.repo.dueRuns(now(), 1);
      if (id === undefined) break;
      await this.execute(id, now);
    }
  }

  /** Runs one run to its end or its next retry and records the outcome. */
  async execute(id: number, now: () => number = Date.now): Promise<RunRecord> {
    const { repo } = this.h;
    const run = repo.getRun(id)!;
    if (!run.test && !repo.all().find(a => a.id === run.automationId)?.enabled) {
      repo.saveRun(id, { status: "skipped", error: "The automation was turned off", finishedAt: now() });
      return repo.getRun(id)!;
    }
    repo.saveRun(id, { status: "running", startedAt: now() });
    const out = await executeRun(run, { store: this.h.store, net: this.h.net(), baseUrl: this.h.baseUrl(), now, onStep: steps => repo.saveRun(id, { steps }) });
    const retry = out.status === "waiting_retry";
    repo.saveRun(id, { status: out.status, steps: out.steps, error: out.error, nextAt: out.nextAt, attempt: retry ? run.attempt + 1 : run.attempt, finishedAt: retry ? null : now() });
    if (out.results.length) this.h.publish(out.results);
    if (!run.test && !retry && repo.recordOutcome(run.automationId, out.status === "failed")) this.h.automationsChanged();
    return repo.getRun(id)!;
  }
}
```

`src/worker/base-do.ts`:
- Imports: `import { AutomationEngine } from "./auto/engine";` and `import { NO_NET, type Net } from "./auto/types";`.
- Fields:

```ts
  engine: AutomationEngine;
  /** Network side of automation steps; tests replace it. */
  net: Net = NO_NET;
```

- In the constructor, replace the `onWrite` line from Task 5 with:

```ts
    this.engine = new AutomationEngine({
      store: this.store,
      repo: this.automations,
      net: () => this.net,
      baseUrl: () => this.baseUrl(),
      monthlyRuns: () => this.monthlyRuns,
      publish: results => {
        for (const r of results) this.broadcastResult(r);
      },
      automationsChanged: () => {
        this.broadcast({ type: "schema", schema: this.store.schema() });
        this.broadcast({ type: "automations" });
      },
    });
    this.automations.onChange = (id, now) => this.engine.resetTimer(id, now);
    this.store.onWrite = w => {
      detectTriggers(this.store, this.automations, w, Date.now(), this.monthlyRuns);
      for (const tableId of new Set(w.rows.map(r => r.tableId))) this.engine.touchDates(tableId, w.rows.filter(r => r.tableId === tableId));
    };
```

- After `automationRuns`, add:

```ts
  baseUrl(): string {
    return `${this.env.APP_URL || this.store.meta("origin") || ""}/base/${this.store.meta("baseId") ?? ""}`;
  }
```

- In `automationOp`, after the two broadcasts, add `await this.wake();`.
- Replace `kickJobs` and `alarm`:

```ts
  private async kickJobs() {
    if (this.store.hasJobs()) this.broadcast({ type: "jobs", jobs: this.store.jobs() });
    await this.wake();
  }

  /** Sets the alarm to the earliest pending work: background jobs, then automation runs and timers. */
  private async wake() {
    let next = this.engine.nextWake();
    if (this.store.hasJobs()) next = Math.min(next ?? Infinity, Date.now() + 10);
    if (next === null) return;
    const at = Math.max(next, Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  override async alarm() {
    if (this.store.hasJobs()) {
      for (let i = 0; i < STEPS_PER_ALARM; i++) {
        const job = this.store.peekJob();
        if (!job) break;
        let step: { more: boolean; result?: MutationResult; finished?: { tableId?: string }; schemaChanged?: boolean };
        if (job.kind === "airtable") {
          step = await this.importer.step(job.id, JSON.parse(job.payload));
          if (step.schemaChanged) this.broadcast({ type: "schema", schema: this.store.schema() });
        } else step = this.store.runJobStep();
        if (step.result) this.broadcastResult(step.result);
        if (step.finished?.tableId) this.broadcast({ type: "reload", tableId: step.finished.tableId });
        if (!step.more) break;
        // Imports wait on the network; give other requests a turn between batches.
        if (job.kind === "airtable") break;
      }
      const jobs = this.store.jobs();
      this.broadcast({ type: "jobs", jobs });
      if (!jobs.length) this.broadcast({ type: "schema", schema: this.store.schema() });
    }
    this.engine.enqueueDue(Date.now());
    await this.engine.drain();
    await this.wake();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project worker test/worker/automation-engine.test.ts && npm run typecheck`
Expected: PASS (7 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: whole suite passes (the import and recompute job tests still drain through the new alarm). Record in the ledger: `Task 7: automation-engine.test.ts 7/7, suite <N>/<N>`.

---
### Task 8: Outbound HTTP

**Files:**
- Create: `src/worker/auto/http.ts`
- Create: `src/worker/auto/net.ts`
- Modify: `src/worker/env.ts` (`AUTOMATION_ALLOW_PRIVATE`)
- Modify: `src/worker/base-do.ts` (`this.net = createNet(env)`)
- Test: `test/unit/http.test.ts`, `test/worker/automation-net.test.ts`

**Interfaces:**
- Consumes: `StepError`, `HttpRequest`, `HttpResult`, `Net`, `NO_NET` (Task 6); `LIMITS.httpReadBytes`.
- Produces: `isPrivateHost(host): boolean`, `checkUrl(raw, allowPrivate): URL`, `httpRequest(req, { timeoutMs, allowPrivate, fetchFn? }): Promise<HttpResult>`; `createNet(env, opts?: { fetchFn? }): Net` (Task 9 adds a workspace argument and email).

- [ ] **Step 1: Write the failing tests**

`test/unit/http.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkUrl, httpRequest, isPrivateHost } from "../../src/worker/auto/http";
import { StepError } from "../../src/worker/auto/types";

const fake = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;

describe("private addresses", () => {
  it("knows private, loopback and link-local hosts", () => {
    for (const h of ["localhost", "api.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "fd00::1", "fe80::1", "[::ffff:7f00:1]"]) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "[2606:4700::1111]"]) expect(isPrivateHost(h), h).toBe(false);
  });

  it("checks URLs", () => {
    expect(() => checkUrl("ftp://example.com", false)).toThrow("Only http and https URLs are allowed");
    expect(() => checkUrl("http://2130706433/", false)).toThrow("Requests to private network addresses are not allowed");
    expect(() => checkUrl("not a url", false)).toThrow("Invalid URL not a url");
    expect(checkUrl("http://127.0.0.1:8787/x", true).host).toBe("127.0.0.1:8787");
  });
});

describe("HTTP requests", () => {
  it("sends the method, headers and body, and does not follow redirects", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = fake(async (url, init) => ((seen = { url, init }), new Response('{"a":1}', { status: 201, headers: { "x-id": "7" } })));
    const r = await httpRequest({ method: "POST", url: "https://example.com/h", headers: [["X-Kind", "a"]], body: '{"n":1}' }, { timeoutMs: 1000, allowPrivate: false, fetchFn });
    expect(r).toEqual({ status: 201, headers: expect.objectContaining({ "x-id": "7" }), body: '{"a":1}' });
    expect(seen!.url).toBe("https://example.com/h");
    expect(seen!.init.redirect).toBe("manual");
    const h = new Headers(seen!.init.headers);
    expect([h.get("x-kind"), h.get("content-type"), h.get("user-agent")]).toEqual(["a", "application/json", "Rowflare-Automations/1.0"]);
    expect(seen!.init.body).toBe('{"n":1}');
  });

  it("times out with a retryable error", async () => {
    const fetchFn = fake((_, init) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    const e = await httpRequest({ method: "GET", url: "https://example.com", headers: [] }, { timeoutMs: 20, allowPrivate: false, fetchFn }).catch(x => x);
    expect(e).toBeInstanceOf(StepError);
    expect(e).toMatchObject({ message: "The server did not answer in time", retry: true });
  });

  it("reports connection errors as retryable", async () => {
    const fetchFn = fake(async () => {
      throw new TypeError("connect ECONNREFUSED");
    });
    await expect(httpRequest({ method: "GET", url: "https://example.com", headers: [] }, { timeoutMs: 1000, allowPrivate: false, fetchFn })).rejects.toMatchObject({ message: "Could not connect: connect ECONNREFUSED", retry: true });
  });

  it("reads at most 1 MB of the answer", async () => {
    const fetchFn = fake(async () => new Response("x".repeat(1024 * 1024 + 10)));
    const r = await httpRequest({ method: "GET", url: "https://example.com", headers: [] }, { timeoutMs: 1000, allowPrivate: false, fetchFn });
    expect(r.body.length).toBe(1024 * 1024);
  });

  it("rejects invalid header names without retrying", async () => {
    await expect(httpRequest({ method: "GET", url: "https://example.com", headers: [["Bad Header", "x"]] }, { timeoutMs: 1000, allowPrivate: false, fetchFn: fake(async () => new Response("")) })).rejects.toMatchObject({ message: "Invalid header Bad Header", retry: false });
  });
});
```

`test/worker/automation-net.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";

const actor = { userId: "u1", name: "Tester" };

describe("automation network", () => {
  it("the real net refuses private addresses", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("net-private"));
    await runInDurableObject(stub, async (i: BaseDO) => {
      i.store.init("net-private");
      const id = i.automations.apply(actor, { op: "create", name: "Inner", enabled: true, config: { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "http", method: "GET", url: "http://192.168.1.10/admin", headers: [] }] } }, Date.now()).id!;
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", at: Date.now() }, [id], Date.now(), 0);
      expect(await i.engine.execute(runId)).toMatchObject({ status: "failed", error: "Requests to private network addresses are not allowed" });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit test/unit/http.test.ts; npx vitest run --project worker test/worker/automation-net.test.ts`
Expected: unit FAIL with "Failed to load url ../../src/worker/auto/http"; worker FAIL with error "HTTP requests are not available" instead of the private address message.

- [ ] **Step 3: Write the implementation**

`src/worker/auto/http.ts`:

```ts
// Outbound HTTP for automation steps: URL checks, a timeout, a size limit and retryable errors.
import { LIMITS } from "../../shared/automations";
import { StepError, type HttpRequest, type HttpResult } from "./types";

/** Loopback, private, link-local and shared address ranges, and localhost names. Host names are not resolved. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

export function checkUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new StepError(`Invalid URL ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new StepError("Only http and https URLs are allowed");
  if (!allowPrivate && isPrivateHost(u.hostname)) throw new StepError("Requests to private network addresses are not allowed");
  return u;
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      size = max;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function httpRequest(req: HttpRequest, opts: { timeoutMs: number; allowPrivate: boolean; fetchFn?: typeof fetch }): Promise<HttpResult> {
  const url = checkUrl(req.url, opts.allowPrivate);
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    try {
      headers.append(k, v);
    } catch {
      throw new StepError(`Invalid header ${k}`);
    }
  }
  const body = req.method === "GET" ? undefined : req.body;
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", /^\s*[[{]/.test(body) ? "application/json" : "text/plain; charset=utf-8");
  if (!headers.has("user-agent")) headers.set("user-agent", "Rowflare-Automations/1.0");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const failed = (e: unknown) => new StepError(ctrl.signal.aborted ? "The server did not answer in time" : `Could not connect: ${e instanceof Error ? e.message : String(e)}`, true);
  try {
    let res: Response;
    try {
      // Redirects are not followed, so a redirect cannot lead into a private network.
      res = await (opts.fetchFn ?? fetch)(url.toString(), { method: req.method, headers, body, redirect: "manual", signal: ctrl.signal });
    } catch (e) {
      throw failed(e);
    }
    let text: string;
    try {
      text = await readLimited(res, LIMITS.httpReadBytes);
    } catch (e) {
      throw failed(e);
    }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text };
  } finally {
    clearTimeout(timer);
  }
}
```

`src/worker/auto/net.ts`:

```ts
// The real network side of automation steps for a base's Durable Object.
import type { Env } from "../env";
import { httpRequest } from "./http";
import { NO_NET, type Net } from "./types";

export interface NetOptions {
  fetchFn?: typeof fetch;
}

export function createNet(env: Env, opts: NetOptions = {}): Net {
  return {
    http: (req, timeoutMs) => httpRequest(req, { timeoutMs, allowPrivate: env.AUTOMATION_ALLOW_PRIVATE === "true", fetchFn: opts.fetchFn }),
    email: NO_NET.email,
  };
}
```

`src/worker/env.ts`, add:

```ts
  /** "true" lets automation HTTP steps reach localhost and private addresses (self-hosting on a private network, local tests). */
  AUTOMATION_ALLOW_PRIVATE?: string;
```

`src/worker/base-do.ts`: import `createNet` from `./auto/net` and add `this.net = createNet(env);` at the end of the constructor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit test/unit/http.test.ts && npx vitest run --project worker test/worker/automation-net.test.ts && npm run typecheck`
Expected: PASS (7 unit tests, 1 worker test); typecheck clean.

- [ ] **Step 5: Checkpoint**

Record in the ledger: `Task 8: http.test.ts 7/7, automation-net.test.ts 1/1, typecheck clean`.

---

### Task 9: Email (Cloudflare Email Service, Resend, SMTP) and workspace mail settings

**Files:**
- Create: `migrations/0002_mail.sql`
- Create: `src/worker/secrets.ts`
- Create: `src/worker/auto/mime.ts`
- Create: `src/worker/auto/smtp.ts`
- Create: `src/worker/auto/smtp-socket.ts`
- Create: `src/worker/auto/mail.ts`
- Create: `test/fakes/smtp.ts`
- Modify: `src/worker/schema.ts` (migration 2)
- Modify: `src/worker/auto/net.ts` (email)
- Modify: `src/worker/routes-automations.ts` (mail settings routes)
- Modify: `src/worker/env.ts` (`SECRET_KEY`, `EMAIL`, `EMAIL_FROM`)
- Modify: `src/worker/base-do.ts` (`createNet` with the workspace lookup)
- Modify: `vitest.config.ts` (`SECRET_KEY` for worker tests)
- Modify: `docker/server.mjs:22` (pass the new settings through)
- Test: `test/unit/mail.test.ts`, `test/worker/automation-net.test.ts` (extend)

**Interfaces:**
- Consumes: `StepError`, `MailRequest`, `Net` (Task 6); `createNet` (Task 8); `LIMITS.systemMailPerDay`.
- Produces: `encryptSecret(key, plain)`, `decryptSecret(key, stored)`; `MimeMessage`, `buildMime(m)`, `b64utf8(s)`; `SmtpReply`, `SmtpConn`, `SmtpSettings`, `smtpSend(open, settings, password, envelope, data): Promise<string>`; `openSmtp(settings): Promise<SmtpConn>`; `OutMail`, `MailDeps`, `sendResend(key, from, fromName, m, fetchFn?)`, `sendSystem(binding, from, m)`, `sendWorkspaceMail(d, workspaceId, provider, m, timeoutMs)`; `createNet(env, workspaceId: () => Promise<string | null>, opts?: { fetchFn?; openSmtp? })`; routes `GET`/`PUT /api/workspaces/:ws/mail`, `POST /api/workspaces/:ws/mail/test`; test helper `fakeSmtp(opts?)`.

- [ ] **Step 1: Write the failing tests**

`test/fakes/smtp.ts`:

```ts
// A scripted SMTP server for tests: answers each command and records what the client wrote.
import type { SmtpConn, SmtpReply, SmtpSettings } from "../../src/worker/auto/smtp";

export function fakeSmtp(opts: { ehlo?: string[]; reject?: { command: string; reply: SmtpReply } } = {}) {
  const written: string[] = [];
  const opened: SmtpSettings[] = [];
  const pending: SmtpReply[] = [{ code: 220, lines: ["smtp.test ready"] }];
  let login = 0;
  const conn: SmtpConn = {
    async read() {
      const r = pending.shift();
      if (!r) throw new Error("nothing to read");
      return r;
    },
    async write(line) {
      written.push(line);
      if (login === 1) return void ((login = 2), pending.push({ code: 334, lines: ["UGFzc3dvcmQ6"] }));
      if (login === 2) return void ((login = 0), pending.push({ code: 235, lines: ["ok"] }));
      if (line.endsWith("\r\n.")) return void pending.push({ code: 250, lines: ["2.0.0 queued as 42"] });
      const cmd = line.startsWith("MAIL FROM") ? "MAIL FROM" : line.startsWith("RCPT TO") ? "RCPT TO" : line.split(" ")[0].toUpperCase();
      if (opts.reject?.command === cmd) return void pending.push(opts.reject.reply);
      if (cmd === "EHLO") pending.push({ code: 250, lines: ["smtp.test", ...(opts.ehlo ?? ["STARTTLS", "AUTH PLAIN LOGIN"])] });
      else if (cmd === "STARTTLS") pending.push({ code: 220, lines: ["go ahead"] });
      else if (cmd === "AUTH" && line.startsWith("AUTH PLAIN")) pending.push({ code: 235, lines: ["ok"] });
      else if (cmd === "AUTH") {
        login = 1;
        pending.push({ code: 334, lines: ["VXNlcm5hbWU6"] });
      } else if (cmd === "DATA") pending.push({ code: 354, lines: ["end with ."] });
      else if (cmd === "QUIT") pending.push({ code: 221, lines: ["bye"] });
      else pending.push({ code: 250, lines: ["ok"] });
    },
    async startTls() {
      written.push("<tls>");
      return conn;
    },
    async close() {},
  };
  return { open: async (s: SmtpSettings) => (opened.push(s), conn), written, opened };
}
```

`test/unit/mail.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../src/worker/secrets";
import { buildMime } from "../../src/worker/auto/mime";
import { smtpSend } from "../../src/worker/auto/smtp";
import { sendResend } from "../../src/worker/auto/mail";
import { fakeSmtp } from "../fakes/smtp";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("stored secrets", () => {
  it("round-trips, uses a fresh IV each time and needs the same key", async () => {
    const a = await encryptSecret("server-key", "re_123");
    const b = await encryptSecret("server-key", "re_123");
    expect(a).toMatch(/^v1:/);
    expect(a).not.toBe(b);
    expect(await decryptSecret("server-key", a)).toBe("re_123");
    await expect(decryptSecret("other-key", a)).rejects.toThrow();
  });
});

describe("MIME", () => {
  it("encodes non-ASCII headers, strips line breaks and base64-encodes the body", () => {
    const m = buildMime({ from: "ops@example.com", fromName: "Ops Team", to: ["a@x.co", "b@x.co"], cc: ["c@x.co"], subject: "Bericht über\r\nBcc: evil@x.co", body: "Hallo Welt", format: "html", messageId: "<1@rowflare>", date: new Date(Date.UTC(2026, 9, 13, 9, 30)) });
    const [head, body] = m.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      'From: "Ops Team" <ops@example.com>',
      "To: a@x.co, b@x.co",
      "Cc: c@x.co",
      `Subject: =?UTF-8?B?${b64("Bericht über Bcc: evil@x.co")}?=`,
      "Date: Tue, 13 Oct 2026 09:30:00 +0000",
      "Message-ID: <1@rowflare>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString()).toBe("Hallo Welt");
  });
});

describe("SMTP", () => {
  const settings = { host: "smtp.test", port: 587, security: "starttls" as const, username: "ops" };

  it("upgrades with STARTTLS, authenticates and sends one message", async () => {
    const f = fakeSmtp();
    const reply = await smtpSend(f.open, settings, "hunter2", { from: "ops@example.com", to: ["a@x.co", "b@x.co"] }, "Subject: hi\r\n\r\n.hidden line");
    expect(f.opened).toEqual([settings]);
    expect(f.written).toEqual(["EHLO rowflare", "STARTTLS", "<tls>", "EHLO rowflare", "AUTH PLAIN " + b64("\0ops\0hunter2"), "MAIL FROM:<ops@example.com>", "RCPT TO:<a@x.co>", "RCPT TO:<b@x.co>", "DATA", "Subject: hi\r\n\r\n..hidden line\r\n.", "QUIT"]);
    expect(reply).toBe("2.0.0 queued as 42");
  });

  it("falls back to AUTH LOGIN", async () => {
    const f = fakeSmtp({ ehlo: ["AUTH LOGIN"] });
    await smtpSend(f.open, { ...settings, security: "none" }, "hunter2", { from: "ops@example.com", to: ["a@x.co"] }, "x");
    expect(f.written.slice(0, 4)).toEqual(["EHLO rowflare", "AUTH LOGIN", b64("ops"), b64("hunter2")]);
  });

  it("fails without STARTTLS when it is required", async () => {
    await expect(smtpSend(fakeSmtp({ ehlo: ["AUTH PLAIN"] }).open, settings, "p", { from: "ops@example.com", to: ["a@x.co"] }, "x")).rejects.toThrow("The SMTP server does not offer STARTTLS");
  });

  it("treats 5xx replies as final and 4xx replies as retryable", async () => {
    const send = (code: number) => smtpSend(fakeSmtp({ reject: { command: "RCPT TO", reply: { code, lines: ["mailbox busy"] } } }).open, settings, "p", { from: "ops@example.com", to: ["a@x.co"] }, "x");
    await expect(send(550)).rejects.toMatchObject({ message: "SMTP RCPT TO failed: 550 mailbox busy", retry: false });
    await expect(send(451)).rejects.toMatchObject({ retry: true });
  });
});

describe("Resend", () => {
  it("posts the message and reads the id; 4xx is final, 5xx retryable", async () => {
    let seen: RequestInit | undefined;
    const ok = (async (_: string, init: RequestInit) => ((seen = init), new Response('{"id":"em_1"}'))) as unknown as typeof fetch;
    expect(await sendResend("re_k", "bot@example.com", "Bot", { to: ["a@x.co"], cc: ["b@x.co"], subject: "S", body: "T", format: "text" }, ok)).toEqual({ messageId: "em_1" });
    expect(new Headers(seen!.headers).get("authorization")).toBe("Bearer re_k");
    expect(JSON.parse(String(seen!.body))).toEqual({ from: "Bot <bot@example.com>", to: ["a@x.co"], cc: ["b@x.co"], subject: "S", text: "T" });
    const status = (n: number) => (async () => new Response("bad", { status: n })) as unknown as typeof fetch;
    await expect(sendResend("re_k", "bot@example.com", null, { to: ["a@x.co"], cc: [], subject: "S", body: "T", format: "text" }, status(422))).rejects.toMatchObject({ message: "Resend answered 422: bad", retry: false });
    await expect(sendResend("re_k", "bot@example.com", null, { to: ["a@x.co"], cc: [], subject: "S", body: "T", format: "text" }, status(503))).rejects.toMatchObject({ retry: true });
  });
});
```

Append to `test/worker/automation-net.test.ts` (and add `import { createNet } from "../../src/worker/auto/net";`, `import { addViewer, HttpClient, ownerWithBase } from "./helpers";`, `import { fakeSmtp } from "../fakes/smtp";` at the top):

```ts
describe("workspace mail settings", () => {
  it("owners save credentials; secrets are never returned", async () => {
    const x = await ownerWithBase("mail-owner");
    const url = `/api/workspaces/${x.wsId}/mail`;
    expect((await x.c.req("PUT", url, { provider: "resend", fromAddress: "bot@example.com" })).json.error).toBe("Enter the Resend API key");
    expect((await x.c.req("PUT", url, { provider: "resend", fromAddress: "bot@example.com", fromName: "Rowflare bot", secret: "re_test_secret_1234" })).status).toBe(200);
    const smtp = { provider: "smtp", fromAddress: "ops@example.com", settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }, secret: "hunter2-pass" };
    expect((await x.c.req("PUT", url, smtp)).status).toBe(200);
    const got = await x.c.req("GET", url);
    expect(got.json.secretKey).toBe(true);
    expect(got.json.system).toEqual({ available: false, from: null });
    expect(got.json.providers).toEqual([
      { provider: "resend", fromAddress: "bot@example.com", fromName: "Rowflare bot", settings: {}, last4: "1234", updatedAt: expect.any(Number) },
      { provider: "smtp", fromAddress: "ops@example.com", fromName: null, settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }, last4: "pass", updatedAt: expect.any(Number) },
    ]);
    expect(JSON.stringify(got.json)).not.toContain("hunter2");
    expect((await x.c.req("PUT", url, { provider: "resend", fromAddress: "team@example.com" })).status).toBe(200);
    expect((await x.c.req("GET", url)).json.providers[0]).toMatchObject({ fromAddress: "team@example.com", last4: "1234" });
    expect((await x.c.req("PUT", url, { provider: "smtp", remove: true })).status).toBe(200);
    expect((await x.c.req("GET", url)).json.providers).toHaveLength(1);
  });

  it("only owners can see or change mail settings", async () => {
    const x = await ownerWithBase("mail-roles");
    const viewer = new HttpClient(await addViewer(x.c, x.wsId, "mail-roles-v@example.com"));
    expect((await viewer.req("GET", `/api/workspaces/${x.wsId}/mail`)).status).toBe(403);
    expect((await viewer.req("PUT", `/api/workspaces/${x.wsId}/mail`, { provider: "resend", fromAddress: "a@b.co", secret: "x" })).status).toBe(403);
  });

  it("validates SMTP settings", async () => {
    const x = await ownerWithBase("mail-valid");
    const url = `/api/workspaces/${x.wsId}/mail`;
    const put = (patch: object) => x.c.req("PUT", url, { provider: "smtp", fromAddress: "ops@example.com", settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }, secret: "p", ...patch });
    expect((await put({ settings: { host: "smtp.example.com", port: 70000, security: "starttls" } })).json.error).toBe("Enter the SMTP port");
    expect((await put({ settings: { host: "smtp.example.com", port: 465, security: "ssl" } })).json.error).toBe("Choose TLS, STARTTLS or none");
    expect((await put({ fromAddress: "nope" })).json.error).toBe("Enter the address emails are sent from");
  });
});

describe("email from automations", () => {
  const mail = { to: ["a@x.co"], cc: [], subject: "Hi", body: "<b>x</b>", format: "html" as const };

  it("sends through Resend with the workspace's key", async () => {
    const x = await ownerWithBase("mail-resend");
    await x.c.req("PUT", `/api/workspaces/${x.wsId}/mail`, { provider: "resend", fromAddress: "bot@example.com", fromName: "Bot", secret: "re_live_9876" });
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response('{"id":"em_1"}'))) as unknown as typeof fetch;
    const net = createNet(env, async () => x.wsId, { fetchFn });
    expect(await net.email({ provider: "resend", ...mail }, 5000)).toEqual({ messageId: "em_1" });
    expect(seen[0].url).toBe("https://api.resend.com/emails");
    expect(new Headers(seen[0].init.headers).get("authorization")).toBe("Bearer re_live_9876");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ from: "Bot <bot@example.com>", to: ["a@x.co"], subject: "Hi", html: "<b>x</b>" });
    await expect(net.email({ provider: "smtp", ...mail }, 5000)).rejects.toThrow("Email sending is not set up for this workspace");
  });

  it("sends through SMTP with the saved settings", async () => {
    const x = await ownerWithBase("mail-smtp");
    await x.c.req("PUT", `/api/workspaces/${x.wsId}/mail`, { provider: "smtp", fromAddress: "ops@example.com", settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }, secret: "hunter2" });
    const f = fakeSmtp();
    const r = await createNet(env, async () => x.wsId, { openSmtp: f.open }).email({ provider: "smtp", ...mail, cc: ["c@x.co"] }, 5000);
    expect(r.messageId).toMatch(/^<.+@rowflare>$/);
    expect(f.opened).toEqual([{ host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }]);
    expect(f.written).toContain("RCPT TO:<c@x.co>");
    expect(f.written).toContain("AUTH PLAIN " + btoa("\0ops\0hunter2"));
  });

  it("system email uses the binding, with a daily quota in cloud mode", async () => {
    const x = await ownerWithBase("mail-system");
    const sent: unknown[] = [];
    const EMAIL = { send: async (m: unknown) => (sent.push(m), { messageId: "cf_1" }) } as unknown as SendEmail;
    const cloud = createNet({ ...env, EMAIL, EMAIL_FROM: "noreply@rowflare.test", MODE: "cloud" }, async () => x.wsId);
    const sys = { provider: "system" as const, ...mail, format: "text" as const, body: "B" };
    expect(await cloud.email(sys, 5000)).toEqual({ messageId: "cf_1" });
    expect(sent[0]).toEqual({ from: "noreply@rowflare.test", to: ["a@x.co"], subject: "Hi", text: "B" });
    await env.DB.prepare("UPDATE mail_usage SET n = 100 WHERE workspace_id = ?").bind(x.wsId).run();
    await expect(cloud.email(sys, 5000)).rejects.toThrow("This workspace sent its 100 system emails for today");
    await expect(createNet(env, async () => x.wsId).email(sys, 5000)).rejects.toThrow("System email is not set up on this server");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit test/unit/mail.test.ts; npx vitest run --project worker test/worker/automation-net.test.ts`
Expected: unit FAIL with "Failed to load url ../../src/worker/secrets"; worker FAIL with 404 from `/api/workspaces/:ws/mail`.

- [ ] **Step 3: Write the implementation**

`migrations/0002_mail.sql`:

```sql
-- Mail credentials per workspace for automation email steps; secrets are encrypted with SECRET_KEY.
CREATE TABLE IF NOT EXISTS workspace_mail (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  settings TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  last4 TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);

-- System emails sent per workspace per day, for the cloud quota.
CREATE TABLE IF NOT EXISTS mail_usage (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, day)
);
```

`src/worker/schema.ts`: `import m0002 from "../../migrations/0002_mail.sql";` and `const MIGRATIONS: [number, string][] = [[1, m0001], [2, m0002]];`.

`src/worker/env.ts`, add:

```ts
  /** Encrypts mail credentials stored in D1; any long random string. */
  SECRET_KEY?: string;
  /** Cloudflare Email Service binding (`send_email`), for the "system" mail provider. */
  EMAIL?: SendEmail;
  /** Sender address for system mail; its domain must be onboarded to Email Service. */
  EMAIL_FROM?: string;
```

`vitest.config.ts`: add `SECRET_KEY: "vitest-secret-key"` to the worker project's `miniflare.bindings`.

`docker/server.mjs:22`: add `"SECRET_KEY", "AUTOMATION_ALLOW_PRIVATE", "AUTOMATION_MONTHLY_RUNS"` to `VARS`.

`src/worker/secrets.ts`:

```ts
// AES-GCM encryption of stored credentials, with a key derived from the SECRET_KEY setting.
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.digest("SHA-256", new TextEncoder().encode("rowflare-secrets:" + secret)).then(raw => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    keys.set(secret, k);
  }
  return k;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

export async function encryptSecret(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(secret), new TextEncoder().encode(plain)));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decryptSecret(secret: string, stored: string): Promise<string> {
  const [v, iv, ct] = stored.split(":");
  if (v !== "v1" || !iv || !ct) throw new Error("Unknown secret format");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await keyFor(secret), unb64(ct));
  return new TextDecoder().decode(plain);
}
```

`src/worker/auto/mime.ts`:

```ts
// A single-part MIME message (UTF-8, base64 body) for SMTP.
export interface MimeMessage {
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  format: "text" | "html";
  messageId: string;
  date: Date;
}

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

export function b64utf8(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Header text; non-ASCII becomes an RFC 2047 encoded word, and line breaks cannot add headers. */
function headerText(s: string): string {
  const t = oneLine(s);
  return ascii(t) ? t : `=?UTF-8?B?${b64utf8(t)}?=`;
}

function mailbox(email: string, name?: string): string {
  if (!name) return email;
  const n = oneLine(name);
  return ascii(n) ? `"${n.replace(/["\\]/g, "\\$&")}" <${email}>` : `${headerText(n)} <${email}>`;
}

export function buildMime(m: MimeMessage): string {
  const lines = [
    `From: ${mailbox(m.from, m.fromName)}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${headerText(m.subject)}`,
    `Date: ${m.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${m.messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: text/${m.format === "html" ? "html" : "plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    ...(b64utf8(m.body).match(/.{1,76}/g) ?? [""]),
  ];
  return lines.join("\r\n");
}
```

`src/worker/auto/smtp.ts`:

```ts
// A minimal SMTP client (RFC 5321) for automation emails: EHLO, STARTTLS, AUTH PLAIN or LOGIN, one message.
import { StepError } from "./types";

export interface SmtpReply {
  code: number;
  lines: string[];
}

/** A line connection: read() returns one complete reply, write() sends one line (CRLF is added). */
export interface SmtpConn {
  read(): Promise<SmtpReply>;
  write(line: string): Promise<void>;
  startTls(): Promise<SmtpConn>;
  close(): Promise<void>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string;
}

function b64(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function expectReply(c: SmtpConn, what: string, codes: number[]): Promise<SmtpReply> {
  const r = await c.read();
  if (!codes.includes(r.code)) throw new StepError(`SMTP ${what} failed: ${r.code} ${r.lines.join(" ")}`.slice(0, 300), r.code >= 400 && r.code < 500);
  return r;
}

/** Sends a command; errors name the command only, never its arguments (AUTH carries the password). */
async function command(c: SmtpConn, line: string, codes: number[], what = line.split(" ")[0]): Promise<SmtpReply> {
  await c.write(line);
  return expectReply(c, what, codes);
}

/** Sends one message; `data` is the whole MIME text. Returns the server's final reply. */
export async function smtpSend(open: (s: SmtpSettings) => Promise<SmtpConn>, s: SmtpSettings, password: string, envelope: { from: string; to: string[] }, data: string): Promise<string> {
  let c = await open(s);
  try {
    await expectReply(c, "greeting", [220]);
    let ehlo = await command(c, "EHLO rowflare", [250]);
    if (s.security === "starttls") {
      if (!ehlo.lines.some(l => /^STARTTLS\b/i.test(l))) throw new StepError("The SMTP server does not offer STARTTLS");
      await command(c, "STARTTLS", [220]);
      c = await c.startTls();
      ehlo = await command(c, "EHLO rowflare", [250]);
    }
    if (s.username) {
      const auth = ehlo.lines.find(l => /^AUTH\b/i.test(l)) ?? "";
      if (/\bPLAIN\b/i.test(auth)) await command(c, "AUTH PLAIN " + b64(`\0${s.username}\0${password}`), [235], "AUTH");
      else {
        await command(c, "AUTH LOGIN", [334], "AUTH");
        await command(c, b64(s.username), [334], "AUTH");
        await command(c, b64(password), [235], "AUTH");
      }
    }
    await command(c, `MAIL FROM:<${envelope.from}>`, [250], "MAIL FROM");
    for (const r of envelope.to) await command(c, `RCPT TO:<${r}>`, [250, 251], "RCPT TO");
    await command(c, "DATA", [354]);
    // Lines starting with a dot are doubled (RFC 5321 4.5.2); a lone dot ends the message.
    await c.write(data.split("\r\n").map(l => (l.startsWith(".") ? "." + l : l)).join("\r\n") + "\r\n.");
    const done = await expectReply(c, "DATA", [250]);
    await c.write("QUIT").catch(() => undefined);
    return done.lines.join(" ");
  } finally {
    await c.close().catch(() => undefined);
  }
}
```

`src/worker/auto/smtp-socket.ts`:

```ts
// SMTP over Cloudflare TCP sockets (also available in workerd, so the Docker image can send mail).
import { connect } from "cloudflare:sockets";
import type { SmtpConn, SmtpSettings } from "./smtp";
import { StepError } from "./types";

function wrap(socket: Socket): SmtpConn {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const line = async (): Promise<string> => {
    for (;;) {
      const i = buf.indexOf("\r\n");
      if (i >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        return l;
      }
      const { done, value } = await reader.read();
      if (done) throw new StepError("The SMTP server closed the connection", true);
      buf += dec.decode(value, { stream: true });
    }
  };
  return {
    async read() {
      const lines: string[] = [];
      for (;;) {
        const l = await line();
        lines.push(l.slice(4));
        if (l[3] !== "-") return { code: Number(l.slice(0, 3)), lines };
      }
    },
    async write(l) {
      await writer.write(enc.encode(l + "\r\n"));
    },
    async startTls() {
      reader.releaseLock();
      writer.releaseLock();
      return wrap(socket.startTls());
    },
    async close() {
      await socket.close();
    },
  };
}

export async function openSmtp(s: SmtpSettings): Promise<SmtpConn> {
  try {
    const socket = connect({ hostname: s.host, port: s.port }, { secureTransport: s.security === "tls" ? "on" : s.security === "starttls" ? "starttls" : "off", allowHalfOpen: false });
    await socket.opened;
    return wrap(socket);
  } catch (e) {
    throw new StepError(`Could not connect to ${s.host}:${s.port}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
```

`src/worker/auto/mail.ts`:

```ts
// Sends automation emails through a workspace's provider: Cloudflare Email Service, Resend or SMTP.
import type { Env } from "../env";
import { LIMITS, type MailProvider } from "../../shared/automations";
import { decryptSecret } from "../secrets";
import { buildMime } from "./mime";
import { smtpSend, type SmtpConn, type SmtpSettings } from "./smtp";
import { StepError } from "./types";

export interface OutMail {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  format: "text" | "html";
}

export interface MailDeps {
  env: Env;
  fetchFn?: typeof fetch;
  openSmtp?: (s: SmtpSettings) => Promise<SmtpConn>;
}

interface MailRow {
  from_address: string;
  from_name: string | null;
  settings: string;
  secret_enc: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepError("The mail server did not answer in time", true)), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendResend(key: string, from: string, fromName: string | null, m: OutMail, fetchFn: typeof fetch = fetch): Promise<{ messageId?: string }> {
  let res: Response;
  try {
    res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromName ? `${fromName} <${from}>` : from, to: m.to, ...(m.cc.length ? { cc: m.cc } : {}), subject: m.subject, ...(m.format === "html" ? { html: m.body } : { text: m.body }) }),
    });
  } catch (e) {
    throw new StepError(`Could not reach Resend: ${message(e)}`, true);
  }
  const text = await res.text();
  if (!res.ok) throw new StepError(`Resend answered ${res.status}: ${text.slice(0, 300)}`, res.status >= 500 || res.status === 429);
  try {
    return { messageId: String(JSON.parse(text).id) };
  } catch {
    return {};
  }
}

export async function sendSystem(binding: SendEmail, from: string, m: OutMail): Promise<{ messageId?: string }> {
  const msg = { from, to: m.to, subject: m.subject, ...(m.cc.length ? { cc: m.cc } : {}), ...(m.format === "html" ? { html: m.body } : { text: m.body }) } as EmailMessageBuilder;
  try {
    return { messageId: (await binding.send(msg)).messageId };
  } catch (e) {
    throw new StepError(`Cloudflare Email could not send: ${message(e)}`);
  }
}

/** Sends one email for a workspace. Failures are StepErrors that say what to fix. */
export async function sendWorkspaceMail(d: MailDeps, workspaceId: string, provider: MailProvider, m: OutMail, timeoutMs: number): Promise<{ messageId?: string }> {
  const { env } = d;
  if (provider === "system") {
    if (!env.EMAIL || !env.EMAIL_FROM) throw new StepError("System email is not set up on this server");
    if (env.MODE === "cloud") {
      const day = new Date().toISOString().slice(0, 10);
      const r = await env.DB.prepare("INSERT INTO mail_usage (workspace_id, day, n) VALUES (?, ?, 1) ON CONFLICT(workspace_id, day) DO UPDATE SET n = n + 1 RETURNING n").bind(workspaceId, day).first<{ n: number }>();
      if ((r?.n ?? 0) > LIMITS.systemMailPerDay) throw new StepError(`This workspace sent its ${LIMITS.systemMailPerDay} system emails for today`);
    }
    return withTimeout(sendSystem(env.EMAIL, env.EMAIL_FROM, m), timeoutMs);
  }
  const row = await env.DB.prepare("SELECT from_address, from_name, settings, secret_enc FROM workspace_mail WHERE workspace_id = ? AND provider = ?").bind(workspaceId, provider).first<MailRow>();
  if (!row) throw new StepError("Email sending is not set up for this workspace");
  if (!env.SECRET_KEY) throw new StepError("SECRET_KEY is not set on this server");
  let secret: string;
  try {
    secret = await decryptSecret(env.SECRET_KEY, row.secret_enc);
  } catch {
    throw new StepError("The saved mail credentials cannot be read; save them again");
  }
  if (provider === "resend") return withTimeout(sendResend(secret, row.from_address, row.from_name, m, d.fetchFn), timeoutMs);
  const settings = JSON.parse(row.settings) as SmtpSettings;
  const open = d.openSmtp ?? (await import("./smtp-socket")).openSmtp;
  const messageId = `<${crypto.randomUUID()}@rowflare>`;
  const data = buildMime({ from: row.from_address, fromName: row.from_name ?? undefined, to: m.to, cc: m.cc, subject: m.subject, body: m.body, format: m.format, messageId, date: new Date() });
  try {
    await withTimeout(smtpSend(open, settings, secret, { from: row.from_address, to: [...m.to, ...m.cc] }, data), timeoutMs);
  } catch (e) {
    if (e instanceof StepError) throw e;
    throw new StepError(`Could not send through SMTP: ${message(e)}`, true);
  }
  return { messageId };
}
```

`src/worker/auto/net.ts`, replace with:

```ts
// The real network side of automation steps for a base's Durable Object.
import type { Env } from "../env";
import { httpRequest } from "./http";
import { sendWorkspaceMail } from "./mail";
import type { SmtpConn, SmtpSettings } from "./smtp";
import { StepError, type Net } from "./types";

export interface NetOptions {
  fetchFn?: typeof fetch;
  openSmtp?: (s: SmtpSettings) => Promise<SmtpConn>;
}

export function createNet(env: Env, workspaceId: () => Promise<string | null>, opts: NetOptions = {}): Net {
  return {
    http: (req, timeoutMs) => httpRequest(req, { timeoutMs, allowPrivate: env.AUTOMATION_ALLOW_PRIVATE === "true", fetchFn: opts.fetchFn }),
    async email(req, timeoutMs) {
      const ws = await workspaceId();
      if (!ws) throw new StepError("This base belongs to no workspace");
      return sendWorkspaceMail({ env, fetchFn: opts.fetchFn, openSmtp: opts.openSmtp }, ws, req.provider, req, timeoutMs);
    },
  };
}
```

`src/worker/base-do.ts`: replace `this.net = createNet(env);` with:

```ts
    this.net = createNet(env, () => this.workspaceId());
```

and add the method next to `baseUrl()`:

```ts
  private wsId?: string | null;
  /** The base's workspace, for mail credentials; looked up once per object. */
  private async workspaceId(): Promise<string | null> {
    if (this.wsId === undefined) {
      const row = await this.env.DB.prepare("SELECT workspace_id FROM bases WHERE id = ?").bind(this.store.meta("baseId") ?? "").first<{ workspace_id: string }>();
      this.wsId = row?.workspace_id ?? null;
    }
    return this.wsId;
  }
```

`src/worker/routes-automations.ts`: add imports and routes:

```ts
import { requireUser } from "./access";
import { encryptSecret } from "./secrets";
import { sendWorkspaceMail } from "./auto/mail";
import type { MailProvider } from "../shared/automations";

const EMAIL_RE = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;

async function requireOwner(c: AppContext, wsId: string) {
  const u = requireUser(c);
  const m = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(wsId, u.id).first<{ role: string }>();
  if (!m) throw new HttpError(404, "Workspace not found");
  if (m.role !== "owner") throw new HttpError(403, "Only workspace owners can do that");
  return u;
}

automationRoutes.get("/workspaces/:ws/mail", async c => {
  const ws = c.req.param("ws");
  await requireOwner(c, ws);
  const { results } = await c.env.DB.prepare("SELECT provider, from_address, from_name, settings, last4, updated_at FROM workspace_mail WHERE workspace_id = ? ORDER BY provider")
    .bind(ws)
    .all<{ provider: string; from_address: string; from_name: string | null; settings: string; last4: string; updated_at: number }>();
  return c.json({
    system: { available: !!(c.env.EMAIL && c.env.EMAIL_FROM), from: c.env.EMAIL_FROM ?? null },
    secretKey: !!c.env.SECRET_KEY,
    providers: results.map(r => ({ provider: r.provider, fromAddress: r.from_address, fromName: r.from_name, settings: JSON.parse(r.settings), last4: r.last4, updatedAt: r.updated_at })),
  });
});

automationRoutes.put("/workspaces/:ws/mail", async c => {
  const ws = c.req.param("ws");
  await requireOwner(c, ws);
  const b = await body<{ provider: string; fromAddress?: string; fromName?: string; settings?: Record<string, unknown>; secret?: string; remove?: boolean }>(c);
  if (b.provider !== "resend" && b.provider !== "smtp") throw new HttpError(400, "Choose Resend or SMTP");
  if (b.remove) {
    await c.env.DB.prepare("DELETE FROM workspace_mail WHERE workspace_id = ? AND provider = ?").bind(ws, b.provider).run();
    return c.json({ ok: true });
  }
  if (!c.env.SECRET_KEY) throw new HttpError(400, "Set the SECRET_KEY environment variable to store mail credentials");
  const from = String(b.fromAddress ?? "").trim();
  if (!EMAIL_RE.test(from)) throw new HttpError(400, "Enter the address emails are sent from");
  let settings: Record<string, unknown> = {};
  if (b.provider === "smtp") {
    const s = b.settings ?? {};
    const host = String(s.host ?? "").trim();
    const port = Number(s.port);
    if (!host || /[\s/]/.test(host)) throw new HttpError(400, "Enter the SMTP host");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Enter the SMTP port");
    if (!["tls", "starttls", "none"].includes(String(s.security))) throw new HttpError(400, "Choose TLS, STARTTLS or none");
    settings = { host, port, security: s.security, username: String(s.username ?? "").trim() };
  }
  const existing = await c.env.DB.prepare("SELECT secret_enc, last4 FROM workspace_mail WHERE workspace_id = ? AND provider = ?").bind(ws, b.provider).first<{ secret_enc: string; last4: string }>();
  const secret = typeof b.secret === "string" ? b.secret.trim() : "";
  if (!secret && !existing) throw new HttpError(400, b.provider === "resend" ? "Enter the Resend API key" : "Enter the SMTP password");
  if (secret.length > 500) throw new HttpError(400, "The secret is too long");
  const enc = secret ? await encryptSecret(c.env.SECRET_KEY, secret) : existing!.secret_enc;
  const last4 = secret ? secret.slice(-4) : existing!.last4;
  await c.env.DB.prepare(
    "INSERT INTO workspace_mail (workspace_id, provider, from_address, from_name, settings, secret_enc, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, provider) DO UPDATE SET from_address = excluded.from_address, from_name = excluded.from_name, settings = excluded.settings, secret_enc = excluded.secret_enc, last4 = excluded.last4, updated_at = excluded.updated_at",
  )
    .bind(ws, b.provider, from, String(b.fromName ?? "").trim() || null, JSON.stringify(settings), enc, last4, Date.now())
    .run();
  return c.json({ ok: true });
});

automationRoutes.post("/workspaces/:ws/mail/test", async c => {
  const ws = c.req.param("ws");
  const u = await requireOwner(c, ws);
  const b = await body<{ provider: MailProvider; to?: string }>(c);
  const to = String(b.to ?? u.email).trim();
  if (!EMAIL_RE.test(to)) throw new HttpError(400, "Enter a valid address");
  try {
    await sendWorkspaceMail({ env: c.env }, ws, b.provider, { to: [to], cc: [], subject: "Rowflare test email", body: "Email sending works. Automations in this workspace can now send email.", format: "text" }, 15_000);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  return c.json({ ok: true, to });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit test/unit/mail.test.ts && npx vitest run --project worker test/worker/automation-net.test.ts && npm run typecheck`
Expected: PASS (7 unit tests, 7 worker tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: whole suite passes. Record in the ledger: `Task 9: mail.test.ts 7/7, automation-net.test.ts 7/7, suite <N>/<N>`.

---

### Task 10: Webhooks, buttons, test runs and run again

**Files:**
- Modify: `src/worker/base-do.ts` (RPC `webhook`, `runButton`, `testRun`, `retryRun`)
- Modify: `src/worker/auto/repo.ts` (`toPublic`)
- Modify: `src/worker/routes-automations.ts` (routes)
- Modify: `src/worker/access.ts` (`BaseStub` keys)
- Modify: `src/worker/index.ts` (CSRF exemption for `/api/hooks/`)
- Test: `test/worker/automation-http.test.ts`

**Interfaces:**
- Consumes: `AutomationEngine.execute` (Task 7); `AutomationRepo.byToken`, `enqueue`, `insertRun`, `getRun`, `saveRun` (Task 4); `RECORD_SOURCES`, `LIMITS`.
- Produces (DO): `webhook(token, body): Promise<{ status: number; body: Record<string, unknown> }>`, `runButton(actor, id, recordId, canEdit): Promise<Result<{ id: number; status: RunStatus; error: string | null }>>`, `testRun(actor, id, input: { recordId?: number; body?: unknown }): Promise<Result<AutomationRun>>`, `retryRun(runId): Promise<Result<{ runId: number }>>`.
- Produces (routes): `POST /api/hooks/:baseId/:token`, `POST /api/bases/:base/automations/:id/run`, `POST /api/bases/:base/automations/:id/test`, `POST /api/bases/:base/runs/:runId/retry`.
- Produces (repo): `toPublic(run: RunRecord): AutomationRun`.

- [ ] **Step 1: Write the failing test**

`test/worker/automation-http.test.ts`:

```ts
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import { addViewer, HttpClient, ownerWithBase } from "./helpers";

async function crm(prefix: string) {
  const o = await ownerWithBase(prefix);
  const { schema } = (await o.c.req("GET", `/api/bases/${o.baseId}`)).json;
  const deals = schema.tables.find((t: any) => t.name === "Deals");
  const field = (name: string) => schema.fields.find((f: any) => f.tableId === deals.id && f.name === name);
  const url = `/api/bases/${o.baseId}/automations`;
  const create = async (name: string, config: object, enabled = true) => (await o.c.req("POST", url, { op: "create", name, enabled, config })).json;
  return { ...o, schema, deals, field, url, create };
}

/** Runs whatever is queued, whether or not Miniflare already fired the alarm. */
async function settle(baseId: string) {
  const stub = env.BASE.get(env.BASE.idFromName(baseId));
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, (i: BaseDO) => i.engine.drain());
}

const hook = (baseId: string, token: string, init: RequestInit) => SELF.fetch(`https://app.test/api/hooks/${baseId}/${token}`, { method: "POST", ...init });

describe("webhooks", () => {
  it("a webhook call queues a run that creates a record, also with a session cookie and no x-rf header", async () => {
    const x = await crm("hook-create");
    const r = await x.create("Inbound", { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: x.deals.id, values: { [x.field("Name").id]: "{{trigger.body.deal}}" } }] });
    const token = r.automations[0].config.trigger.token;
    const res = await hook(x.baseId, token, { headers: { "Content-Type": "application/json", Cookie: x.c.cookie }, body: JSON.stringify({ deal: "From the hook" }) });
    expect(res.status).toBe(202);
    const { runId } = await res.json<{ runId: number }>();
    await settle(x.baseId);
    const runs = (await x.c.req("GET", `${x.url}/${r.id}/runs`)).json;
    expect(runs[0]).toMatchObject({ id: runId, status: "succeeded", trigger: { type: "webhook", body: { deal: "From the hook" } } });
    expect((await x.c.req("POST", `/api/bases/${x.baseId}/query`, { tableId: x.deals.id, search: "From the hook" })).json.total).toBe(1);
  });

  it("rejects unknown tokens, turned off automations, broken JSON and large bodies", async () => {
    const x = await crm("hook-errors");
    const on = await x.create("On", { trigger: { type: "webhook", token: "" }, steps: [] });
    const off = await x.create("Off", { trigger: { type: "webhook", token: "" }, steps: [] }, false);
    const tokenOn = on.automations[0].config.trigger.token;
    const tokenOff = off.automations.find((a: any) => a.name === "Off").config.trigger.token;
    expect((await hook(x.baseId, "x".repeat(32), { body: "{}" })).status).toBe(404);
    expect((await hook("appNope", tokenOn, { body: "{}" })).status).toBe(404);
    expect((await hook(x.baseId, tokenOff, { body: "{}" })).status).toBe(404);
    const broken = await hook(x.baseId, tokenOn, { headers: { "Content-Type": "application/json" }, body: "{oops" });
    expect([broken.status, (await broken.json<{ error: string }>()).error]).toEqual([400, "The body is not valid JSON"]);
    expect((await hook(x.baseId, tokenOn, { body: "x".repeat(300 * 1024) })).status).toBe(413);
    expect((await x.c.req("GET", `${x.url}/${on.id}/runs`)).json).toHaveLength(0);
    const form = await hook(x.baseId, tokenOn, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=Ada&plan=pro" });
    expect(form.status).toBe(202);
    expect((await x.c.req("GET", `${x.url}/${on.id}/runs`)).json[0].trigger.body).toEqual({ name: "Ada", plan: "pro" });
  });

  it("allows 60 calls per minute per base", async () => {
    const x = await crm("hook-rate");
    const on = await x.create("On", { trigger: { type: "webhook", token: "" }, steps: [] });
    const token = on.automations[0].config.trigger.token;
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await hook(x.baseId, token, { body: "{}" })).status);
    expect(statuses.slice(0, 60).every(s => s === 202)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe("buttons, test runs and run again", () => {
  it("buttons run for editors, and for viewers only when allowed", async () => {
    const x = await crm("button-run");
    const rid = (await x.c.req("POST", `/api/bases/${x.baseId}/query`, { tableId: x.deals.id, limit: 1 })).json.ids[0];
    const mk = (viewerCanRun: boolean, enabled = true) => x.create("Approve", { trigger: { type: "button", tableId: x.deals.id, viewerCanRun }, steps: [{ id: "s1", type: "updateRecords", target: "trigger", tableId: x.deals.id, values: { [x.field("Name").id]: "Approved" } }] }, enabled);
    const locked = (await mk(false)).id;
    const open = (await mk(true)).id;
    const off = (await mk(true, false)).id;
    const viewer = new HttpClient(await addViewer(x.c, x.wsId, "button-run-v@example.com"));
    const run = (c: HttpClient, id: string, recordId = rid) => c.req("POST", `${x.url}/${id}/run`, { recordId });
    expect((await run(viewer, locked)).status).toBe(403);
    const ok = await run(x.c, locked);
    expect(ok.json).toEqual({ id: expect.any(Number), status: "succeeded", error: null });
    expect((await run(viewer, open)).json.status).toBe("succeeded");
    expect((await run(x.c, off)).json.error).toBe("This automation is turned off");
    expect((await run(x.c, open, 999999)).status).toBe(404);
  });

  it("test runs return their steps and do not count against the quota", async () => {
    const x = await crm("test-run");
    const rid = (await x.c.req("POST", `/api/bases/${x.baseId}/query`, { tableId: x.deals.id, limit: 1 })).json.ids[0];
    const a = await x.create("Check", { trigger: { type: "recordUpdated", tableId: x.deals.id }, steps: [{ id: "s1", type: "branch", match: "all", conditions: [{ left: `{{trigger.record.${x.field("Name").id}}}`, op: "notempty" }], then: [], else: [] }] });
    const res = await x.c.req("POST", `${x.url}/${a.id}/test`, { recordId: rid });
    expect(res.json).toMatchObject({ test: true, status: "succeeded", steps: [{ id: "s1", status: "ok", output: { matched: true } }] });
    expect(res.json.snapshot).toBeUndefined();
    expect((await x.c.req("GET", x.url)).json.usage.used).toBe(0);
    expect((await x.c.req("POST", `${x.url}/${a.id}/test`, {})).json.error).toBe("Choose a record to test with");
  });

  it("a failed run can be run again; other runs cannot", async () => {
    const x = await crm("run-again");
    const a = await x.create("Inner", { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "http", method: "GET", url: "http://10.0.0.1/x", headers: [] }] });
    await hook(x.baseId, a.automations[0].config.trigger.token, { body: "{}" });
    await settle(x.baseId);
    const failed = (await x.c.req("GET", `${x.url}/${a.id}/runs`)).json[0];
    expect(failed.status).toBe("failed");
    const again = await x.c.req("POST", `/api/bases/${x.baseId}/runs/${failed.id}/retry`, {});
    expect(again.json).toEqual({ runId: failed.id });
    expect((await x.c.req("GET", `${x.url}/${a.id}/runs`)).json[0]).toMatchObject({ status: "queued", attempt: 0, error: null });
    await settle(x.baseId);
    expect((await x.c.req("POST", `/api/bases/${x.baseId}/runs/${failed.id}/retry`, {})).status).toBe(200);
    expect((await x.c.req("POST", `/api/bases/${x.baseId}/runs/123456/retry`, {})).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project worker test/worker/automation-http.test.ts`
Expected: FAIL; the hook and run routes answer 404 "Not found".

- [ ] **Step 3: Write the implementation**

`src/worker/auto/repo.ts`, add:

```ts
/** A run without its definition snapshot, for API answers. */
export function toPublic(run: RunRecord): AutomationRun {
  const { snapshot: _, ...rest } = run;
  return rest;
}
```

and make `runs()` use it: `.map(r => toPublic(this.toRun(r)))`. (`AutomationEngine.execute` returns the full `RunRecord`; answers to clients go through `toPublic`.)

`src/worker/base-do.ts`:
- Imports: add `RECORD_SOURCES`, `type RunStatus` to the `../shared/automations` import and `toPublic` to the `./auto/repo` import.
- Add after `automationRuns`:

```ts
  private hookWindow = { minute: 0, count: 0 };

  /** An incoming webhook call; answers right away and leaves the run to the alarm. */
  async webhook(token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const a = this.automations.byToken(token);
    if (!a || !a.enabled) return { status: 404, body: { error: "Webhook not found" } };
    const minute = Math.floor(Date.now() / 60_000);
    if (this.hookWindow.minute !== minute) this.hookWindow = { minute, count: 0 };
    if (++this.hookWindow.count > LIMITS.webhookPerMinute) return { status: 429, body: { error: `At most ${LIMITS.webhookPerMinute} webhook calls per minute per base` } };
    const now = Date.now();
    const runId = this.automations.enqueue(a, { type: "webhook", body, at: now }, [a.id], now, this.monthlyRuns);
    await this.wake();
    return { status: 202, body: { runId } };
  }

  /** A button click: runs right away so the person sees the result. Viewers get only the outcome, not the step log. */
  async runButton(actor: Actor, id: string, recordId: number, canEdit: boolean): Promise<Result<{ id: number; status: RunStatus; error: string | null }>> {
    const a = this.automations.all().find(x => x.id === id);
    const t = a?.config.trigger;
    if (!a || t?.type !== "button") return { ok: false, error: "Automation not found", status: 404 };
    if (!canEdit && !t.viewerCanRun) return { ok: false, error: "You cannot run this automation", status: 403 };
    if (!a.enabled) return { ok: false, error: "This automation is turned off" };
    if (!this.store.maybeTable(t.tableId) || !this.store.getRows(t.tableId, [recordId]).length) return { ok: false, error: "Record not found", status: 404 };
    const now = Date.now();
    const runId = this.automations.enqueue(a, { type: "button", tableId: t.tableId, recordId, at: now, by: actor.userId }, [a.id], now, this.monthlyRuns);
    const queued = this.automations.getRun(runId)!;
    const run = queued.status === "queued" ? await this.engine.execute(runId) : queued;
    await this.wake();
    return { ok: true, value: { id: run.id, status: run.status, error: run.error } };
  }

  /** Runs an automation once with a chosen record or sample body; writes are real, nothing else is triggered, nothing is counted. */
  async testRun(actor: Actor, id: string, input: { recordId?: number; body?: unknown }): Promise<Result<AutomationRun>> {
    const a = this.automations.all().find(x => x.id === id);
    if (!a) return { ok: false, error: "Automation not found", status: 404 };
    const t = a.config.trigger;
    const tableId = "tableId" in t ? t.tableId : undefined;
    let recordId: number | undefined;
    if (tableId && RECORD_SOURCES.has(t.type)) {
      recordId = Number(input?.recordId);
      if (!Number.isInteger(recordId) || !this.store.maybeTable(tableId) || !this.store.getRows(tableId, [recordId]).length) return { ok: false, error: "Choose a record to test with" };
    }
    const now = Date.now();
    const trigger = { type: t.type, tableId, recordId, body: t.type === "webhook" ? input?.body ?? {} : undefined, at: now, by: actor.userId };
    const runId = this.automations.insertRun({ automation: a, status: "running", test: true, trigger, chain: [a.id], now });
    return { ok: true, value: toPublic(await this.engine.execute(runId)) };
  }

  /** Puts a failed run back in the queue; it resumes at the step that failed. */
  async retryRun(runId: number): Promise<Result<{ runId: number }>> {
    const run = this.automations.getRun(runId);
    if (!run) return { ok: false, error: "Run not found", status: 404 };
    if (run.status !== "failed" || run.test) return { ok: false, error: "Only failed runs can be run again" };
    this.automations.saveRun(runId, { status: "queued", attempt: 0, error: null, nextAt: null, finishedAt: null });
    await this.wake();
    return { ok: true, value: { runId } };
  }
```

`src/worker/access.ts`: add `"webhook" | "runButton" | "testRun" | "retryRun"` to the `BaseStub` keys.

`src/worker/index.ts`: in the auth middleware, change `exempt` to:

```ts
  const exempt = c.req.path.startsWith("/api/stripe/") || c.req.path.startsWith("/api/forms/") || c.req.path.startsWith("/api/hooks/");
```

`src/worker/routes-automations.ts`: add `import { stubFor } from "./access";` and `import { LIMITS } from "../shared/automations";`, then:

```ts
automationRoutes.post("/bases/:base/automations/:id/run", async c => {
  const a = await baseAccess(c, c.req.param("base"), "read");
  const b = await body<{ recordId: number }>(c);
  const canEdit = ROLE_RANK[a.role] >= ROLE_RANK.editor && a.writable;
  return c.json(unwrap(await a.stub.runButton(a.actor, c.req.param("id"), Number(b.recordId), canEdit)));
});

automationRoutes.post("/bases/:base/automations/:id/test", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  const b = await body<{ recordId?: number; body?: unknown }>(c);
  return c.json(unwrap(await a.stub.testRun(a.actor, c.req.param("id"), b)));
});

automationRoutes.post("/bases/:base/runs/:runId/retry", async c => {
  const a = await baseAccess(c, c.req.param("base"), "write");
  return c.json(unwrap(await a.stub.retryRun(Number(c.req.param("runId")))));
});

function hookBody(type: string, text: string): unknown {
  if (!text.trim()) return {};
  if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "The body is not valid JSON");
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(text));
  return { text };
}

/** Incoming webhooks: the token in the URL is the credential. */
automationRoutes.post("/hooks/:baseId/:token", async c => {
  const tooLarge = () => new HttpError(413, `The body is larger than ${LIMITS.webhookBytes / 1024} KB`);
  if (Number(c.req.header("Content-Length") ?? "0") > LIMITS.webhookBytes) throw tooLarge();
  const raw = await c.req.arrayBuffer();
  if (raw.byteLength > LIMITS.webhookBytes) throw tooLarge();
  const payload = hookBody(c.req.header("Content-Type") ?? "", new TextDecoder().decode(raw));
  const base = await c.env.DB.prepare("SELECT id FROM bases WHERE id = ?").bind(c.req.param("baseId")).first<{ id: string }>();
  if (!base) throw new HttpError(404, "Webhook not found");
  const res = await stubFor(c.env, base.id).webhook(c.req.param("token"), payload);
  return c.json(res.body, res.status as 202);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project worker test/worker/automation-http.test.ts && npm run typecheck`
Expected: PASS (6 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: whole suite passes. Record in the ledger: `Task 10: automation-http.test.ts 6/6, suite <N>/<N>`.

---

### Task 11: MCP automation tools

**Files:**
- Create: `src/worker/mcp/tools-automation.ts`
- Modify: `src/worker/mcp/server.ts` (register)
- Modify: `test/worker/mcp.test.ts` (tool list grows to 24)
- Modify: `docs/mcp.md` (tool rows and an "Automations" section)
- Test: `test/worker/mcp-automations.test.ts`

**Interfaces:**
- Consumes: `automationList`, `automationOp`, `automationRuns` (Task 4); `fromDisplay`, `toDisplay`, `NameContext` (Task 2); `flatSteps`, `triggerTableId` and the type lists (Task 1); `tableOf`, `fieldsOf`, `fieldOf`, `unwrap` (`src/worker/records.ts`); `choiceId` (`src/worker/mcp/translate.ts`); `guard` (`src/worker/mcp/result.ts`); `FILTER_OPS`, `sortSchema` (`src/worker/mcp/schemas.ts`).
- Produces: `registerAutomationTools(server, c)` with the tools `list_automations`, `get_automation`, `create_automation`, `update_automation`.

- [ ] **Step 1: Write the failing test**

`test/worker/mcp-automations.test.ts`:

```ts
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
```

In `test/worker/mcp.test.ts`, the exact tool list assertion gains `"create_automation"`, `"get_automation"`, `"list_automations"`, `"update_automation"` (24 tools), in the order the test already uses (sorted).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project worker test/worker/mcp-automations.test.ts test/worker/mcp.test.ts`
Expected: FAIL with "Tool create_automation not found" and the tool list assertion showing 20 tools.

- [ ] **Step 3: Write the implementation**

`src/worker/mcp/tools-automation.ts`:

```ts
// Automation tools: list, read with recent runs, create and edit using table and field names.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Field, FilterSpec, Schema } from "../../shared/types";
import { BRANCH_OPS, flatSteps, HTTP_METHODS, MAIL_PROVIDERS, STEP_TYPES, TRIGGER_TYPES, triggerTableId, type Automation, type AutomationConfig, type AutomationOp, type Step, type Trigger } from "../../shared/automations";
import { fromDisplay, toDisplay, type NameContext } from "../../shared/template";
import { baseAccess, HttpError, ROLE_RANK, type AppContext, type BaseAccess } from "../access";
import { fieldOf, fieldsOf, tableOf, unwrap } from "../records";
import { guard } from "./result";
import { FILTER_OPS, sortSchema } from "./schemas";
import { choiceId } from "./translate";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const filterInput = z.object({
  conjunction: z.enum(["and", "or"]).optional(),
  conditions: z.array(z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: z.unknown().optional() })).max(20),
});
type FilterIn = z.infer<typeof filterInput>;

const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  table: z.string().optional().describe("Table name or id (record, date and button triggers)"),
  filter: filterInput.optional().describe("Record and date triggers: only records matching this; recordMatches fires when a record starts to match"),
  watch: z.array(z.string()).max(50).optional().describe("recordUpdated: only changes to these fields"),
  every: z.enum(["hour", "day", "week", "month"]).optional(),
  interval: z.number().int().min(1).max(24).optional().describe("schedule every hour: hours between runs"),
  at: z.string().optional().describe("HH:MM local time (schedule; dateReached for date-only fields, default 09:00)"),
  weekday: z.number().int().min(0).max(6).optional().describe("0 is Sunday"),
  monthday: z.number().int().min(1).max(31).optional(),
  timezone: z.string().optional().describe("IANA time zone, default UTC"),
  dateField: z.string().optional(),
  offsetMinutes: z.number().int().optional().describe("dateReached: minutes after the date (negative for before)"),
  viewerCanRun: z.boolean().optional(),
});
type TriggerIn = z.infer<typeof triggerSchema>;

const baseStep = z.object({
  id: z.string().regex(/^[A-Za-z0-9_]{1,40}$/).optional().describe("Id for {{steps.<id>...}}; s1, s2, ... when missing"),
  type: z.enum(STEP_TYPES),
  table: z.string().optional(),
  values: z.record(z.string(), z.string()).optional().describe("createRecord, updateRecords: field name to template"),
  target: z.string().optional().describe("updateRecords: 'trigger' or the id of an earlier findRecords or createRecord step"),
  filter: filterInput.optional().describe("findRecords; text values may contain templates"),
  sort: sortSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  method: z.enum(HTTP_METHODS).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional().describe("HTTP body or email message"),
  provider: z.enum(MAIL_PROVIDERS).optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  subject: z.string().optional(),
  format: z.enum(["text", "html"]).optional(),
  match: z.enum(["all", "any"]).optional(),
  conditions: z.array(z.object({ left: z.string(), op: z.enum(BRANCH_OPS), right: z.string().optional() })).max(20).optional(),
});
const stepSchema = baseStep.extend({ then: z.array(baseStep).max(25).optional(), else: z.array(baseStep).max(25).optional() });
type BaseStepIn = z.infer<typeof baseStep>;
type StepIn = z.infer<typeof stepSchema>;

const TEMPLATE_HELP =
  "Templates: {{trigger.record.<Field>}}, {{trigger.record}} (the record, for link fields), {{trigger.body.<path>}} (webhook), " +
  "{{steps.<id>.records[0].<Field>}}, {{steps.<id>.count}}, {{steps.<id>.status}}, {{steps.<id>.body.<path>}}, {{now}}, {{record.url}}.";

interface Ctx {
  a: BaseAccess;
  schema: Schema;
  origin: string;
}

async function ctxFor(c: AppContext, baseId: string, need: "read" | "write"): Promise<Ctx> {
  const a = await baseAccess(c, baseId, need);
  if (ROLE_RANK[a.role] < ROLE_RANK.editor) throw new HttpError(403, "Only editors can see automations");
  return { a, schema: await a.stub.schema(), origin: c.env.APP_URL || new URL(c.req.url).origin };
}

async function listOf(x: Ctx): Promise<Automation[]> {
  return (await x.a.stub.automationList(x.origin)).automations;
}

function automationOf(list: Automation[], key: string): Automation {
  const a = list.find(a => a.id === key) ?? list.find(a => a.name === key) ?? list.find(a => a.name.toLowerCase() === key.toLowerCase());
  if (!a) throw new HttpError(404, `Automation "${key}" not found. Automations: ${list.map(a => a.name).join(", ") || "none"}`);
  return a;
}

const tableName = (schema: Schema, id: string) => schema.tables.find(t => t.id === id)?.name ?? id;

function fieldIn(schema: Schema, tableId: string, key: string): Field {
  return fieldOf(fieldsOf(schema, tableId), key, tableName(schema, tableId));
}

function toFilter(schema: Schema, tableId: string, f: FilterIn | undefined, names?: NameContext): FilterSpec | undefined {
  if (!f?.conditions.length) return undefined;
  return {
    conjunction: f.conjunction ?? "and",
    conditions: f.conditions.map(cond => {
      const field = fieldIn(schema, tableId, cond.field);
      let value = cond.value;
      if (typeof value === "string" && value.includes("{{")) value = names ? fromDisplay(value, names) : value;
      else if ((field.type === "singleSelect" || field.type === "multiSelect") && value !== undefined && value !== null) value = Array.isArray(value) ? value.map(v => choiceId(field, v)) : choiceId(field, value);
      return { fieldId: field.id, op: cond.op, value };
    }),
  };
}

function toTrigger(schema: Schema, t: TriggerIn): Trigger {
  const table = () => {
    if (!t.table) throw new HttpError(422, `A ${t.type} trigger needs a table`);
    return tableOf(schema, t.table).id;
  };
  switch (t.type) {
    case "recordCreated": {
      const id = table();
      return { type: t.type, tableId: id, conditions: toFilter(schema, id, t.filter) };
    }
    case "recordUpdated": {
      const id = table();
      return { type: t.type, tableId: id, fieldIds: t.watch?.map(k => fieldIn(schema, id, k).id), conditions: toFilter(schema, id, t.filter) };
    }
    case "recordMatches": {
      const id = table();
      return { type: t.type, tableId: id, conditions: toFilter(schema, id, t.filter) ?? { conjunction: "and", conditions: [] } };
    }
    case "schedule":
      return { type: "schedule", every: t.every ?? "day", interval: t.interval, at: t.at ?? "09:00", weekday: t.weekday, monthday: t.monthday, tz: t.timezone ?? "UTC" };
    case "dateReached": {
      const id = table();
      if (!t.dateField) throw new HttpError(422, "A dateReached trigger needs dateField");
      return { type: t.type, tableId: id, fieldId: fieldIn(schema, id, t.dateField).id, offsetMinutes: t.offsetMinutes ?? 0, at: t.at, tz: t.timezone ?? "UTC", conditions: toFilter(schema, id, t.filter) };
    }
    case "webhook":
      return { type: "webhook", token: "" };
    case "button":
      return { type: "button", tableId: table(), viewerCanRun: t.viewerCanRun ?? false };
  }
}

/** Name-based steps to stored steps. Ids are assigned first so templates can name any earlier step. */
function toSteps(schema: Schema, trigger: Trigger, steps: StepIn[]): Step[] {
  const all: BaseStepIn[] = steps.flatMap(s => [s, ...(s.then ?? []), ...(s.else ?? [])]);
  let n = all.reduce((m, s) => Math.max(m, s.id && /^s(\d+)$/.test(s.id) ? Number(s.id.slice(1)) : 0), 0);
  const ids = new Map(all.map(s => [s, s.id ?? "s" + ++n]));
  const stepTables = new Map<string, string>();
  const names: NameContext = { fields: schema.fields, triggerTableId: triggerTableId(trigger), stepTableId: id => stepTables.get(id) };
  const tpl = (s: string | undefined) => fromDisplay(s ?? "", names);
  const table = (s: BaseStepIn) => {
    if (!s.table) throw new HttpError(422, `A ${s.type} step needs a table`);
    return tableOf(schema, s.table).id;
  };
  const one = (s: BaseStepIn): Step => {
    const id = ids.get(s)!;
    switch (s.type) {
      case "createRecord":
      case "updateRecords": {
        const tableId = table(s);
        const values = Object.fromEntries(Object.entries(s.values ?? {}).map(([k, v]) => [fieldIn(schema, tableId, k).id, tpl(v)]));
        stepTables.set(id, tableId);
        return s.type === "createRecord" ? { id, type: s.type, tableId, values } : { id, type: s.type, tableId, target: s.target ?? "trigger", values };
      }
      case "findRecords": {
        const tableId = table(s);
        const sort = s.sort?.map(x => ({ fieldId: fieldIn(schema, tableId, x.field).id, dir: x.direction === "desc" ? ("desc" as const) : ("asc" as const) }));
        const step: Step = { id, type: s.type, tableId, conditions: toFilter(schema, tableId, s.filter, names), sort, limit: s.limit ?? 10 };
        stepTables.set(id, tableId);
        return step;
      }
      case "http":
        return { id, type: "http", method: s.method ?? "POST", url: tpl(s.url), headers: Object.entries(s.headers ?? {}).map(([k, v]) => [k, tpl(v)]), body: s.body === undefined ? undefined : tpl(s.body) };
      case "email":
        return { id, type: "email", provider: s.provider ?? "system", to: tpl(s.to), cc: s.cc === undefined ? undefined : tpl(s.cc), subject: tpl(s.subject), body: tpl(s.body), format: s.format ?? "text" };
      case "branch":
        return { id, type: "branch", match: s.match ?? "all", conditions: (s.conditions ?? []).map(c => ({ left: tpl(c.left), op: c.op, right: c.right === undefined ? undefined : tpl(c.right) })), then: [], else: [] };
    }
  };
  return steps.map(s => {
    const st = one(s);
    if (st.type === "branch") {
      st.then = (s.then ?? []).map(one);
      st.else = (s.else ?? []).map(one);
    }
    return st;
  });
}

/** A stored automation with names instead of ids, in the same shape the tools accept. */
function describe(x: Ctx, a: Automation) {
  const { schema } = x;
  const fname = (id: string) => schema.fields.find(f => f.id === id)?.name ?? id;
  const t = a.config.trigger;
  const stepTables = new Map(flatSteps(a.config.steps).flatMap(s => ("tableId" in s ? [[s.id, s.tableId] as [string, string]] : [])));
  const names: NameContext = { fields: schema.fields, triggerTableId: triggerTableId(t), stepTableId: id => stepTables.get(id) };
  const show = (s: string) => toDisplay(s, names);
  const filter = (spec?: FilterSpec) =>
    spec?.conditions.length
      ? {
          conjunction: spec.conjunction,
          conditions: spec.conditions.map(c => {
            const f = schema.fields.find(x => x.id === c.fieldId);
            const choice = (v: unknown) => f?.options.choices?.find(ch => ch.id === v)?.name ?? v;
            const value = f && (f.type === "singleSelect" || f.type === "multiSelect") ? (Array.isArray(c.value) ? c.value.map(choice) : choice(c.value)) : typeof c.value === "string" ? show(c.value) : c.value;
            return { field: fname(c.fieldId), op: c.op, ...(value === undefined ? {} : { value }) };
          }),
        }
      : undefined;
  const trigger: Record<string, unknown> = { type: t.type };
  if ("tableId" in t) trigger.table = tableName(schema, t.tableId);
  if ("conditions" in t && filter(t.conditions)) trigger.filter = filter(t.conditions);
  if (t.type === "recordUpdated" && t.fieldIds?.length) trigger.watch = t.fieldIds.map(fname);
  if (t.type === "schedule") Object.assign(trigger, { every: t.every, interval: t.interval, at: t.at, weekday: t.weekday, monthday: t.monthday, timezone: t.tz });
  if (t.type === "dateReached") Object.assign(trigger, { dateField: fname(t.fieldId), offsetMinutes: t.offsetMinutes, at: t.at, timezone: t.tz });
  if (t.type === "button") trigger.viewerCanRun = t.viewerCanRun;
  const step = (s: Step): Record<string, unknown> => {
    const out: Record<string, unknown> = { id: s.id, type: s.type };
    switch (s.type) {
      case "createRecord":
      case "updateRecords":
        out.table = tableName(schema, s.tableId);
        if (s.type === "updateRecords") out.target = s.target;
        out.values = Object.fromEntries(Object.entries(s.values).map(([k, v]) => [fname(k), show(v)]));
        break;
      case "findRecords":
        Object.assign(out, { table: tableName(schema, s.tableId), filter: filter(s.conditions), sort: s.sort?.map(x => ({ field: fname(x.fieldId), direction: x.dir })), limit: s.limit });
        break;
      case "http":
        Object.assign(out, { method: s.method, url: show(s.url), headers: Object.fromEntries(s.headers.map(([k, v]) => [k, show(v)])) });
        if (s.body !== undefined) out.body = show(s.body);
        break;
      case "email":
        Object.assign(out, { provider: s.provider, to: show(s.to), subject: show(s.subject), body: show(s.body), format: s.format });
        if (s.cc) out.cc = show(s.cc);
        break;
      case "branch":
        Object.assign(out, { match: s.match, conditions: s.conditions.map(c => ({ left: show(c.left), op: c.op, ...(c.right === undefined ? {} : { right: show(c.right) }) })), then: s.then.map(step), else: s.else.map(step) });
        break;
    }
    return JSON.parse(JSON.stringify(out));
  };
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    ...(a.disabledReason ? { disabledReason: "Switched off after 20 failed runs in a row" } : {}),
    trigger: JSON.parse(JSON.stringify(trigger)),
    steps: a.config.steps.map(step),
    ...(t.type === "webhook" ? { webhookUrl: `${x.origin}/api/hooks/${x.a.base.id}/${t.token}` } : {}),
  };
}

async function apply(x: Ctx, op: AutomationOp): Promise<{ id?: string; automations: Automation[] }> {
  return unwrap(await x.a.stub.automationOp(x.a.actor, op, x.origin));
}

export function registerAutomationTools(server: McpServer, c: AppContext) {
  server.registerTool(
    "list_automations",
    { title: "List automations", description: "Automations of a base with their trigger type, whether they are on, and their last run. Editors and owners only.", inputSchema: { baseId: z.string() }, annotations: READ },
    guard(async (args: { baseId: string }) => {
      const x = await ctxFor(c, args.baseId, "read");
      return { automations: (await listOf(x)).map(a => ({ id: a.id, name: a.name, enabled: a.enabled, trigger: a.config.trigger.type, lastRun: a.lastRun ?? null })) };
    }),
  );

  server.registerTool(
    "get_automation",
    {
      title: "Get automation",
      description: "An automation's trigger and steps with table and field names, its webhook URL if it has one, and its last 20 runs.",
      inputSchema: { baseId: z.string(), automation: z.string().describe("Automation name or id") },
      annotations: READ,
    },
    guard(async (args: { baseId: string; automation: string }) => {
      const x = await ctxFor(c, args.baseId, "read");
      const a = automationOf(await listOf(x), args.automation);
      const runs = unwrap(await x.a.stub.automationRuns(a.id, { limit: 20 })).map(r => ({ id: r.id, status: r.status, test: r.test, createdAt: new Date(r.createdAt).toISOString(), error: r.error, trigger: r.trigger }));
      return { automation: describe(x, a), runs };
    }),
  );

  server.registerTool(
    "create_automation",
    {
      title: "Create automation",
      description:
        "Create an automation from a trigger and steps, naming tables and fields. It starts switched off unless enabled is true. " +
        "Triggers: recordCreated, recordUpdated, recordMatches, schedule, dateReached, webhook, button. " +
        "Steps run in order: createRecord, updateRecords, findRecords, http, email, branch (one level, with then and else). " +
        TEMPLATE_HELP,
      inputSchema: { baseId: z.string(), name: z.string().min(1).max(100), trigger: triggerSchema, steps: z.array(stepSchema).max(25).optional(), enabled: z.boolean().optional() },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; name: string; trigger: TriggerIn; steps?: StepIn[]; enabled?: boolean }) => {
      const x = await ctxFor(c, args.baseId, "write");
      const trigger = toTrigger(x.schema, args.trigger);
      const config: AutomationConfig = { trigger, steps: toSteps(x.schema, trigger, args.steps ?? []) };
      const r = await apply(x, { op: "create", name: args.name, config, enabled: args.enabled ?? false });
      return { automation: describe(x, automationOf(r.automations, r.id!)) };
    }),
  );

  server.registerTool(
    "update_automation",
    {
      title: "Update automation",
      description: "Rename an automation, switch it on or off, or replace its trigger or its steps (each is replaced as a whole when given). " + TEMPLATE_HELP,
      inputSchema: { baseId: z.string(), automation: z.string().describe("Automation name or id"), name: z.string().min(1).max(100).optional(), trigger: triggerSchema.optional(), steps: z.array(stepSchema).max(25).optional(), enabled: z.boolean().optional() },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; automation: string; name?: string; trigger?: TriggerIn; steps?: StepIn[]; enabled?: boolean }) => {
      const x = await ctxFor(c, args.baseId, "write");
      const a = automationOf(await listOf(x), args.automation);
      let list: Automation[] | undefined;
      if (args.name !== undefined || args.trigger || args.steps) {
        const trigger = args.trigger ? toTrigger(x.schema, args.trigger) : a.config.trigger;
        const config: AutomationConfig = { trigger, steps: args.steps ? toSteps(x.schema, trigger, args.steps) : a.config.steps };
        list = (await apply(x, { op: "update", id: a.id, name: args.name, config })).automations;
      }
      if (args.enabled !== undefined) list = (await apply(x, { op: "setEnabled", id: a.id, enabled: args.enabled })).automations;
      return { automation: describe(x, automationOf(list ?? (await listOf(x)), a.id)) };
    }),
  );
}
```

`src/worker/mcp/server.ts`: `import { registerAutomationTools } from "./tools-automation";` and `registerAutomationTools(server, c);` after `registerDashboardTools(server, c);`.

`docs/mcp.md`: add the four tools to the tool table (one row each, matching the descriptions above) and a section "Automations" with: triggers and steps by name, templates (`{{trigger.record.Field}}` with field names), new automations start switched off unless `enabled: true`, no tool runs an automation (buttons keep their permission), and an example `create_automation` call (the "Won deals" call from the test).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project worker test/worker/mcp-automations.test.ts test/worker/mcp.test.ts && npm run typecheck`
Expected: PASS (4 new tests plus the existing MCP tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: whole suite passes. Record in the ledger: `Task 11: mcp-automations.test.ts 4/4, mcp.test.ts green, suite <N>/<N>`.

---
### Task 12: Client automation logic (pure)

**Files:**
- Create: `src/web/auto/flow.ts`
- Create: `src/web/auto/api.ts`
- Test: `test/unit/flow.test.ts`

**Interfaces:**
- Consumes: Task 1 types and helpers (`flatSteps`, `nextStepId`, `RECORD_SOURCES`, `triggerTableId`); Task 2 `fromDisplay`, `toDisplay`, `NameContext`.
- Produces (from `src/web/auto/flow.ts`): `SchemaLite`, `schemaLite(schema)`, `localZone()`, `TRIGGER_LABELS`, `TRIGGER_ICONS`, `STEP_LABELS`, `STEP_ICONS`, `BRANCH_LABELS`, `WEEKDAYS`, `defaultTrigger(type, s, tz)`, `withTable(t, tableId, s)`, `defaultStep(type, steps, trigger, s)`, `Slot { parentId?; side?: "then" | "else"; index }`, `insertStep`, `removeStep`, `replaceStep`, `moveStep`, `findStep`, `Variable { group; label; template }`, `variablesFor(cfg, stepId, s)`, `nameContext(cfg, fields)`, `toDisplayConfig(cfg, fields)`, `toStoredConfig(cfg, fields)`, `scheduleText(t)`, `offsetText(min)`, `triggerSummary(t, s)`, `stepSummary(st, s)`, `Preset`, `PRESETS`.
- Produces (from `src/web/auto/api.ts`): `AutomationList { automations; usage: { used; limit }; origin }`, `listAutomations(baseId)`, `automationOp(baseId, op)`, `listRuns(baseId, id, q?)`, `testRun(baseId, id, input)`, `runButton(baseId, id, recordId)`, `retryRun(baseId, runId)`, `webhookUrl(origin, baseId, token)`.

- [ ] **Step 1: Write the failing test**

`test/unit/flow.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/flow.test.ts`
Expected: FAIL with "Failed to load url ../../src/web/auto/flow".

- [ ] **Step 3: Write the implementation**

`src/web/auto/api.ts`:

```ts
// HTTP calls for the automations editor, Button fields and the run log.
import { get, post } from "../api";
import type { Automation, AutomationOp, AutomationRun, RunStatus } from "../../shared/automations";

export interface AutomationList {
  automations: Automation[];
  usage: { used: number; limit: number };
  origin: string;
}

export const listAutomations = (baseId: string) => get<AutomationList>(`/api/bases/${baseId}/automations`);

export const automationOp = (baseId: string, op: AutomationOp) => post<{ id?: string; automations: Automation[] }>(`/api/bases/${baseId}/automations`, op);

export function listRuns(baseId: string, id: string, q: { status?: string; before?: number } = {}) {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.before) p.set("before", String(q.before));
  return get<AutomationRun[]>(`/api/bases/${baseId}/automations/${id}/runs?${p}`);
}

export const testRun = (baseId: string, id: string, input: { recordId?: number; body?: unknown }) => post<AutomationRun>(`/api/bases/${baseId}/automations/${id}/test`, input);

export const runButton = (baseId: string, id: string, recordId: number) => post<{ id: number; status: RunStatus; error: string | null }>(`/api/bases/${baseId}/automations/${id}/run`, { recordId });

export const retryRun = (baseId: string, runId: number) => post<{ runId: number }>(`/api/bases/${baseId}/runs/${runId}/retry`, {});

export const webhookUrl = (origin: string, baseId: string, token: string) => `${origin}/api/hooks/${baseId}/${token}`;
```

`src/web/auto/flow.ts`:

```ts
// Editor logic for automations, free of React: labels, defaults, step tree edits,
// variables for the picker, and conversion between stored ids and names in templates.
import type { Field, Table } from "../../shared/types";
import { flatSteps, nextStepId, RECORD_SOURCES, triggerTableId, type AutomationConfig, type BranchOp, type ScheduleTrigger, type Step, type StepType, type Trigger, type TriggerType } from "../../shared/automations";
import { fromDisplay, toDisplay, type NameContext } from "../../shared/template";

export interface SchemaLite {
  tables: Pick<Table, "id" | "name" | "primaryFieldId">[];
  fields: Field[];
}

export const schemaLite = (schema: SchemaLite): SchemaLite => ({ tables: schema.tables, fields: schema.fields });
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  recordCreated: "When a record is created",
  recordUpdated: "When a record is updated",
  recordMatches: "When a record matches conditions",
  schedule: "At scheduled times",
  dateReached: "When a date is reached",
  webhook: "When a webhook is called",
  button: "When a button is clicked",
};
export const TRIGGER_ICONS: Record<TriggerType, string> = { recordCreated: "plus", recordUpdated: "edit", recordMatches: "filter", schedule: "clock", dateReached: "calendar", webhook: "link", button: "button" };
export const STEP_LABELS: Record<StepType, string> = { createRecord: "Create record", updateRecords: "Update records", findRecords: "Find records", http: "Send HTTP request", email: "Send email", branch: "If / otherwise" };
export const STEP_ICONS: Record<StepType, string> = { createRecord: "plus", updateRecords: "edit", findRecords: "search", http: "link", email: "email", branch: "branch" };
export const BRANCH_LABELS: Record<BranchOp, string> = { eq: "is", neq: "is not", contains: "contains", ncontains: "does not contain", empty: "is empty", notempty: "is not empty", gt: ">", gte: "≥", lt: "<", lte: "≤" };
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const tableName = (s: SchemaLite, id: string) => s.tables.find(t => t.id === id)?.name ?? "a deleted table";
const fieldName = (s: SchemaLite, id: string) => s.fields.find(f => f.id === id)?.name ?? "a deleted field";
const firstDate = (s: SchemaLite, tableId: string) => s.fields.find(f => f.tableId === tableId && f.type === "date")?.id ?? "";

export function defaultTrigger(type: TriggerType, s: SchemaLite, tz: string): Trigger {
  const tableId = s.tables[0]?.id ?? "";
  switch (type) {
    case "recordCreated":
    case "recordUpdated":
      return { type, tableId };
    case "recordMatches":
      return { type, tableId, conditions: { conjunction: "and", conditions: [] } };
    case "schedule":
      return { type, every: "day", at: "09:00", tz };
    case "dateReached": {
      const withDate = s.tables.find(t => firstDate(s, t.id)) ?? s.tables[0];
      return { type, tableId: withDate?.id ?? "", fieldId: withDate ? firstDate(s, withDate.id) : "", offsetMinutes: 0, at: "09:00", tz };
    }
    case "webhook":
      return { type, token: "" };
    case "button":
      return { type, tableId, viewerCanRun: false };
  }
}

/** The same trigger on another table; settings tied to the old table's fields are reset. */
export function withTable(t: Trigger, tableId: string, s: SchemaLite): Trigger {
  switch (t.type) {
    case "recordCreated":
      return { type: t.type, tableId };
    case "recordUpdated":
      return { type: t.type, tableId };
    case "recordMatches":
      return { type: t.type, tableId, conditions: { conjunction: "and", conditions: [] } };
    case "dateReached":
      return { ...t, tableId, fieldId: firstDate(s, tableId), conditions: undefined };
    case "button":
      return { ...t, tableId };
    default:
      return t;
  }
}

export function defaultStep(type: StepType, steps: Step[], trigger: Trigger, s: SchemaLite): Step {
  const id = nextStepId(steps);
  const tableId = triggerTableId(trigger) ?? s.tables[0]?.id ?? "";
  switch (type) {
    case "createRecord":
      return { id, type, tableId, values: {} };
    case "updateRecords": {
      if (RECORD_SOURCES.has(trigger.type)) return { id, type, target: "trigger", tableId, values: {} };
      const src = [...flatSteps(steps)].reverse().find(x => x.type === "findRecords" || x.type === "createRecord");
      return { id, type, target: src?.id ?? "trigger", tableId: src && "tableId" in src ? src.tableId : tableId, values: {} };
    }
    case "findRecords":
      return { id, type, tableId, conditions: { conjunction: "and", conditions: [] }, limit: 10 };
    case "http":
      return { id, type, method: "POST", url: "", headers: [] };
    case "email":
      return { id, type, provider: "system", to: "", subject: "", body: "", format: "text" };
    case "branch":
      return { id, type, match: "all", conditions: [{ left: "", op: "notempty" }], then: [], else: [] };
  }
}

/** Where a new step goes: an index at the top level, or in one side of a branch. */
export interface Slot {
  parentId?: string;
  side?: "then" | "else";
  index: number;
}

const splice = (list: Step[], index: number, step: Step) => [...list.slice(0, index), step, ...list.slice(index)];

export function insertStep(steps: Step[], at: Slot, step: Step): Step[] {
  if (!at.parentId || !at.side) return splice(steps, at.index, step);
  const side = at.side;
  return steps.map(s => (s.type === "branch" && s.id === at.parentId ? { ...s, [side]: splice(s[side], at.index, step) } : s));
}

export function removeStep(steps: Step[], id: string): Step[] {
  return steps.filter(s => s.id !== id).map(s => (s.type === "branch" ? { ...s, then: s.then.filter(x => x.id !== id), else: s.else.filter(x => x.id !== id) } : s));
}

export function replaceStep(steps: Step[], id: string, next: Step): Step[] {
  const swap = (s: Step) => (s.id === id ? next : s);
  return steps.map(s => (s.id === id ? next : s.type === "branch" ? { ...s, then: s.then.map(swap), else: s.else.map(swap) } : s));
}

export function moveStep(steps: Step[], id: string, dir: -1 | 1): Step[] {
  const move = (list: Step[]): Step[] | null => {
    const i = list.findIndex(s => s.id === id);
    if (i < 0) return null;
    const j = i + dir;
    if (j < 0 || j >= list.length) return list;
    const out = list.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };
  const top = move(steps);
  if (top) return top;
  return steps.map(s => {
    if (s.type !== "branch") return s;
    const then = move(s.then);
    if (then) return { ...s, then };
    const other = move(s.else);
    return other ? { ...s, else: other } : s;
  });
}

export function findStep(steps: Step[], id: string): Step | undefined {
  return flatSteps(steps).find(s => s.id === id);
}

export interface Variable {
  group: string;
  label: string;
  /** In display form, with field names. */
  template: string;
}

/** What a step can insert: the trigger record or webhook body, results of earlier steps, and general values. */
export function variablesFor(cfg: AutomationConfig, stepId: string | null, s: SchemaLite): Variable[] {
  const out: Variable[] = [];
  const t = cfg.trigger;
  const fieldsOf = (tableId: string) => s.fields.filter(f => f.tableId === tableId && f.type !== "button");
  if (RECORD_SOURCES.has(t.type)) {
    const tid = triggerTableId(t)!;
    const g = `Trigger record (${tableName(s, tid)})`;
    out.push({ group: g, label: "The record (for link fields)", template: "{{trigger.record}}" });
    for (const f of fieldsOf(tid)) out.push({ group: g, label: f.name, template: `{{trigger.record.${f.name}}}` });
    out.push({ group: g, label: "Link to the record", template: "{{record.url}}" });
  }
  if (t.type === "webhook") {
    out.push({ group: "Webhook body", label: "The whole body", template: "{{trigger.body}}" });
    out.push({ group: "Webhook body", label: "A value, such as email", template: "{{trigger.body.email}}" });
  }
  for (const st of flatSteps(cfg.steps)) {
    if (st.id === stepId) break;
    const g = `Step ${st.id}: ${STEP_LABELS[st.type]}`;
    if (st.type === "createRecord" || st.type === "updateRecords" || st.type === "findRecords") {
      out.push({ group: g, label: "The records (for link fields)", template: `{{steps.${st.id}.records}}` });
      if (st.type !== "createRecord") out.push({ group: g, label: "How many", template: `{{steps.${st.id}.count}}` });
      for (const f of fieldsOf(st.tableId)) out.push({ group: g, label: f.name, template: `{{steps.${st.id}.records[0].${f.name}}}` });
    } else if (st.type === "http") {
      out.push({ group: g, label: "Status code", template: `{{steps.${st.id}.status}}` });
      out.push({ group: g, label: "Response body", template: `{{steps.${st.id}.body}}` });
    }
  }
  out.push({ group: "General", label: "Now", template: "{{now}}" });
  out.push({ group: "General", label: "Automation name", template: "{{automation.name}}" });
  out.push({ group: "General", label: "Link to the base", template: "{{base.url}}" });
  return out;
}

export function nameContext(cfg: AutomationConfig, fields: Field[]): NameContext {
  const tables = new Map(flatSteps(cfg.steps).flatMap(s => ("tableId" in s ? [[s.id, s.tableId] as [string, string]] : [])));
  return { fields, triggerTableId: triggerTableId(cfg.trigger), stepTableId: id => tables.get(id) };
}

function mapTemplates(steps: Step[], fn: (s: string) => string): Step[] {
  return steps.map((st): Step => {
    switch (st.type) {
      case "createRecord":
      case "updateRecords":
        return { ...st, values: Object.fromEntries(Object.entries(st.values).map(([k, v]) => [k, fn(v)])) };
      case "findRecords":
        return st.conditions ? { ...st, conditions: { ...st.conditions, conditions: st.conditions.conditions.map(c => (typeof c.value === "string" && c.value.includes("{{") ? { ...c, value: fn(c.value) } : c)) } } : st;
      case "http":
        return { ...st, url: fn(st.url), headers: st.headers.map(([k, v]) => [k, fn(v)] as [string, string]), body: st.body === undefined ? undefined : fn(st.body) };
      case "email":
        return { ...st, to: fn(st.to), cc: st.cc === undefined ? undefined : fn(st.cc), subject: fn(st.subject), body: fn(st.body) };
      case "branch":
        return { ...st, conditions: st.conditions.map(c => ({ ...c, left: fn(c.left), right: c.right === undefined ? undefined : fn(c.right) })), then: mapTemplates(st.then, fn), else: mapTemplates(st.else, fn) };
    }
  });
}

export function toDisplayConfig(cfg: AutomationConfig, fields: Field[]): AutomationConfig {
  const n = nameContext(cfg, fields);
  return { ...cfg, steps: mapTemplates(cfg.steps, s => toDisplay(s, n)) };
}

export function toStoredConfig(cfg: AutomationConfig, fields: Field[]): AutomationConfig {
  const n = nameContext(cfg, fields);
  return { ...cfg, steps: mapTemplates(cfg.steps, s => fromDisplay(s, n)) };
}

export function scheduleText(t: ScheduleTrigger): string {
  switch (t.every) {
    case "hour":
      return `Every ${t.interval && t.interval > 1 ? `${t.interval} hours` : "hour"} at minute ${t.at.slice(3)} (${t.tz})`;
    case "day":
      return `Every day at ${t.at} (${t.tz})`;
    case "week":
      return `Every ${WEEKDAYS[t.weekday ?? 1]} at ${t.at} (${t.tz})`;
    case "month":
      return `On day ${t.monthday ?? 1} of every month at ${t.at} (${t.tz})`;
  }
}

export function offsetText(min: number): string {
  if (!min) return "On";
  const abs = Math.abs(min);
  const [n, unit] = abs % 1440 === 0 ? [abs / 1440, "day"] : abs % 60 === 0 ? [abs / 60, "hour"] : [abs, "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ${min < 0 ? "before" : "after"}`;
}

export function triggerSummary(t: Trigger, s: SchemaLite): string {
  switch (t.type) {
    case "recordCreated":
      return `A record is created in ${tableName(s, t.tableId)}`;
    case "recordUpdated":
      return `A record in ${tableName(s, t.tableId)} changes` + (t.fieldIds?.length ? `: ${t.fieldIds.map(id => fieldName(s, id)).join(", ")}` : "");
    case "recordMatches": {
      const n = t.conditions.conditions.length;
      return `A record in ${tableName(s, t.tableId)} starts to match ${n} condition${n === 1 ? "" : "s"}`;
    }
    case "schedule":
      return scheduleText(t);
    case "dateReached":
      return `${offsetText(t.offsetMinutes)} ${fieldName(s, t.fieldId)} in ${tableName(s, t.tableId)}`;
    case "webhook":
      return "An app sends a request to the webhook URL";
    case "button":
      return `Someone clicks a button in ${tableName(s, t.tableId)}`;
  }
}

export function stepSummary(st: Step, s: SchemaLite): string {
  switch (st.type) {
    case "createRecord":
      return `In ${tableName(s, st.tableId)}`;
    case "updateRecords":
      return st.target === "trigger" ? "The trigger record" : `Records from step ${st.target}`;
    case "findRecords":
      return `Up to ${st.limit} in ${tableName(s, st.tableId)}`;
    case "http":
      return `${st.method} ${st.url || "(no URL yet)"}`;
    case "email":
      return st.to ? `To ${st.to}` : "(no recipient yet)";
    case "branch":
      return `${st.conditions.length} condition${st.conditions.length === 1 ? "" : "s"}, ${st.match === "all" ? "all" : "any"} must hold`;
  }
}

export interface Preset {
  id: string;
  name: string;
  /** Display form (field names in templates), or null when the base has nothing it fits. */
  build(s: SchemaLite, tz: string): AutomationConfig | null;
}

export const PRESETS: Preset[] = [
  {
    id: "email-on-status",
    name: "Email when a status is reached",
    build(s) {
      const sel = s.fields.find(f => f.type === "singleSelect" && (f.options.choices?.length ?? 0) > 1);
      const table = sel && s.tables.find(t => t.id === sel.tableId);
      if (!sel || !table) return null;
      const last = sel.options.choices![sel.options.choices!.length - 1];
      const primary = s.fields.find(f => f.id === table.primaryFieldId)?.name ?? "Name";
      return {
        trigger: { type: "recordMatches", tableId: table.id, conditions: { conjunction: "and", conditions: [{ fieldId: sel.id, op: "eq", value: last.id }] } },
        steps: [{ id: "s1", type: "email", provider: "system", to: "team@example.com", subject: `{{trigger.record.${primary}}} is ${last.name}`, body: `{{trigger.record.${primary}}} is now ${last.name}.\n\nOpen it: {{record.url}}`, format: "text" }],
      };
    },
  },
  {
    id: "weekly-count",
    name: "Weekly count to a webhook URL",
    build(s, tz) {
      const table = s.tables[0];
      if (!table) return null;
      return {
        trigger: { type: "schedule", every: "week", weekday: 1, at: "09:00", tz },
        steps: [
          { id: "s1", type: "findRecords", tableId: table.id, conditions: { conjunction: "and", conditions: [] }, limit: 100 },
          { id: "s2", type: "http", method: "POST", url: "https://example.com/weekly", headers: [], body: `{"table": "${table.name}", "count": {{steps.s1.count}}}` },
        ],
      };
    },
  },
  {
    id: "records-from-webhook",
    name: "Create records from a webhook",
    build(s) {
      const table = s.tables[0];
      const primary = table && s.fields.find(f => f.id === table.primaryFieldId);
      if (!table || !primary) return null;
      return { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "createRecord", tableId: table.id, values: { [primary.id]: "{{trigger.body.name}}" } }] };
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/flow.test.ts && npm run typecheck`
Expected: PASS (7 tests); typecheck clean.

- [ ] **Step 5: Checkpoint**

Record in the ledger: `Task 12: flow.test.ts 7/7, typecheck clean`.

---

### Task 13: Automations page

**Files:**
- Create: `src/web/auto/AutomationsPage.tsx`
- Create: `src/web/auto/FlowEditor.tsx`
- Create: `src/web/auto/Panels.tsx`
- Create: `src/web/auto/TemplateInput.tsx`
- Create: `src/web/auto/RunsPanel.tsx`
- Create: `src/web/auto/auto.css`
- Modify: `src/web/ui.tsx` (icons `bolt`, `clock`, `branch`, `braces`, `play`, `button`)
- Modify: `src/web/base/client.ts` (`onAutomations`, the `automations` message, `memberName` for automations, `buttonBusy`)
- Modify: `src/web/base/BasePage.tsx` (header button with a red dot, the automations body, `?record=` opens a record)
- Modify: `src/web/main.tsx` (route `/base/:baseId/automations/:autoId?`)

**Interfaces:**
- Consumes: Task 12 modules; `FilterEditor` (`src/web/base/FilterEditor.tsx`); `Button`, `Icon`, `Menu`, `Modal`, `Popover`, `Spinner`, `copyText` (`src/web/ui.tsx`); `toast`, `toastError`.
- Produces: default export `AutomationsPage({ client, automationId? })`; `FlowEditor`; `TriggerPanel`, `StepPanel`; `TemplateInput`; `RunsPanel`, `StatusDot`, `StepLogView`, `STATUS_LABELS`; `BaseClient.onAutomations(fn)`, `BaseClient.buttonBusy: Set<string>`; `BasePage` props `automations?: boolean`, `automationId?: string`.

UI tasks have no unit tests of their own: the logic they use is tested in Task 12, the server in Tasks 4 to 11, and Task 17 walks every screen with Playwright. The gate here is typecheck, build and a smoke check.

- [ ] **Step 1: Client data layer**

`src/web/base/client.ts`:
- Fields:

```ts
  private autoListeners = new Set<() => void>();
  /** Button cells waiting for their automation ("fieldId:recordId"). */
  buttonBusy = new Set<string>();
```

- After `onData`:

```ts
  /** Called when automations of this base change (editors refetch their list). */
  onAutomations(fn: () => void): () => void {
    this.autoListeners.add(fn);
    return () => {
      this.autoListeners.delete(fn);
    };
  }
```

- In `onMessage`, a new case:

```ts
      case "automations":
        for (const l of this.autoListeners) l();
        return;
```

- `memberName`:

```ts
  memberName(id: string): string {
    if (id.startsWith("auto:")) return "Automation";
    return this.members.find(m => m.id === id)?.name ?? "Unknown";
  }
```

- [ ] **Step 2: Icons**

`src/web/ui.tsx`, add to `PATHS`:

```ts
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  branch: "M6 3v18M18 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM15 9c0 6-9 3-9 9",
  braces: "M8 4c-2 0-2 2-2 4s-1 4-3 4c2 0 3 2 3 4s0 4 2 4M16 4c2 0 2 2 2 4s1 4 3 4c-2 0-3 2-3 4s0 4-2 4",
  play: "M7 4l13 8-13 8z",
  button: "M3 8h18v8H3zM8 12h8",
```

- [ ] **Step 3: Template input and run log**

`src/web/auto/TemplateInput.tsx`:

```tsx
// A text input for templates with an "Insert variable" menu that inserts {{...}} at the caret.
import { useRef, useState } from "react";
import { Icon, Popover } from "../ui";
import type { Variable } from "./flow";

export function TemplateInput({ value, onChange, variables, multiline, placeholder, ariaLabel }: { value: string; onChange: (v: string) => void; variables: Variable[]; multiline?: boolean; placeholder?: string; ariaLabel?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const insert = (tpl: string) => {
    const el = multiline ? area.current : input.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + tpl + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + tpl.length, start + tpl.length);
    });
  };
  const groups = [...new Set(variables.map(v => v.group))];
  return (
    <div className={"tpl-input" + (multiline ? " multi" : "")}>
      {multiline ? (
        <textarea ref={area} className="input tpl-area" rows={5} value={value} placeholder={placeholder} aria-label={ariaLabel} onChange={e => onChange(e.target.value)} />
      ) : (
        <input ref={input} className="input" value={value} placeholder={placeholder} aria-label={ariaLabel} onChange={e => onChange(e.target.value)} />
      )}
      <button type="button" className="icon-btn tpl-btn" title="Insert variable" aria-label="Insert variable" onClick={e => setAnchor(e.currentTarget)}>
        <Icon name="braces" size={14} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300} align="end" className="menu tpl-menu">
          {groups.map(g => (
            <div key={g}>
              <div className="tpl-group">{g}</div>
              {variables.filter(v => v.group === g).map(v => (
                <button
                  key={v.template}
                  className="menu-item"
                  onClick={() => {
                    setAnchor(null);
                    insert(v.template);
                  }}
                >
                  <span>{v.label}</span>
                </button>
              ))}
            </div>
          ))}
        </Popover>
      )}
    </div>
  );
}
```

`src/web/auto/RunsPanel.tsx`:

```tsx
// The run log of one automation: newest first, filtered by status, with each step's input and output.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Automation, AutomationRun, RunStatus, StepLog } from "../../shared/automations";
import type { BaseClient } from "../base/client";
import { Button, Icon, Spinner } from "../ui";
import { toast, toastError } from "../toast";
import { listRuns, retryRun } from "./api";
import { STEP_LABELS } from "./flow";

export const STATUS_LABELS: Record<RunStatus, string> = { queued: "Queued", running: "Running", waiting_retry: "Waiting to retry", succeeded: "Succeeded", failed: "Failed", skipped: "Skipped" };

export function StatusDot({ status }: { status: RunStatus }) {
  return <span className={"run-dot " + status} title={STATUS_LABELS[status]} />;
}

export function StepLogView({ log, title }: { log: StepLog; title?: string }) {
  return (
    <div className={"step-log " + log.status}>
      <div className="step-log-head">
        <Icon name={log.status === "ok" ? "check" : "x"} size={13} />
        <span>{title ?? `${STEP_LABELS[log.type]} ${log.id}`}</span>
        {log.error && <span className="run-error">{log.error}</span>}
        <span className="muted small">{log.ms} ms</span>
      </div>
      {log.input !== undefined && (
        <>
          <div className="muted small">Input</div>
          <pre className="auto-code">{JSON.stringify(log.input, null, 2)}</pre>
        </>
      )}
      {log.output !== undefined && (
        <>
          <div className="muted small">Output</div>
          <pre className="auto-code">{JSON.stringify(log.output, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

function triggerText(r: AutomationRun, client: BaseClient): string {
  const t = r.trigger;
  if (r.test) return "Test run";
  switch (t.type) {
    case "schedule":
      return "Scheduled";
    case "webhook":
      return "Webhook call";
    case "button":
      return `Button on record ${t.recordId}, by ${client.memberName(t.by ?? "")}`;
    case "dateReached":
      return `Date reached on record ${t.recordId}`;
    default:
      return `Record ${t.recordId}` + (t.by ? `, by ${client.memberName(t.by)}` : "");
  }
}

export function RunsPanel({ client, automation }: { client: BaseClient; automation: Automation }) {
  const [status, setStatus] = useState("");
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const paged = useRef(false);
  const load = useCallback(
    () =>
      listRuns(client.baseId, automation.id, { status }).then(list => {
        paged.current = false;
        setRuns(list);
        setMore(list.length === 50);
      }),
    [client.baseId, automation.id, status],
  );
  useEffect(() => {
    load().catch(toastError);
    // Runs finish in the background; refresh the first page while the log is open.
    const t = setInterval(() => {
      if (!paged.current) load().catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [load]);
  const older = () => {
    if (!runs?.length) return;
    listRuns(client.baseId, automation.id, { status, before: runs[runs.length - 1].id })
      .then(list => {
        paged.current = true;
        setRuns([...runs, ...list]);
        setMore(list.length === 50);
      })
      .catch(toastError);
  };
  const again = (r: AutomationRun) =>
    retryRun(client.baseId, r.id)
      .then(() => {
        toast("Running again from the step that failed");
        return load();
      })
      .catch(toastError);
  return (
    <div className="runs">
      <div className="runs-bar">
        <select className="input runs-filter" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
          <option value="">All runs</option>
          {(["failed", "succeeded", "waiting_retry", "queued", "skipped"] as RunStatus[]).map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <Button small variant="ghost" icon="undo" onClick={() => load().catch(toastError)}>Refresh</Button>
      </div>
      {!runs ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <div className="runs-list">
          {runs.map(r => (
            <div key={r.id} className={"run" + (open === r.id ? " open" : "")}>
              <button className="run-row" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <StatusDot status={r.status} />
                <span className="run-status">{STATUS_LABELS[r.status]}</span>
                <span className="run-when muted small">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="run-what small">{triggerText(r, client)}</span>
                {r.error && <span className="run-error small">{r.error}</span>}
              </button>
              {open === r.id && (
                <div className="run-detail">
                  {r.status === "waiting_retry" && r.nextAt && <p className="muted small">Next try at {new Date(r.nextAt).toLocaleTimeString()} (attempt {r.attempt + 1} of 4).</p>}
                  {r.steps.length === 0 && <p className="muted small">No steps ran.</p>}
                  {r.steps.map(l => <StepLogView key={l.id} log={l} />)}
                  {r.status === "failed" && !r.test && <Button small icon="play" onClick={() => again(r)}>Run again from the failed step</Button>}
                </div>
              )}
            </div>
          ))}
          {more && <Button small variant="ghost" onClick={older}>Older runs</Button>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Settings panels**

`src/web/auto/Panels.tsx`:

```tsx
// Settings panels for the trigger and for each step type.
import type { ReactNode } from "react";
import type { Field, FilterSpec } from "../../shared/types";
import { COMPUTED_TYPES } from "../../shared/types";
import { BRANCH_OPS, flatSteps, HTTP_METHODS, RECORD_SOURCES, TRIGGER_TYPES, triggerTableId, type AutomationConfig, type BranchCondition, type BranchOp, type DateTrigger, type ScheduleTrigger, type Step, type StepLog, type Trigger } from "../../shared/automations";
import { FilterEditor } from "../base/FilterEditor";
import type { BaseClient } from "../base/client";
import { Button, copyText, Icon } from "../ui";
import { BRANCH_LABELS, defaultTrigger, localZone, offsetText, scheduleText, schemaLite, STEP_LABELS, TRIGGER_LABELS, variablesFor, WEEKDAYS, withTable } from "./flow";
import { TemplateInput } from "./TemplateInput";
import { StepLogView } from "./RunsPanel";

const EMPTY: FilterSpec = { conjunction: "and", conditions: [] };
const usable = (fields: Field[]) => fields.filter(f => f.type !== "button");
const tzOf = (t: Trigger) => ("tz" in t ? t.tz : localZone());

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="auto-field">
      <span className="auto-field-label">{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

function TimeZoneSelect({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  const list = [...new Set(["UTC", localZone(), value, ...zones])];
  return (
    <select className="input" value={value} onChange={e => onChange(e.target.value)} aria-label="Time zone">
      {list.map(z => <option key={z} value={z}>{z}</option>)}
    </select>
  );
}

const clampInt = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

function ScheduleFields({ t, set }: { t: ScheduleTrigger; set: (t: Trigger) => void }) {
  const every = (v: ScheduleTrigger["every"]) =>
    set({ type: "schedule", every: v, at: t.at, tz: t.tz, ...(v === "hour" ? { interval: t.interval ?? 1 } : {}), ...(v === "week" ? { weekday: t.weekday ?? 1 } : {}), ...(v === "month" ? { monthday: t.monthday ?? 1 } : {}) });
  return (
    <>
      <Row label="Repeat">
        <select className="input" value={t.every} onChange={e => every(e.target.value as ScheduleTrigger["every"])}>
          <option value="hour">Every few hours</option>
          <option value="day">Every day</option>
          <option value="week">Every week</option>
          <option value="month">Every month</option>
        </select>
      </Row>
      {t.every === "hour" && <Row label="Hours between runs"><input className="input" type="number" min={1} max={24} value={t.interval ?? 1} onChange={e => set({ ...t, interval: clampInt(e.target.value, 1, 24) })} /></Row>}
      {t.every === "week" && (
        <Row label="Day">
          <select className="input" value={t.weekday ?? 1} onChange={e => set({ ...t, weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </Row>
      )}
      {t.every === "month" && <Row label="Day of the month" hint="Shorter months run on their last day."><input className="input" type="number" min={1} max={31} value={t.monthday ?? 1} onChange={e => set({ ...t, monthday: clampInt(e.target.value, 1, 31) })} /></Row>}
      <Row label={t.every === "hour" ? "Minutes past the hour (the hour part is ignored)" : "Time"}><input className="input" type="time" value={t.at} onChange={e => e.target.value && set({ ...t, at: e.target.value })} /></Row>
      <Row label="Time zone"><TimeZoneSelect value={t.tz} onChange={tz => set({ ...t, tz })} /></Row>
      <p className="muted small">{scheduleText(t)}</p>
    </>
  );
}

const UNITS: [string, number][] = [["minutes", 1], ["hours", 60], ["days", 1440]];

function DateFields({ t, set, fields }: { t: DateTrigger; set: (t: Trigger) => void; fields: Field[] }) {
  const abs = Math.abs(t.offsetMinutes);
  const unit = !abs || abs % 1440 === 0 ? 1440 : abs % 60 === 0 ? 60 : 1;
  const amount = abs / unit;
  const sign = t.offsetMinutes < 0 ? -1 : 1;
  const offset = (n: number, u: number, sg: number) => set({ ...t, offsetMinutes: Math.round(Math.max(0, n) * u) * sg });
  const dates = fields.filter(f => f.type === "date");
  return (
    <>
      <Row label="Date field">
        <select className="input" value={t.fieldId} onChange={e => set({ ...t, fieldId: e.target.value })}>
          {!dates.some(f => f.id === t.fieldId) && <option value="">Choose a date field</option>}
          {dates.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </Row>
      <Row label="When" hint={`${offsetText(t.offsetMinutes)} the date`}>
        <div className="auto-inline">
          <input className="input" type="number" min={0} value={amount} onChange={e => offset(Number(e.target.value) || 0, unit, sign)} aria-label="Amount" />
          <select className="input" value={unit} onChange={e => offset(amount, Number(e.target.value), sign)} aria-label="Unit">
            {UNITS.map(([l, u]) => <option key={u} value={u}>{l}</option>)}
          </select>
          <select className="input" value={sign} onChange={e => offset(amount, unit, Number(e.target.value))} aria-label="Before or after">
            <option value={-1}>before</option>
            <option value={1}>after</option>
          </select>
        </div>
      </Row>
      <Row label="Time for dates without a time"><input className="input" type="time" value={t.at ?? "09:00"} onChange={e => e.target.value && set({ ...t, at: e.target.value })} /></Row>
      <Row label="Time zone"><TimeZoneSelect value={t.tz} onChange={tz => set({ ...t, tz })} /></Row>
    </>
  );
}

export function TriggerPanel({ client, config, onChange, webhookUrl }: { client: BaseClient; config: AutomationConfig; onChange: (c: AutomationConfig) => void; webhookUrl: string | null }) {
  const s = schemaLite(client.schema);
  const t = config.trigger;
  const set = (next: Trigger) => onChange({ ...config, trigger: next });
  const tableId = triggerTableId(t);
  const fields = tableId ? usable(client.fields(tableId)) : [];
  return (
    <div className="auto-panel">
      <h3 className="auto-panel-title">Trigger</h3>
      <Row label="Run this automation">
        <select className="input" value={t.type} onChange={e => set(defaultTrigger(e.target.value as Trigger["type"], s, tzOf(t)))}>
          {TRIGGER_TYPES.map(x => <option key={x} value={x}>{TRIGGER_LABELS[x]}</option>)}
        </select>
      </Row>
      {tableId !== undefined && (
        <Row label="Table">
          <select className="input" value={tableId} onChange={e => set(withTable(t, e.target.value, s))}>
            {client.schema.tables.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Row>
      )}
      {t.type === "recordUpdated" && (
        <Row label="Only when one of these fields changes" hint="Leave all unchecked to run on any change.">
          <div className="auto-checks">
            {fields.map(f => (
              <label key={f.id} className="auto-check">
                <input type="checkbox" checked={!!t.fieldIds?.includes(f.id)} onChange={e => set({ ...t, fieldIds: e.target.checked ? [...(t.fieldIds ?? []), f.id] : (t.fieldIds ?? []).filter(x => x !== f.id) })} /> {f.name}
              </label>
            ))}
          </div>
        </Row>
      )}
      {(t.type === "recordCreated" || t.type === "recordUpdated" || t.type === "recordMatches" || t.type === "dateReached") && (
        <Row label={t.type === "recordMatches" ? "Conditions (runs when a record starts to match them)" : "Only records that match"}>
          <FilterEditor fields={fields} spec={t.conditions ?? EMPTY} onChange={spec => set({ ...t, conditions: spec } as Trigger)} emptyText={t.type === "recordMatches" ? "Add at least one condition." : "All records."} />
        </Row>
      )}
      {t.type === "schedule" && <ScheduleFields t={t} set={set} />}
      {t.type === "dateReached" && <DateFields t={t} set={set} fields={fields} />}
      {t.type === "webhook" &&
        (webhookUrl && t.token ? (
          <>
            <Row label="Webhook URL">
              <div className="auto-copy">
                <input className="input mono" readOnly value={webhookUrl} onFocus={e => e.target.select()} />
                <Button small onClick={() => copyText(webhookUrl)}>Copy</Button>
              </div>
            </Row>
            <p className="muted small">Send a POST request with a JSON or form body; steps can use its values, such as {"{{trigger.body.email}}"}. Anyone with this URL can start the automation; make a new URL from the menu if it leaks.</p>
            <pre className="auto-code">{`curl -X POST -H "Content-Type: application/json" \\\n  -d '{"email":"ada@example.com"}' \\\n  ${webhookUrl}`}</pre>
          </>
        ) : (
          <p className="muted small">Save the automation to get its webhook URL.</p>
        ))}
      {t.type === "button" && (
        <>
          <label className="auto-check"><input type="checkbox" checked={t.viewerCanRun} onChange={e => set({ ...t, viewerCanRun: e.target.checked })} /> Read-only members can run it</label>
          <p className="muted small">Add a field of type Button to this table and choose this automation in its settings.</p>
        </>
      )}
    </div>
  );
}

type Tpl = (value: string, set: (v: string) => void, opts?: { multiline?: boolean; placeholder?: string; label?: string }) => ReactNode;

function RecordStep({ client, config, step, onChange, tpl }: { client: BaseClient; config: AutomationConfig; step: Extract<Step, { type: "createRecord" | "updateRecords" }>; onChange: (s: Step) => void; tpl: Tpl }) {
  const fields = client.fields(step.tableId).filter(f => !COMPUTED_TYPES.has(f.type));
  const chosen = Object.keys(step.values);
  const flat = flatSteps(config.steps);
  const before = flat.slice(0, flat.findIndex(x => x.id === step.id));
  const sources: { value: string; label: string; tableId: string }[] =
    step.type === "updateRecords"
      ? [
          ...(RECORD_SOURCES.has(config.trigger.type) ? [{ value: "trigger", label: "The trigger record", tableId: triggerTableId(config.trigger)! }] : []),
          ...before.flatMap(x => (x.type === "findRecords" || x.type === "createRecord" ? [{ value: x.id, label: `Records from step ${x.id} (${STEP_LABELS[x.type]})`, tableId: x.tableId }] : [])),
        ]
      : [];
  return (
    <>
      {step.type === "createRecord" ? (
        <Row label="Table">
          <select className="input" value={step.tableId} onChange={e => onChange({ ...step, tableId: e.target.value, values: {} })}>
            {client.schema.tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Row>
      ) : (
        <Row label="Records to update" hint={sources.length ? undefined : "Add a Find records step first, or use a trigger that has a record."}>
          <select
            className="input"
            value={step.target}
            onChange={e => {
              const src = sources.find(x => x.value === e.target.value);
              if (src) onChange({ ...step, target: src.value, tableId: src.tableId, values: src.tableId === step.tableId ? step.values : {} });
            }}
          >
            {!sources.some(x => x.value === step.target) && <option value={step.target}>Choose</option>}
            {sources.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </Row>
      )}
      <div className="auto-field">
        <span className="auto-field-label">Field values</span>
        {chosen.map(fid => {
          const f = fields.find(x => x.id === fid);
          return (
            <div key={fid} className="auto-value">
              <span className="auto-value-name">{f?.name ?? "Deleted field"}</span>
              {tpl(step.values[fid], v => onChange({ ...step, values: { ...step.values, [fid]: v } }), { label: f?.name })}
              <button
                className="icon-btn"
                onClick={() => {
                  const rest = { ...step.values };
                  delete rest[fid];
                  onChange({ ...step, values: rest });
                }}
                aria-label="Remove field"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          );
        })}
        <select className="input" value="" onChange={e => e.target.value && onChange({ ...step, values: { ...step.values, [e.target.value]: "" } })} aria-label="Set a field">
          <option value="">Set a field...</option>
          {fields.filter(f => !chosen.includes(f.id)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <span className="muted small">Option and linked record names are matched, and created when missing. A value that is only a variable keeps its type, so {"{{trigger.record}}"} in a link field links the trigger record.</span>
      </div>
    </>
  );
}

function FindStep({ client, step, onChange }: { client: BaseClient; step: Extract<Step, { type: "findRecords" }>; onChange: (s: Step) => void }) {
  const fields = usable(client.fields(step.tableId));
  const sort = step.sort?.[0];
  return (
    <>
      <Row label="Table">
        <select className="input" value={step.tableId} onChange={e => onChange({ ...step, tableId: e.target.value, conditions: EMPTY, sort: undefined })}>
          {client.schema.tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Row>
      <Row label="Conditions" hint="Text values can use variables, such as {{trigger.body.email}}. A variable that comes out empty finds no records.">
        <FilterEditor fields={fields} spec={step.conditions ?? EMPTY} onChange={spec => onChange({ ...step, conditions: spec })} emptyText="All records." />
      </Row>
      <Row label="Sort">
        <div className="auto-inline">
          <select className="input" value={sort?.fieldId ?? ""} onChange={e => onChange({ ...step, sort: e.target.value ? [{ fieldId: e.target.value, dir: sort?.dir ?? "asc" }] : undefined })} aria-label="Sort field">
            <option value="">Table order</option>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {sort && (
            <select className="input" value={sort.dir} onChange={e => onChange({ ...step, sort: [{ fieldId: sort.fieldId, dir: e.target.value as "asc" | "desc" }] })} aria-label="Direction">
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          )}
        </div>
      </Row>
      <Row label="At most"><input className="input" type="number" min={1} max={100} value={step.limit} onChange={e => onChange({ ...step, limit: clampInt(e.target.value, 1, 100) })} /></Row>
    </>
  );
}

export function StepPanel({ client, config, step, log, onChange, onMove, onRemove }: { client: BaseClient; config: AutomationConfig; step: Step; log?: StepLog; onChange: (s: Step) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  const vars = variablesFor(config, step.id, schemaLite(client.schema));
  const tpl: Tpl = (value, set, opts = {}) => <TemplateInput value={value} onChange={set} variables={vars} multiline={opts.multiline} placeholder={opts.placeholder} ariaLabel={opts.label} />;
  let body: ReactNode = null;
  switch (step.type) {
    case "createRecord":
    case "updateRecords":
      body = <RecordStep client={client} config={config} step={step} onChange={onChange} tpl={tpl} />;
      break;
    case "findRecords":
      body = <FindStep client={client} step={step} onChange={onChange} />;
      break;
    case "http": {
      const setHeader = (i: number, h: [string, string]) => onChange({ ...step, headers: step.headers.map((x, j) => (j === i ? h : x)) });
      body = (
        <>
          <Row label="Method">
            <select className="input" value={step.method} onChange={e => onChange({ ...step, method: e.target.value as typeof step.method })}>
              {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Row>
          <Row label="URL">{tpl(step.url, url => onChange({ ...step, url }), { placeholder: "https://example.com/hook", label: "URL" })}</Row>
          <Row label="Headers" hint="Everyone who can edit this base can see header values. Values of headers such as Authorization are hidden in the run log.">
            {step.headers.map(([k, v], i) => (
              <div key={i} className="auto-inline">
                <input className="input" value={k} placeholder="Name" onChange={e => setHeader(i, [e.target.value, v])} aria-label="Header name" />
                {tpl(v, val => setHeader(i, [k, val]), { placeholder: "Value", label: "Header value" })}
                <button className="icon-btn" onClick={() => onChange({ ...step, headers: step.headers.filter((_, j) => j !== i) })} aria-label="Remove header"><Icon name="x" size={14} /></button>
              </div>
            ))}
            <Button small variant="ghost" icon="plus" onClick={() => onChange({ ...step, headers: [...step.headers, ["", ""]] })}>Add header</Button>
          </Row>
          {step.method !== "GET" && <Row label="Body">{tpl(step.body ?? "", b => onChange({ ...step, body: b || undefined }), { multiline: true, placeholder: '{"name": "{{trigger.record.Name}}"}', label: "Body" })}</Row>}
        </>
      );
      break;
    }
    case "email":
      body = (
        <>
          <Row label="Send with" hint={<>Resend and SMTP are set up by a workspace owner in <a href={`/settings/email?ws=${client.info.base.workspace_id}`}>Settings, Email sending</a>.</>}>
            <select className="input" value={step.provider} onChange={e => onChange({ ...step, provider: e.target.value as typeof step.provider })}>
              <option value="system">System email (when this server has it)</option>
              <option value="resend">Resend</option>
              <option value="smtp">SMTP</option>
            </select>
          </Row>
          <Row label="To" hint="Separate addresses with commas.">{tpl(step.to, to => onChange({ ...step, to }), { placeholder: "ops@example.com", label: "To" })}</Row>
          <Row label="Cc">{tpl(step.cc ?? "", cc => onChange({ ...step, cc: cc || undefined }), { label: "Cc" })}</Row>
          <Row label="Subject">{tpl(step.subject, subject => onChange({ ...step, subject }), { label: "Subject" })}</Row>
          <Row label="Format">
            <select className="input" value={step.format} onChange={e => onChange({ ...step, format: e.target.value as "text" | "html" })}>
              <option value="text">Plain text</option>
              <option value="html">HTML</option>
            </select>
          </Row>
          <Row label="Message" hint={step.format === "html" ? "Values from records are escaped, so they show as text." : undefined}>{tpl(step.body, b => onChange({ ...step, body: b }), { multiline: true, label: "Message" })}</Row>
        </>
      );
      break;
    case "branch": {
      const setCond = (i: number, patch: Partial<BranchCondition>) => onChange({ ...step, conditions: step.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
      body = (
        <>
          <Row label="Take the first column when">
            <select className="input" value={step.match} onChange={e => onChange({ ...step, match: e.target.value as "all" | "any" })}>
              <option value="all">all conditions hold</option>
              <option value="any">any condition holds</option>
            </select>
          </Row>
          {step.conditions.map((c, i) => (
            <div key={i} className="auto-cond">
              {tpl(c.left, left => setCond(i, { left }), { placeholder: "{{trigger.record.Stage}}", label: "Value" })}
              <select className="input" value={c.op} onChange={e => setCond(i, { op: e.target.value as BranchOp })} aria-label="Comparison">
                {BRANCH_OPS.map(op => <option key={op} value={op}>{BRANCH_LABELS[op]}</option>)}
              </select>
              {c.op !== "empty" && c.op !== "notempty" && tpl(c.right ?? "", right => setCond(i, { right }), { label: "Compared with" })}
              <button className="icon-btn" disabled={step.conditions.length === 1} onClick={() => onChange({ ...step, conditions: step.conditions.filter((_, j) => j !== i) })} aria-label="Remove condition"><Icon name="x" size={14} /></button>
            </div>
          ))}
          <Button small variant="ghost" icon="plus" onClick={() => onChange({ ...step, conditions: [...step.conditions, { left: "", op: "eq", right: "" }] })}>Add condition</Button>
          <p className="muted small">Text comparisons ignore case. Greater and less than compare numbers when both sides are numbers.</p>
        </>
      );
      break;
    }
  }
  return (
    <div className="auto-panel">
      <div className="auto-panel-head">
        <h3 className="auto-panel-title">{STEP_LABELS[step.type]} <span className="step-id">{step.id}</span></h3>
        <button className="icon-btn" onClick={() => onMove(-1)} aria-label="Move up"><Icon name="chevron" size={14} className="flip" /></button>
        <button className="icon-btn" onClick={() => onMove(1)} aria-label="Move down"><Icon name="chevron" size={14} /></button>
        <button className="icon-btn" onClick={onRemove} aria-label="Delete step"><Icon name="trash" size={14} /></button>
      </div>
      {body}
      {log && <StepLogView log={log} title="Last test" />}
    </div>
  );
}
```

- [ ] **Step 5: Flow editor and page**

`src/web/auto/FlowEditor.tsx`:

```tsx
// The flow of an automation: the trigger card, step cards with "+" between them, branch columns, and the settings panel.
import { Fragment, useState } from "react";
import { STEP_TYPES, type AutomationConfig, type AutomationRun, type Step, type StepLog, type StepType } from "../../shared/automations";
import type { BaseClient } from "../base/client";
import { Icon, Menu } from "../ui";
import { defaultStep, findStep, insertStep, moveStep, removeStep, replaceStep, schemaLite, STEP_ICONS, STEP_LABELS, stepSummary, TRIGGER_ICONS, TRIGGER_LABELS, triggerSummary, type Slot } from "./flow";
import { StepPanel, TriggerPanel } from "./Panels";

export function FlowEditor({ client, config, onChange, selected, onSelect, test, readOnly, webhookUrl }: {
  client: BaseClient;
  config: AutomationConfig;
  onChange: (c: AutomationConfig) => void;
  selected: string;
  onSelect: (id: string) => void;
  test: AutomationRun | null;
  readOnly: boolean;
  webhookUrl: string | null;
}) {
  const s = schemaLite(client.schema);
  const [adding, setAdding] = useState<{ anchor: HTMLElement; slot: Slot } | null>(null);
  const logs = new Map<string, StepLog>((test?.steps ?? []).map(l => [l.id, l]));
  const setSteps = (steps: Step[]) => onChange({ ...config, steps });
  const add = (slot: Slot, type: StepType) => {
    const st = defaultStep(type, config.steps, config.trigger, s);
    setSteps(insertStep(config.steps, slot, st));
    onSelect(st.id);
  };
  const plus = (slot: Slot) =>
    !readOnly && (
      <button className="flow-plus" aria-label="Add a step" onClick={e => setAdding({ anchor: e.currentTarget, slot })}>
        <Icon name="plus" size={13} />
      </button>
    );
  const status = (id: string) => {
    const l = logs.get(id);
    return l ? <span className={"flow-status " + l.status} title={l.error ?? "Succeeded in the last test"}><Icon name={l.status === "ok" ? "check" : "x"} size={12} /></span> : null;
  };
  const card = (st: Step) => (
    <button className={"flow-card" + (selected === st.id ? " selected" : "")} onClick={() => onSelect(st.id)}>
      <span className="flow-icon"><Icon name={STEP_ICONS[st.type]} size={15} /></span>
      <span className="flow-text">
        <span className="flow-title">{STEP_LABELS[st.type]} <span className="step-id">{st.id}</span></span>
        <span className="flow-sub">{stepSummary(st, s)}</span>
      </span>
      {status(st.id)}
    </button>
  );
  const list = (steps: Step[], parent?: { parentId: string; side: "then" | "else" }) => (
    <div className="flow-list">
      {steps.map((st, i) => (
        <Fragment key={st.id}>
          {plus({ ...parent, index: i })}
          {card(st)}
          {st.type === "branch" && (
            <div className="flow-branch">
              <div className="flow-side">
                <div className="flow-side-title">If the conditions hold</div>
                {list(st.then, { parentId: st.id, side: "then" })}
              </div>
              <div className="flow-side">
                <div className="flow-side-title">Otherwise</div>
                {list(st.else, { parentId: st.id, side: "else" })}
              </div>
            </div>
          )}
        </Fragment>
      ))}
      {plus({ ...parent, index: steps.length })}
    </div>
  );
  const step = selected === "trigger" ? undefined : findStep(config.steps, selected);
  return (
    <div className={"flow-wrap" + (readOnly ? " read-only" : "")}>
      <div className="flow">
        <button className={"flow-card trigger" + (selected === "trigger" ? " selected" : "")} onClick={() => onSelect("trigger")}>
          <span className="flow-icon"><Icon name={TRIGGER_ICONS[config.trigger.type]} size={15} /></span>
          <span className="flow-text">
            <span className="flow-title">{TRIGGER_LABELS[config.trigger.type]}</span>
            <span className="flow-sub">{triggerSummary(config.trigger, s)}</span>
          </span>
        </button>
        {list(config.steps)}
      </div>
      {!readOnly && (
        <aside className="flow-panel">
          {!step ? (
            <TriggerPanel client={client} config={config} onChange={onChange} webhookUrl={webhookUrl} />
          ) : (
            <StepPanel
              client={client}
              config={config}
              step={step}
              log={logs.get(step.id)}
              onChange={next => setSteps(replaceStep(config.steps, step.id, next))}
              onMove={dir => setSteps(moveStep(config.steps, step.id, dir))}
              onRemove={() => {
                setSteps(removeStep(config.steps, step.id));
                onSelect("trigger");
              }}
            />
          )}
        </aside>
      )}
      {adding && (
        <Menu
          anchor={adding.anchor}
          onClose={() => setAdding(null)}
          items={STEP_TYPES.filter(t => !(t === "branch" && adding.slot.parentId)).map(t => ({ label: STEP_LABELS[t], icon: STEP_ICONS[t], onClick: () => add(adding.slot, t) }))}
        />
      )}
    </div>
  );
}
```

`src/web/auto/AutomationsPage.tsx`:

```tsx
// The automations of a base: the list, the flow editor with its settings panels, test runs and the run log.
import { useCallback, useEffect, useState } from "react";
import { RECORD_SOURCES, triggerTableId, type Automation, type AutomationConfig, type AutomationRun } from "../../shared/automations";
import { useBase, type BaseClient } from "../base/client";
import { navigate } from "../router";
import { Button, Icon, Menu, Modal, Spinner, type MenuItem } from "../ui";
import { toast, toastError } from "../toast";
import { automationOp, listAutomations, testRun, webhookUrl, type AutomationList } from "./api";
import { defaultTrigger, localZone, PRESETS, schemaLite, toDisplayConfig, toStoredConfig, TRIGGER_ICONS } from "./flow";
import { FlowEditor } from "./FlowEditor";
import { RunsPanel, StatusDot } from "./RunsPanel";
import "./auto.css";

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

export default function AutomationsPage({ client, automationId }: { client: BaseClient; automationId?: string }) {
  useBase(client);
  const [data, setData] = useState<AutomationList | null>(null);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: (MenuItem | "sep")[] } | null>(null);
  const narrow = useNarrow();
  const load = useCallback(() => listAutomations(client.baseId).then(setData).catch(e => setError(e instanceof Error ? e.message : String(e))), [client.baseId]);
  useEffect(() => {
    load();
    return client.onAutomations(() => void load());
  }, [client, load]);
  const go = useCallback((id?: string, replace = false) => navigate(`/base/${client.baseId}/automations${id ? "/" + id : ""}`, { replace }), [client.baseId]);
  const selected = data?.automations.find(a => a.id === automationId) ?? null;
  useEffect(() => {
    if (data && !selected && data.automations.length && !narrow) go(data.automations[0].id, true);
  }, [data, selected, narrow, go]);
  const setList = (automations: Automation[]) => setData(d => (d ? { ...d, automations } : d));

  const create = async (name: string, config: AutomationConfig) => {
    try {
      const r = await automationOp(client.baseId, { op: "create", name, config: toStoredConfig(config, client.schema.fields) });
      setList(r.automations);
      go(r.id);
    } catch (e) {
      toastError(e);
    }
  };
  const newMenu = (anchor: HTMLElement) =>
    setMenu({
      anchor,
      items: [
        { label: "Blank automation", icon: "plus", onClick: () => create("New automation", { trigger: defaultTrigger("recordCreated", schemaLite(client.schema), localZone()), steps: [] }) },
        "sep",
        ...PRESETS.map(p => ({
          label: p.name,
          icon: "bolt",
          onClick: () => {
            const cfg = p.build(schemaLite(client.schema), localZone());
            if (cfg) create(p.name, cfg);
            else toast("No table in this base fits this template", "error");
          },
        })),
      ],
    });
  const toggle = (a: Automation, enabled: boolean) => automationOp(client.baseId, { op: "setEnabled", id: a.id, enabled }).then(r => setList(r.automations)).catch(toastError);

  if (error) return <div className="center-page"><p className="muted">{error}</p></div>;
  if (!data) return <div className="center-page"><Spinner /></div>;
  return (
    <div className={"auto-page" + (narrow ? " narrow" : "")}>
      <aside className="auto-list" aria-label="Automations">
        <div className="auto-list-head">
          <span className="auto-list-title">Automations</span>
          {!narrow && client.writable && <Button small icon="plus" onClick={e => newMenu(e.currentTarget)}>New</Button>}
        </div>
        {data.automations.length === 0 && <p className="muted small auto-list-empty">No automations yet. They run steps when records change, at set times, when an app calls a webhook, or when someone clicks a button.</p>}
        {data.automations.map(a => (
          <div key={a.id} className={"auto-item" + (a.id === selected?.id ? " active" : "") + (a.disabledReason ? " broken" : "")}>
            <button className="auto-item-main" onClick={() => go(a.id)}>
              <Icon name={TRIGGER_ICONS[a.config.trigger.type]} size={15} />
              <span className="auto-item-text">
                <span className="auto-item-name">{a.name}</span>
                <span className="muted small">{a.lastRun ? <><StatusDot status={a.lastRun.status} /> {timeAgo(a.lastRun.at)}</> : "Never ran"}</span>
              </span>
            </button>
            <label className="switch" title={a.enabled ? "On" : "Off"}>
              <input type="checkbox" checked={a.enabled} disabled={!client.writable || narrow} onChange={e => toggle(a, e.target.checked)} aria-label={`${a.name} on`} />
              <span />
            </label>
          </div>
        ))}
        <div className="auto-usage muted small">{data.usage.limit ? `${data.usage.used.toLocaleString()} of ${data.usage.limit.toLocaleString()} runs this month` : `${data.usage.used.toLocaleString()} runs this month`}</div>
      </aside>
      <section className="auto-main">
        {selected ? (
          <AutomationEditor
            key={selected.id}
            client={client}
            automation={selected}
            data={data}
            readOnly={narrow || !client.writable}
            onList={setList}
            onDeleted={() => {
              load();
              go(undefined, true);
            }}
          />
        ) : (
          <div className="center-page"><p className="muted">{data.automations.length ? "Choose an automation." : "Create an automation to get started."}</p></div>
        )}
      </section>
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function AutomationEditor({ client, automation, data, readOnly, onList, onDeleted }: { client: BaseClient; automation: Automation; data: AutomationList; readOnly: boolean; onList: (list: Automation[]) => void; onDeleted: () => void }) {
  const fields = client.schema.fields;
  const shown = () => toDisplayConfig(automation.config, fields);
  const [name, setName] = useState(automation.name);
  const [draft, setDraft] = useState<AutomationConfig>(shown);
  const [saved, setSaved] = useState(() => JSON.stringify([automation.name, shown()]));
  const dirty = JSON.stringify([name, draft]) !== saved;
  const [tab, setTab] = useState<"editor" | "runs">("editor");
  const [selected, setSelected] = useState("trigger");
  const [test, setTest] = useState<AutomationRun | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  // Someone else saved this automation: take their version unless there are local edits.
  useEffect(() => {
    if (dirty) return;
    setName(automation.name);
    setDraft(shown());
    setSaved(JSON.stringify([automation.name, shown()]));
  }, [automation.updatedAt]);

  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await automationOp(client.baseId, { op: "update", id: automation.id, name, config: toStoredConfig(draft, fields) });
      setSaved(JSON.stringify([name, draft]));
      onList(r.automations);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const startTest = async () => {
    if (dirty && !(await save())) return;
    setTesting(true);
  };
  const t = automation.config.trigger;
  const hookUrl = t.type === "webhook" ? webhookUrl(data.origin, client.baseId, t.token) : null;
  const items: (MenuItem | "sep")[] = [
    {
      label: "Duplicate",
      icon: "copy",
      onClick: () =>
        automationOp(client.baseId, { op: "create", name: `${name} copy`, config: toStoredConfig(draft, fields) })
          .then(r => {
            onList(r.automations);
            navigate(`/base/${client.baseId}/automations/${r.id}`);
          })
          .catch(toastError),
    },
    ...(t.type === "webhook"
      ? [{ label: "New webhook URL", icon: "link", onClick: () => window.confirm("Make a new webhook URL? The old URL stops working.") && automationOp(client.baseId, { op: "regenerateWebhook", id: automation.id }).then(r => onList(r.automations)).catch(toastError) } as MenuItem]
      : []),
    "sep",
    { label: "Delete automation", icon: "trash", danger: true, onClick: () => window.confirm(`Delete the automation "${automation.name}" and its run history?`) && automationOp(client.baseId, { op: "delete", id: automation.id }).then(onDeleted).catch(toastError) },
  ];
  return (
    <div className="auto-editor">
      <div className="auto-bar">
        <input className="auto-name" value={name} disabled={readOnly} onChange={e => setName(e.target.value)} aria-label="Automation name" />
        <div className="auto-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "editor"} className={tab === "editor" ? "active" : ""} onClick={() => setTab("editor")}>Editor</button>
          <button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>Runs</button>
        </div>
        <div className="grow" />
        {!readOnly && (
          <>
            <Button small icon="play" onClick={startTest} disabled={busy}>Test run</Button>
            <Button small variant="primary" onClick={save} disabled={!dirty || busy}>{busy && <Spinner size={12} />} Save</Button>
            <button className="icon-btn" onClick={e => setMenu(e.currentTarget)} aria-label="Automation options"><Icon name="dots" /></button>
          </>
        )}
      </div>
      {automation.disabledReason && <div className="auto-banner error">Switched off after 20 failed runs in a row. Check the run log, fix the cause, then switch it on again.</div>}
      {data.usage.limit > 0 && data.usage.used >= data.usage.limit && <div className="auto-banner">This base used its {data.usage.limit.toLocaleString()} automation runs for this month. New runs are skipped until next month.</div>}
      {!automation.enabled && !automation.disabledReason && !readOnly && <div className="auto-banner quiet">This automation is off. Switch it on in the list when it is ready.</div>}
      {tab === "editor" ? (
        <FlowEditor client={client} config={draft} onChange={setDraft} selected={selected} onSelect={setSelected} test={test} readOnly={readOnly} webhookUrl={hookUrl} />
      ) : (
        <RunsPanel client={client} automation={automation} />
      )}
      {testing && (
        <TestDialog
          client={client}
          automation={automation}
          onClose={() => setTesting(false)}
          onDone={run => {
            setTest(run);
            setTab("editor");
            toast(run.status === "succeeded" ? "Test run finished" : `Test run failed: ${run.error}`, run.status === "succeeded" ? "info" : "error");
          }}
        />
      )}
      {menu && <Menu anchor={menu} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function TestDialog({ client, automation, onClose, onDone }: { client: BaseClient; automation: Automation; onClose: () => void; onDone: (run: AutomationRun) => void }) {
  const t = automation.config.trigger;
  const tableId = RECORD_SOURCES.has(t.type) ? triggerTableId(t) : undefined;
  const [records, setRecords] = useState<{ id: number; t: string }[] | null>(tableId ? null : []);
  const [recordId, setRecordId] = useState<number | null>(null);
  const [body, setBody] = useState('{\n  "name": "Ada Lovelace",\n  "email": "ada@example.com"\n}');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!tableId) return;
    client.searchRecords(tableId, "", 50).then(r => {
      setRecords(r);
      setRecordId(r[0]?.id ?? null);
    }).catch(toastError);
  }, [client, tableId]);
  const run = async () => {
    let parsed: unknown;
    if (t.type === "webhook") {
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return toastError(new Error("The sample body is not valid JSON"));
      }
    }
    setBusy(true);
    try {
      onDone(await testRun(client.baseId, automation.id, { recordId: recordId ?? undefined, body: parsed }));
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Test run"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={run} disabled={busy || (!!tableId && recordId === null)}>{busy && <Spinner size={12} />} Run test</Button>
        </>
      }
    >
      <p className="auto-warn">Test runs make real changes: records are created or updated, requests are sent and emails go out. They do not start other automations and do not count toward the monthly limit.</p>
      {tableId &&
        (records === null ? (
          <Spinner />
        ) : records.length === 0 ? (
          <p className="muted">The table has no records to test with.</p>
        ) : (
          <label className="auto-field">
            <span className="auto-field-label">Record</span>
            <select className="input" value={recordId ?? ""} onChange={e => setRecordId(Number(e.target.value))}>
              {records.map(r => <option key={r.id} value={r.id}>{r.t || `Record ${r.id}`}</option>)}
            </select>
          </label>
        ))}
      {t.type === "webhook" && (
        <label className="auto-field">
          <span className="auto-field-label">Sample body (JSON)</span>
          <textarea className="input tpl-area mono" rows={6} value={body} onChange={e => setBody(e.target.value)} />
        </label>
      )}
    </Modal>
  );
}
```

`src/web/auto/auto.css`:

```css
.auto-page { display: flex; height: 100%; min-height: 0; background: var(--bg); }
.auto-list { width: 260px; flex: none; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; overflow: auto; }
.auto-list-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 8px 14px; }
.auto-list-title { font-weight: 600; }
.auto-list-empty { padding: 0 14px; }
.auto-item { display: flex; align-items: center; gap: 6px; padding: 0 10px 0 4px; border-left: 3px solid transparent; }
.auto-item.active { background: var(--accent-bg); border-left-color: var(--accent); }
.auto-item.broken .auto-item-name { color: var(--danger); }
.auto-item-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 8px 6px; border: 0; background: none; cursor: pointer; text-align: left; }
.auto-item-text { display: flex; flex-direction: column; min-width: 0; }
.auto-item-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.auto-usage { margin-top: auto; padding: 10px 14px; border-top: 1px solid var(--line); }
.switch { position: relative; width: 30px; height: 18px; flex: none; }
.switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.switch span { position: absolute; inset: 0; border-radius: 9px; background: var(--line-2); transition: background 0.15s; pointer-events: none; }
.switch span::after { content: ""; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
.switch input:checked + span { background: var(--ok); }
.switch input:checked + span::after { transform: translateX(12px); }
.switch input:disabled + span { opacity: 0.6; }
.auto-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.auto-editor { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.auto-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
.auto-name { font-size: 16px; font-weight: 600; border: 1px solid transparent; border-radius: 6px; padding: 4px 6px; min-width: 160px; background: transparent; }
.auto-name:hover:not(:disabled), .auto-name:focus { border-color: var(--line-2); outline: none; }
.auto-tabs { display: inline-flex; border: 1px solid var(--line-2); border-radius: 7px; overflow: hidden; }
.auto-tabs button { border: 0; background: var(--panel); padding: 4px 12px; cursor: pointer; font-size: 13px; }
.auto-tabs button.active { background: var(--accent-bg); color: var(--accent-ink); }
.auto-banner { padding: 8px 16px; font-size: 13px; background: #fff7e0; border-bottom: 1px solid var(--line); }
.auto-banner.error { background: #fdf1f1; color: var(--danger); }
.auto-banner.quiet { background: var(--panel-2); color: var(--muted); }
.auto-warn { margin: 0 0 12px; padding: 8px 10px; border-radius: 7px; background: #fff7e0; font-size: 13px; }
.flow-wrap { flex: 1; min-height: 0; display: flex; }
.flow { flex: 1; overflow: auto; padding: 20px 16px 40px; display: flex; flex-direction: column; align-items: center; }
.flow-list { display: flex; flex-direction: column; align-items: center; width: 100%; }
.flow-card { width: min(380px, 100%); display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--panel); cursor: pointer; text-align: left; }
.flow-card:hover { border-color: var(--muted); }
.flow-card.selected { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); }
.flow-card.trigger { border-style: solid; border-width: 1px 1px 1px 4px; border-left-color: var(--accent); }
.flow-icon { width: 30px; height: 30px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--panel-2); color: var(--ink-2); }
.flow-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.flow-title { font-weight: 600; font-size: 13px; }
.flow-sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.step-id { font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--muted); background: var(--panel-2); border-radius: 4px; padding: 0 4px; }
.flow-status { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; flex: none; }
.flow-status.ok { background: var(--ok); }
.flow-status.error { background: var(--danger); }
.flow-plus { position: relative; width: 22px; height: 22px; margin: 10px 0; border-radius: 50%; border: 1px solid var(--line-2); background: var(--panel); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--muted); }
.flow-plus::before, .flow-plus::after { content: ""; position: absolute; left: 50%; width: 1px; height: 10px; background: var(--line-2); }
.flow-plus::before { bottom: 100%; }
.flow-plus::after { top: 100%; }
.flow-plus:hover { color: var(--accent-ink); border-color: var(--accent); }
.flow-wrap.read-only .flow-card + .flow-card, .flow-wrap.read-only .flow-list > .flow-card { margin-top: 12px; }
.flow-branch { display: flex; gap: 12px; width: 100%; max-width: 820px; margin-top: 12px; }
.flow-side { flex: 1; min-width: 0; border: 1px dashed var(--line-2); border-radius: 10px; padding: 10px 8px; display: flex; flex-direction: column; align-items: center; }
.flow-side-title { font-size: 12px; color: var(--muted); font-weight: 600; }
.flow-panel { width: 380px; flex: none; border-left: 1px solid var(--line); background: var(--panel); overflow: auto; }
.auto-panel { padding: 14px 16px 24px; display: flex; flex-direction: column; gap: 12px; }
.auto-panel-head { display: flex; align-items: center; gap: 2px; }
.auto-panel-head .auto-panel-title { flex: 1; }
.auto-panel-title { margin: 0; font-size: 15px; }
.auto-field { display: flex; flex-direction: column; gap: 6px; }
.auto-field-label { font-size: 12px; color: var(--muted); }
.auto-inline { display: flex; gap: 6px; align-items: center; }
.auto-inline > .input, .auto-inline > .tpl-input { flex: 1; min-width: 0; }
.auto-checks { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow: auto; }
.auto-check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.auto-copy { display: flex; gap: 6px; }
.auto-value { display: grid; grid-template-columns: 110px 1fr auto; gap: 6px; align-items: center; }
.auto-value-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auto-cond { display: grid; grid-template-columns: 1fr 120px 1fr auto; gap: 6px; align-items: center; }
.auto-code { margin: 0; padding: 8px 10px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; }
.mono { font-family: var(--mono); font-size: 12px; }
.tpl-input { position: relative; }
.tpl-input .input { padding-right: 32px; }
.tpl-btn { position: absolute; right: 3px; top: 3px; }
.tpl-area { height: auto; padding: 8px 32px 8px 10px; resize: vertical; font-family: var(--mono); font-size: 12.5px; }
.tpl-group { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.02em; }
.tpl-menu { max-height: 360px; overflow: auto; }
.icon.flip { transform: rotate(180deg); }
.runs { flex: 1; overflow: auto; padding: 12px 16px 24px; }
.runs-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.runs-filter { width: auto; }
.runs-list { display: flex; flex-direction: column; gap: 6px; }
.run { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.run-row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 0; background: none; cursor: pointer; text-align: left; flex-wrap: wrap; }
.run-status { font-weight: 600; font-size: 13px; }
.run-error { color: var(--danger); }
.run-detail { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.run-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); vertical-align: middle; }
.run-dot.succeeded { background: var(--ok); }
.run-dot.failed { background: var(--danger); }
.run-dot.waiting_retry, .run-dot.running, .run-dot.queued { background: #d29b00; }
.step-log { border-left: 3px solid var(--ok); padding-left: 10px; display: flex; flex-direction: column; gap: 4px; }
.step-log.error { border-left-color: var(--danger); }
.step-log-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; flex-wrap: wrap; }
.auto-link { position: relative; }
.alert-dot { position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; background: var(--danger); }
@media (max-width: 767px) {
  .auto-page { flex-direction: column; overflow: auto; }
  .auto-list { width: 100%; border-right: 0; border-bottom: 1px solid var(--line); max-height: none; overflow: visible; }
  .auto-main { min-height: 60vh; }
  .flow { padding: 16px; }
  .flow-branch { flex-direction: column; }
}
```

- [ ] **Step 6: Routes and the base page**

`src/web/main.tsx`: before the `/base/:baseId/:tableId?/:viewId?` match, add:

```tsx
  else if ((m = match("/base/:baseId/automations/:autoId?", path))) page = <BasePage key={m.baseId} baseId={m.baseId} automations automationId={m.autoId} />;
```

(keep the dashboard match first; the chain stays `if ... else if ...`).

`src/web/base/BasePage.tsx`:
- Imports: `useRef` from react, `const AutomationsPage = lazy(() => import("../auto/AutomationsPage"));`, `import { listAutomations } from "../auto/api";`.
- `BasePage` and `BaseShell` props gain `automations?: boolean; automationId?: string`, passed through.
- `expanded` starts from the `record` query parameter, and the reset on table change skips the first render:

```tsx
  const [expanded, setExpanded] = useState<number | null>(() => {
    const r = Number(new URLSearchParams(location.search).get("record"));
    return Number.isInteger(r) && r > 0 ? r : null;
  });
  const shownTable = useRef(table?.id);
  useEffect(() => {
    if (shownTable.current !== table?.id) setExpanded(null);
    shownTable.current = table?.id;
  }, [table?.id]);
```

(replacing `useEffect(() => setExpanded(null), [table?.id]);`).
- The URL effect returns early when `automations` is set: first line `if (automations) return;`, and add `automations` to its dependency list.
- The red dot:

```tsx
  const [autoAlert, setAutoAlert] = useState(false);
  useEffect(() => {
    if (client.info.role === "viewer") return;
    const check = () => listAutomations(client.baseId).then(d => setAutoAlert(d.automations.some(a => !!a.disabledReason))).catch(() => undefined);
    check();
    return client.onAutomations(check);
  }, [client]);
```

- In the header, before the Share link:

```tsx
        {client.info.role !== "viewer" && (
          <Link to={`/base/${client.baseId}/automations`} className={"btn btn-sm auto-link" + (automations ? " active" : "")}>
            <Icon name="bolt" size={14} /> Automations
            {autoAlert && <span className="alert-dot" title="An automation was switched off after repeated failures" />}
          </Link>
        )}
```

- Table tabs: the active test becomes `!dash && !automations && t.id === table?.id` (both places), and the sidebar toggle shows only when `!dash && !automations`.
- The body: wrap the existing `dash ? (...) : (...)` as the else branch of:

```tsx
      {automations ? (
        <div className="base-body">
          <main className="view-main">
            <Suspense fallback={<div className="center-page"><Spinner /></div>}>
              <AutomationsPage client={client} automationId={automationId} />
            </Suspense>
          </main>
        </div>
      ) : dash ? ( ...existing dashboard body... ) : ( ...existing table body... )}
```

`.auto-link` and `.alert-dot` are defined in `auto.css`; also add them to `base.css` so the header looks right before the automations chunk loads:

```css
.auto-link { position: relative; }
.alert-dot { position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; background: var(--danger); }
```

- [ ] **Step 7: Typecheck, build and smoke check**

Run: `npm run typecheck && npm run build 2>&1 | tail -15`
Expected: typecheck clean; the build lists a separate `AutomationsPage-*.js` chunk; table pages do not import it (check that `BasePage-*.js` does not contain the string "Insert variable": `grep -L "Insert variable" dist/client/assets/BasePage-*.js` prints the file).

Run (in the background): `npm run dev`, then with the Playwright MCP: sign in, open a CRM base, click "Automations", create "Blank automation", add an HTTP step, save, reload the page and confirm the step is still there. Check the browser console has no errors.
Expected: the page renders the list, the flow and the panel; the saved step survives a reload.

- [ ] **Step 8: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: whole suite passes. Record in the ledger: `Task 13: typecheck clean, build ok, smoke check ok, suite <N>/<N>`.

---

### Task 14: Button field

**Files:**
- Create: `src/web/auto/button.ts`
- Modify: `src/shared/types.ts` (`FieldType` `button`, `FIELD_TYPES`, `COMPUTED_TYPES`, `FieldOptions.label`, `color`, `automationId`)
- Modify: `src/worker/base/store.ts` (`normalizeOptions` for button; button cannot be the primary field)
- Modify: `src/web/base/cells.ts` (`HEADER_ICONS.button`, `toGridCell` button cell, `buttonRenderer`)
- Modify: `src/web/base/GridView.tsx` (renderer, click, busy state)
- Modify: `src/web/base/RecordModal.tsx` (button in the record view)
- Modify: `src/web/base/FieldDialog.tsx` (button options)
- Modify: `src/web/ui.tsx` (`PATHS.button` exists from Task 13; `FieldIcon` uses it)
- Test: `test/worker/button-field.test.ts`

**Interfaces:**
- Consumes: `runButton` (Task 12); `Schema.buttons` (Task 4); `BaseClient.buttonBusy` (Task 13).
- Produces: `runButtonField(client, field, recordId)`; field type `button` with options `{ label?, color?, automationId? }`; `ButtonData`, `buttonRenderer`; `toGridCell(f, r, writable, members, wrap, busy?)`.

- [ ] **Step 1: Write the failing test**

`test/worker/button-field.test.ts`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";

const actor = { userId: "u1", name: "Tester" };

describe("button fields", () => {
  it("store their options, hold no data, export empty and cannot be the primary field", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("button-field"));
    await runInDurableObject(stub, async (i: BaseDO) => {
      const s = i.store;
      s.init("button-field");
      const t = s.createTable(actor, { name: "Deals", fields: [{ name: "Name", type: "text" }] }).tableId;
      const btn = s.createField(t, { name: "Approve", type: "button", options: { label: "Approve deal", color: "#dff5dc", automationId: "autX", precision: 3 } }).fieldId;
      expect(s.field(btn).options).toEqual({ label: "Approve deal", color: "#dff5dc", automationId: "autX" });
      const name = s.fieldsOf(t)[0].id;
      const id = s.createRows(actor, t, [{ cells: { [name]: "Acme", [btn]: "clicked" } }]).created![0];
      expect(s.getRows(t, [id])[0].cells).toEqual({ [name]: "Acme" });
      expect(s.exportCsv(t).split("\r\n")).toEqual(["Name,Approve", "Acme,"]);
      expect(() => s.updateTable(t, { primaryFieldId: btn })).toThrow("This field cannot be the primary field");
      expect(() => s.createTable(actor, { name: "X", fields: [{ name: "Go", type: "button" }] })).toThrow("Invalid primary field");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project worker test/worker/button-field.test.ts`
Expected: FAIL; the options come back as `{}` (no `button` case in `normalizeOptions`) and the cell value is stored.

- [ ] **Step 3: Write the implementation**

`src/shared/types.ts`:
- `FieldType` gains `| "button"`.
- `FIELD_TYPES` gains `{ type: "button", label: "Button" }` after `autonumber`.
- `COMPUTED_TYPES` gains `"button"` (it holds no data and cannot be written).
- `FieldOptions` gains:

```ts
  // button
  label?: string;
  color?: string;
  automationId?: string;
```

`src/worker/base/store.ts`:
- In `normalizeOptions`, a new case:

```ts
      case "button":
        out.label = String(o.label ?? "").trim().slice(0, 40) || "Run";
        if (o.color) out.color = String(o.color).slice(0, 20);
        if (o.automationId) out.automationId = String(o.automationId);
        break;
```

- In `updateTable` and `updateField`, add `"button"` to the lists of types that cannot be the primary field (`["link", "attachment", "checkbox", "lookup", "rollup", "button"]`).

`src/web/base/cells.ts`:
- `HEADER_ICONS` gains `button: GridColumnIcon.HeaderString,`.
- `toGridCell` gets a sixth parameter `busy = false` and a case before `default`:

```ts
    case "button":
      return { kind: GridCellKind.Custom, data: { kind: "rf-button", label: f.options.label || "Run", color: f.options.color || "#ece8e3", busy }, copyData: "", allowOverlay: false, readonly: true, cursor: "pointer" } as ButtonCell;
```

- New renderer:

```ts
export interface ButtonData {
  kind: "rf-button";
  label: string;
  color: string;
  busy: boolean;
}

export type ButtonCell = CustomCell<ButtonData>;

/** A Button field cell: a pill with the button's label, or "Running..." while its automation runs. */
export const buttonRenderer: CustomRenderer<ButtonCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is ButtonCell => (c.data as ButtonData | undefined)?.kind === "rf-button",
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const label = cell.data.busy ? "Running..." : cell.data.label;
    ctx.save();
    ctx.font = `600 12.5px ${theme.fontFamily}`;
    const pad = theme.cellHorizontalPadding;
    const w = Math.min(rect.width - 2 * pad, ctx.measureText(label).width + 20);
    const h = 24;
    const x = rect.x + pad;
    const y = rect.y + rect.height / 2 - h / 2;
    ctx.fillStyle = cell.data.color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.fillStyle = "#2b2723";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + 10, y + h / 2 + 0.5, Math.max(0, w - 20));
    ctx.restore();
    return true;
  },
};
```

`src/web/auto/button.ts`:

```ts
// Runs the automation behind a Button field for one record and reports the outcome.
import type { Field } from "../../shared/types";
import type { BaseClient } from "../base/client";
import { toast, toastError } from "../toast";
import { runButton } from "./api";

export async function runButtonField(client: BaseClient, field: Field, recordId: number) {
  const id = field.options.automationId;
  const info = client.schema.buttons?.find(b => b.id === id);
  if (!id || !info) return toast("This button has no automation yet. Choose one in the field settings.", "error");
  if (!info.enabled) return toast(`The automation "${info.name}" is turned off`, "error");
  const key = `${field.id}:${recordId}`;
  if (client.buttonBusy.has(key)) return;
  client.buttonBusy.add(key);
  client.emit();
  try {
    const r = await runButton(client.baseId, id, recordId);
    if (r.status === "succeeded") toast(`${info.name}: done`);
    else toast(`${info.name}: ${r.error ?? r.status}`, "error");
  } catch (e) {
    toastError(e);
  } finally {
    client.buttonBusy.delete(key);
    client.emit();
  }
}
```

`src/web/base/GridView.tsx`:
- Import `buttonRenderer` from `./cells` and `runButtonField` from `../auto/button`.
- `getCellContent` passes the busy flag: `return toGridCell(f, client.row(tableId, id), writable, client.members, wrapText, client.buttonBusy.has(`${f.id}:${id}`));`
- `onCellClicked` becomes:

```ts
  const onCellClicked = useCallback(
    ([col, row]: Item) => {
      const h = display?.[row];
      if (h?.kind === "header") return toggleGroup(h.path);
      const f = fields[col];
      const id = rowIds[row];
      if (f?.type === "button" && id !== undefined) runButtonField(client, f, id);
    },
    [display, toggleGroup, fields, rowIds, client],
  );
```

- `customRenderers={[chipsRenderer, groupHeaderRenderer, buttonRenderer]}`.

`src/web/base/RecordModal.tsx`: import `runButtonField`; the "computed" note becomes `{COMPUTED_TYPES.has(f.type) && f.type !== "button" && <span className="muted small">computed</span>}`, and the editor is chosen by type:

```tsx
              {f.type === "button" ? (
                <div>
                  <button className="btn btn-sm" style={{ background: f.options.color ?? "var(--chip)" }} disabled={client.buttonBusy.has(`${f.id}:${rowId}`)} onClick={() => runButtonField(client, f, rowId)}>
                    {client.buttonBusy.has(`${f.id}:${rowId}`) ? "Running..." : f.options.label || "Run"}
                  </button>
                </div>
              ) : (
                <FieldValueEditor ... unchanged ... />
              )}
```

`src/web/base/FieldDialog.tsx`, in `TypeOptions`, a new case:

```tsx
    case "button": {
      const choices = (client.schema.buttons ?? []).filter(b => b.tableId === tableId);
      return (
        <>
          <input className="input" value={opts.label ?? ""} placeholder="Button label, such as Approve" maxLength={40} onChange={e => set({ label: e.target.value })} aria-label="Button label" />
          <div className="row" role="radiogroup" aria-label="Button color">
            {COLORS.map(c => (
              <button key={c} type="button" role="radio" aria-checked={opts.color === c} aria-label={c} onClick={() => set({ color: c })} style={{ width: 22, height: 22, borderRadius: 6, background: c, border: opts.color === c ? "2px solid var(--accent)" : "1px solid var(--line-2)", cursor: "pointer" }} />
            ))}
          </div>
          <select className="input" value={opts.automationId ?? ""} onChange={e => set({ automationId: e.target.value || undefined })} aria-label="Automation">
            <option value="">Choose an automation</option>
            {choices.map(b => <option key={b.id} value={b.id}>{b.name}{b.enabled ? "" : " (off)"}</option>)}
          </select>
          {!choices.length && <p className="muted small">Create an automation with the trigger "When a button is clicked" for this table first.</p>}
        </>
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project worker test/worker/button-field.test.ts && npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS (1 test); typecheck clean (every `Record<FieldType, ...>` now has `button`); build ok.

- [ ] **Step 5: Checkpoint**

Run: `npm test 2>&1 | tail -5`
Expected: whole suite passes. Record in the ledger: `Task 14: button-field.test.ts 1/1, suite <N>/<N>`.

---

### Task 15: Workspace email settings page

**Files:**
- Modify: `src/web/pages/Settings.tsx` (tab "Email sending" with `MailSettings`)

**Interfaces:**
- Consumes: `GET`/`PUT /api/workspaces/:ws/mail`, `POST /api/workspaces/:ws/mail/test` (Task 9); `api` from `src/web/api.ts`.
- Produces: settings tab `email` at `/settings/email?ws=<id>`.

- [ ] **Step 1: Add the tab**

`src/web/pages/Settings.tsx`:
- `type Tab = "account" | "tokens" | "members" | "email" | "billing";`
- `TABS` gains `{ id: "email", label: "Email sending", icon: "email" }` before billing.
- `hrefFor` and the workspace selector treat `email` like `members` and `billing` (replace `(t === "members" || t === "billing")` with `["members", "email", "billing"].includes(t)`, and the same for `active`).
- Render: `{active === "email" && ws && <MailSettings key={ws.id} ws={ws} />}`.
- Import `api` from `../api`.
- New component:

```tsx
interface MailInfo {
  system: { available: boolean; from: string | null };
  secretKey: boolean;
  providers: { provider: "resend" | "smtp"; fromAddress: string; fromName: string | null; settings: { host?: string; port?: number; security?: string; username?: string }; last4: string; updatedAt: number }[];
}

function MailSettings({ ws }: { ws: WorkspaceInfo }) {
  const [info, setInfo] = useState<MailInfo | null>(null);
  const [error, setError] = useState("");
  const base = `/api/workspaces/${ws.id}/mail`;
  const load = () => get<MailInfo>(base).then(setInfo).catch(e => setError(message(e)));
  useEffect(() => {
    if (ws.role === "owner") load();
  }, [ws.id]);
  if (ws.role !== "owner") return <div className="page-note">Only workspace owners can set up email sending.</div>;
  if (error) return <ErrorLine error={error} />;
  if (!info) return <Spinner />;
  return (
    <>
      <section className="card section">
        <h2>System email</h2>
        <p className="section-desc" style={{ margin: 0 }}>
          {info.system.available ? `This server sends system email from ${info.system.from} through Cloudflare Email Service. Automations can use it without any setup.` : "This server has no system email. Set up Resend or SMTP below, or ask the person who runs the server to add Cloudflare Email Service."}
        </p>
      </section>
      {!info.secretKey && <div className="page-err">The server has no SECRET_KEY setting, so mail credentials cannot be stored. Set SECRET_KEY to a long random value and restart.</div>}
      <ProviderForm ws={ws} provider="resend" saved={info.providers.find(p => p.provider === "resend")} disabled={!info.secretKey} onChanged={load} />
      <ProviderForm ws={ws} provider="smtp" saved={info.providers.find(p => p.provider === "smtp")} disabled={!info.secretKey} onChanged={load} />
    </>
  );
}

function ProviderForm({ ws, provider, saved, disabled, onChanged }: { ws: WorkspaceInfo; provider: "resend" | "smtp"; saved?: MailInfo["providers"][number]; disabled: boolean; onChanged: () => Promise<void> }) {
  const [from, setFrom] = useState(saved?.fromAddress ?? "");
  const [fromName, setFromName] = useState(saved?.fromName ?? "");
  const [secret, setSecret] = useState("");
  const [host, setHost] = useState(saved?.settings.host ?? "");
  const [port, setPort] = useState(String(saved?.settings.port ?? 587));
  const [security, setSecurity] = useState(saved?.settings.security ?? "starttls");
  const [username, setUsername] = useState(saved?.settings.username ?? "");
  const [testTo, setTestTo] = useState("");
  const action = useAction();
  const testAction = useAction();
  const base = `/api/workspaces/${ws.id}/mail`;
  const save = (e: FormEvent) => {
    e.preventDefault();
    action.run(async () => {
      await api("PUT", base, { provider, fromAddress: from, fromName, secret: secret || undefined, settings: provider === "smtp" ? { host, port: Number(port), security, username } : undefined });
      setSecret("");
      await onChanged();
      toast(provider === "resend" ? "Resend saved" : "SMTP saved");
    });
  };
  const remove = () =>
    action.run(async () => {
      if (!confirmDialog(`Remove the ${provider === "resend" ? "Resend" : "SMTP"} settings? Email steps that use them start failing.`)) return;
      await api("PUT", base, { provider, remove: true });
      await onChanged();
    });
  const test = () =>
    testAction.run(async () => {
      const r = await post<{ to: string }>(`${base}/test`, { provider, to: testTo || undefined });
      toast(`Test email sent to ${r.to}`);
    });
  return (
    <section className="card section">
      <h2>{provider === "resend" ? "Resend" : "SMTP"}</h2>
      <p className="section-desc">
        {provider === "resend" ? "Send with your Resend account: an API key and a sender address on a domain you verified in Resend." : "Send through any mail server: your company mail, Gmail with an app password, or a mail service such as Amazon SES."}
        {saved && ` Saved ${fmtDate(saved.updatedAt)}.`}
      </p>
      <form className="stack narrow" onSubmit={save}>
        {provider === "smtp" && (
          <>
            <div className="form-row">
              <div className="grow"><label className="field-label">Host</label><input className="input" value={host} onChange={e => setHost(e.target.value)} placeholder="smtp.example.com" required /></div>
              <div style={{ width: 90 }}><label className="field-label">Port</label><input className="input" value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" required /></div>
            </div>
            <label className="field-label">Security</label>
            <select className="input" value={security} onChange={e => setSecurity(e.target.value)}>
              <option value="starttls">STARTTLS (usually port 587)</option>
              <option value="tls">TLS (usually port 465)</option>
              <option value="none">None (only for servers on your own network)</option>
            </select>
            <label className="field-label">Username</label>
            <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" />
          </>
        )}
        <label className="field-label">{provider === "resend" ? "API key" : "Password"}</label>
        <input className="input" type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={saved ? `Saved, ends in ${saved.last4}` : ""} autoComplete="new-password" />
        <label className="field-label">From address</label>
        <input className="input" type="email" value={from} onChange={e => setFrom(e.target.value)} placeholder="automations@example.com" required />
        <label className="field-label">From name</label>
        <input className="input" value={fromName} onChange={e => setFromName(e.target.value)} placeholder="Rowflare" />
        <ErrorLine error={action.error} />
        <div className="row">
          <Submit busy={action.busy} disabled={disabled}>Save</Submit>
          {saved && <button type="button" className="btn btn-danger" onClick={remove}>Remove</button>}
        </div>
      </form>
      {saved && (
        <div className="form-row" style={{ marginTop: 12 }}>
          <div className="grow narrow"><input className="input" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="Send a test email to (default: you)" aria-label="Test email address" /></div>
          <button type="button" className="btn" onClick={test} disabled={testAction.busy}>{testAction.busy && <Spinner size={14} />} Send test email</button>
        </div>
      )}
      <ErrorLine error={testAction.error} />
    </section>
  );
}
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: clean; build ok.

- [ ] **Step 3: Checkpoint**

Record in the ledger: `Task 15: typecheck clean, build ok` (the page is walked through in Task 17).

---

### Task 16: Bench and documentation

**Files:**
- Modify: `src/worker/bench.ts` (automation ops; `benchCommand` becomes async and gets the repo and engine)
- Modify: `src/worker/base-do.ts:216` (`bench` passes `{ repo: this.automations, engine: this.engine }`)
- Modify: `bench/run.mjs` (automation section)
- Modify: `README.md`, `docs/self-hosting.md`, `docs/api.md`, `docs/architecture.md`, `.dev.vars.example`

**Interfaces:**
- Consumes: `AutomationRepo`, `AutomationEngine` (Tasks 4 and 7).
- Produces: bench commands `auto_on`, `auto_off`; ops `paste_1000`, `drain_100`.

- [ ] **Step 1: Bench ops**

`src/worker/bench.ts`:
- Imports: `import type { AutomationRepo } from "./auto/repo";`, `import type { AutomationEngine } from "./auto/engine";`.
- Add:

```ts
export interface BenchAutomations {
  repo: AutomationRepo;
  engine: AutomationEngine;
}

const AUTO_NAMES = ["bench updated", "bench matches", "bench created", "bench drain"];

/** Three record triggers on Tasks (detection cost) and a button automation for timing execution. */
function autoOn(store: BaseStore, auto: BenchAutomations): number {
  const b = ids(store);
  const f = b.f;
  if (auto.repo.all().some(a => a.name === AUTO_NAMES[0])) return 0;
  const done = store.field(f.Status).options.choices!.find(c => c.name === "Done")!.id;
  const make = (name: string, config: import("../shared/automations").AutomationConfig) => auto.repo.apply(ACTOR, { op: "create", name, config, enabled: true }, Date.now());
  make(AUTO_NAMES[0], { trigger: { type: "recordUpdated", tableId: b.tasks, fieldIds: [f.Amount], conditions: { conjunction: "and", conditions: [{ fieldId: f.Score, op: "gt", value: 50 }] } }, steps: [] });
  make(AUTO_NAMES[1], { trigger: { type: "recordMatches", tableId: b.tasks, conditions: { conjunction: "and", conditions: [{ fieldId: f.Status, op: "eq", value: done }] } }, steps: [] });
  make(AUTO_NAMES[2], { trigger: { type: "recordCreated", tableId: b.tasks }, steps: [] });
  make(AUTO_NAMES[3], { trigger: { type: "button", tableId: b.tasks, viewerCanRun: false }, steps: [{ id: "s1", type: "updateRecords", target: "trigger", tableId: b.tasks, values: { [f.Score]: `{{trigger.record.${f.Priority}}}` } }] });
  return 4;
}

function autoOff(auto: BenchAutomations): number {
  let n = 0;
  for (const a of auto.repo.all().filter(a => AUTO_NAMES.includes(a.name))) {
    auto.repo.apply(ACTOR, { op: "delete", id: a.id }, Date.now());
    n++;
  }
  return n;
}
```

- `benchCommand` becomes:

```ts
export async function benchCommand(store: BaseStore, cmd: string, args: Record<string, number>, auto?: BenchAutomations): Promise<unknown> {
  switch (cmd) {
    case "seed":
      return seed(store, args.n, args.offset, args.nprojects);
    case "finalize":
      return finalize(store);
    case "stats":
      return stats(store);
    case "auto_on":
      return autoOn(store, auto!);
    case "auto_off":
      return autoOff(auto!);
    case "op": {
      let out: unknown;
      for (let i = 0; i < Math.max(1, args.reps); i++) out = await op(store, args.name as unknown as string, (args.salt ?? 0) + i, auto);
      return out;
    }
  }
  throw new Error("unknown bench command");
}
```

- `op` gets the parameter `auto?: BenchAutomations`, returns `unknown | Promise<unknown>`, and gains two cases:

```ts
    case "paste_1000": {
      // A 1,000-row paste and its removal; with record triggers on, it queues 1,000 runs.
      const res = store.createRows(ACTOR, b.tasks, Array.from({ length: 1000 }, (_, k) => ({ cells: { [f.Name]: `paste ${i} ${k}` } })));
      store.deleteRows(ACTOR, b.tasks, res.created!);
      return res.created!.length;
    }
    case "drain_100":
      return (async () => {
        // 100 button runs that each read and update their record.
        const a = auto!.repo.all().find(x => x.name === "bench drain")!;
        const t = store.table(b.tasks);
        const n = store.rowCount(b.tasks);
        const runIds: number[] = [];
        for (let k = 0; k < 100; k++) {
          const id = store.one<{ id: number }>(`SELECT id FROM ${t.phys} LIMIT 1 OFFSET ?`, (i * 100 + k) * 7919 % n)!.id;
          runIds.push(auto!.repo.enqueue(a, { type: "button", tableId: b.tasks, recordId: id, at: Date.now() }, [a.id], Date.now(), 0));
        }
        for (const id of runIds) await auto!.engine.execute(id);
        return runIds.length;
      })();
```

`src/worker/base-do.ts`: `bench` becomes `async bench(cmd: string, args: Record<string, number>): Promise<unknown>` returning `benchCommand(this.store, cmd, args, { repo: this.automations, engine: this.engine })`.

`bench/run.mjs`: add `["paste_1000", "Paste 1,000 rows and delete them"]` to `OPS` before `rollup_full`, and after the main loop (before the Markdown table):

```js
// Automations: the same edit and paste with three record triggers, and executing queued runs.
await call("auto_on");
const AUTO_OPS = [
  ["edit_cell_rollup", "Edit a cell + rollup update, 3 record triggers"],
  ["paste_1000", "Paste 1,000 rows and delete them, 3 record triggers (1,000 runs queued)"],
  ["drain_100", "Execute 100 queued runs that update their record"],
];
for (const [op, label] of AUTO_OPS) {
  const probe = await call(`time?name=${op}&reps=1&trials=3`);
  const est = Math.max(1, median(probe.op_ms) - median(probe.noop_ms));
  const reps = Math.max(1, Math.min(50, Math.round(1500 / est)));
  const r = await call(`time?name=${op}&reps=${reps}&trials=7&salt=2000`);
  const perOp = (median(r.op_ms) - median(r.noop_ms)) / reps;
  out.push({ op: label, ms: Math.round(perOp * 100) / 100, reps, out: JSON.stringify(r.out) });
  console.log(`${label.padEnd(56)} ${perOp.toFixed(2).padStart(9)} ms  (reps ${reps})`);
}
await call("auto_off");
```

- [ ] **Step 2: Run the bench**

Run (background): `npm run dev`; then `BENCH_TOKEN=local-bench-token node bench/run.mjs http://127.0.0.1:8787 50000 2>&1 | tee <scratchpad>/bench-auto.txt`
Expected: every op prints a number. Success criterion: "Edit a cell + rollup update, 3 record triggers" is at most 5 ms above "Edit a cell + rollup update". If not, profile `detectTriggers` (the two `matchRows` calls) before going on.

- [ ] **Step 3: Documentation**

- `README.md`: a feature bullet "Automations: run steps when records are created, change or start to match conditions, on a schedule, when a date is reached, when an app calls a webhook, or when someone clicks a button. Steps create, update and find records, send HTTP requests and email (Cloudflare Email Service, Resend or SMTP), with an if/otherwise branch, a run log, retries and loop protection." Keep the "Not in scope" line as it is (AI features change in part 5).
- `docs/self-hosting.md`, settings table: `SECRET_KEY` (needed to store Resend and SMTP credentials; any long random string; changing it makes saved credentials unreadable), `EMAIL_FROM` and the `send_email` binding (a `wrangler.jsonc` snippet `"send_email": [{ "name": "EMAIL" }]`, the sender domain must be onboarded to Cloudflare Email Service, Workers Paid plan, Beta), `AUTOMATION_MONTHLY_RUNS` (default 10000, 0 for no limit), `AUTOMATION_ALLOW_PRIVATE` (lets HTTP steps reach private addresses; for servers on a private network). In the Docker section: system email is not available; Resend and SMTP work; pass `SECRET_KEY` with `-e`.
- `docs/api.md`: a section "Automations" with `GET`/`POST /api/bases/:base/automations` (ops), `GET .../automations/:id/runs`, `POST .../automations/:id/test`, `POST .../automations/:id/run`, `POST /api/bases/:base/runs/:runId/retry`, and "Webhooks": `POST /api/hooks/:baseId/:token`, JSON or form body up to 256 KB, `202 { runId }`, 60 calls per minute per base, 404 for unknown or switched off automations, with a curl example.
- `docs/architecture.md`: a section "Automations" (definitions and runs in the base's SQLite, detection in the write transaction, one alarm for jobs and automations, retries resume at the failed step, chain depth 5, outbound safety) and the three new rows in the performance table from Step 2, labeled local.
- `.dev.vars.example`: add `SECRET_KEY=local-secret-key-change-me` and `AUTOMATION_ALLOW_PRIVATE=true` with a comment that the second lets local tests post to a receiver on 127.0.0.1.

- [ ] **Step 4: Checkpoint**

Run: `npm test 2>&1 | tail -5 && npm run typecheck`
Expected: green. Record in the ledger: `Task 16: bench numbers <copy the three automation rows and the edit row>, docs updated, suite <N>/<N>`.

---

### Task 17: Verification record and UI checks

**Files:**
- Modify: `scripts/verify.mjs` (automations mapping and title)
- Create: `docs/verification/automations.md`
- Create: `docs/verification/img/automations-*.png`
- Modify: `docs/verification/results.json` (automations bench and scenarios)
- Modify: `docs/verification/README.md` (link the new record)

**Interfaces:**
- Consumes: everything above.
- Produces: the automations verification record.

- [ ] **Step 1: Map tests to the feature**

`scripts/verify.mjs`: add `automations: "Automations"` to `TITLES`, and as the first entry of `FEATURES`:

```js
  { feature: "automations", match: t => /(automations|automation-[a-z]+|mcp-automations|button-field|template|schedule|http|mail|flow)\.test\.ts$/.test(t.file) },
```

Run: `npm run verify -- --list 2>&1 | grep -A3 "## automations"`
Expected: the automation test files are listed under automations, and the dashboards, views and mcp counts are unchanged from the last record (57, 39, 31 plus the 4 new tool names in `mcp.test.ts`, which stay under mcp).

- [ ] **Step 2: Local helpers for the UI checks**

In the scratchpad, write two small Node servers (they are test tools, not part of the repo):
- `receiver.mjs`: an HTTP server on 127.0.0.1:9911 that logs each request (time, method, path, body) as one JSON line to `receiver.log` and answers 200, or 503 when the path starts with `/fail`.
- `smtp-sink.mjs`: a plain SMTP server on 127.0.0.1:2525 (no TLS, accepts any AUTH) that writes each received message to `mail-<n>.eml`.

Start `npm run dev` with `.dev.vars` containing `SECRET_KEY` and `AUTOMATION_ALLOW_PRIVATE=true`.

- [ ] **Step 3: Walk the scenarios with Playwright (1440x900 unless noted)**

Use a fresh base from the CRM template ("Automations QA"). For each scenario, record what was checked and take the screenshot named in brackets into `docs/verification/img/`.

1. Record trigger to HTTP: automation "Won deals" (When a record matches conditions, Deals, Stage is Won) with an HTTP POST to `http://127.0.0.1:9911/won` and body `{"deal": "{{trigger.record.Name}}", "amount": {{trigger.record.Amount}}}`. Switch it on, set a deal's Stage to Won in the grid, and check `receiver.log` has the deal's name and amount, and the run log shows "Succeeded" with the step input and output. Repeat 5 times on different deals and record the time from the cell edit (Playwright timestamp) to the receiver's timestamp; the median must be under 2 s. [automations-editor.png, automations-runs.png]
2. Schedule: an automation every day at the next full minute in the browser's zone that creates a record in Companies named `Scheduled {{now}}`; wait for the minute and check the record appears. [automations-schedule.png]
3. Webhook: an automation that creates a deal from `{{trigger.body.name}}`; call the copied URL with curl (JSON and form bodies), check two new deals and the 202 answers; call with a wrong token and check 404. [automations-webhook.png]
4. Button: a button automation that sets Stage to Won on the trigger record; add a Button field "Approve" to Deals bound to it; click the button in the grid, check the cell shows "Running..." and then the deal's Stage is Won. Sign in as a viewer: the button answers "You cannot run this automation" until "Read-only members can run it" is on, then works. [automations-button.png]
5. Test run: on scenario 1's automation, Test run with a chosen deal; the step card turns green and the panel shows the input and output; the month's run count does not change. [automations-test-run.png]
6. Failure and run again: point the HTTP step at `/fail`; set a deal to Won; the run shows "Waiting to retry" and, after the retries (10 s, 1 min, 5 min), "Failed"; point it back at `/won` and click "Run again from the failed step"; check it succeeds and the receiver got one more request. [automations-retry.png]
7. Email over SMTP: in Settings, Email sending, save SMTP `127.0.0.1:2525`, security None, and send a test email; then add an email step to scenario 1 (HTML, body with the deal name) and check `mail-*.eml` has the subject, the escaped name and the right recipients. [automations-email-settings.png]
8. Branch: an If/otherwise step on Amount > 50000 that posts to `/big` or `/small`; check both paths with two deals. [automations-branch.png]
9. Loop protection: an automation "Touch" (When a record is updated, Deals) that updates the trigger record's Name to `{{trigger.record.Name}}!`; edit a deal once and check exactly one run and one "!" added.
10. Phone width (390x844): the list and a read-only flow in one column, no editing controls. [automations-phone.png]
11. Docker runtime parity: `npm run build:docker && SECRET_KEY=... AUTOMATION_ALLOW_PRIVATE=true PORT=8790 node docker/server.mjs`; sign up, create a CRM base, add scenario 3's webhook automation and scenario 1's HTTP step through the API, and check the same results through curl and `receiver.log`.

Restore any demo data you changed for screenshots.

- [ ] **Step 4: Write the record**

`docs/verification/automations.md`, in the same layout as `dashboards.md`: date and spec link; "What was tested" (triggers, steps, templates, run log, retries, loop protection, quotas, webhooks, buttons, email providers, MCP tools, safety: private addresses, masked headers, escaped HTML, server-side webhook tokens, viewers never see definitions); "How" (unit, worker integration with real Durable Objects, UI with Playwright, bench, the Docker runtime check); "Results" (test counts from `npm run verify`, the bench rows from Task 16 labeled local with machine and Node version, the edit-to-request median from scenario 1); "UI scenarios" (the 11 above with what was checked and their screenshots); "Known limits" (indirect changes from other tables do not fire record triggers; host names that resolve to private addresses are not checked; redirects are not followed; header secrets are stored in plain text and visible to editors; webhook rate limits count per object instance; system email exists only on Cloudflare; a date moved into the past does not fire; button runs answer only after the run, up to 30 s).

`docs/verification/results.json`: run `npm run verify` (writes the automations `tests` entry), then add the `bench` rows and `scenarios` (name, result, image) to the automations entry by hand, as for dashboards.

`docs/verification/README.md`: add the automations record to the list.

- [ ] **Step 5: Final checks**

Run: `npm run verify && npm run typecheck && npm run build 2>&1 | tail -3`
Expected: every feature passes; typecheck clean; build ok. Record in the ledger: `Task 17: verify <counts per feature>, 11 scenarios ok, screenshots saved`.
