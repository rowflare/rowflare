# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Rowflare bases to MCP clients at `/mcp` with personal-access-token auth and 16 tools covering reads, record writes, schema changes and grouped aggregation.

**Architecture:** A stateless Streamable HTTP endpoint on the existing Worker. Each POST builds a fresh `McpServer` whose tools close over the authenticated Hono context and call the Base Durable Object through the existing `baseAccess` + RPC path. Record shaping and name resolution move out of `api-v1.ts` into a shared `records.ts`; aggregation runs inside the Durable Object in a new `aggregate.ts`.

**Tech Stack:** Cloudflare Workers, Hono 4, Durable Objects (SQLite), `@modelcontextprotocol/sdk` 1.32.1, `zod` 4, `@cfworker/json-schema`, Vitest with `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-10-13-mcp-server-design.md`

## Global Constraints

- No git operations of any kind (user rule). Where a plan normally commits, run the checkpoint commands instead.
- No Chinese in code or comments. No em dash characters anywhere.
- Code style: match the surrounding files (2-space indent, double quotes, semicolons, terse comments only where the code is not obvious, long lines are fine).
- Pin dependencies exactly: `@modelcontextprotocol/sdk@1.32.1`, `zod@4.6.4`, `@cfworker/json-schema@4.1.1`.
- The SDK must be given `CfWorkerJsonSchemaValidator`; the default Ajv validator uses `new Function`, which workerd forbids.
- REST API behavior (`/api/v1`) must not change; `test/worker/api.test.ts` must pass unmodified.
- Limits from the spec: `query_records` limit default 50, max 200; `get_records` 1 to 100 ids; writes 1 to 200 records; aggregate 0 to 2 group fields, 1 to 10 metrics, at most 1,000 groups; long text truncated at 2,000 characters.
- Tool results: `structuredContent` must be an object, plus the same JSON as one text block. `list_bases` therefore returns `{ bases: [...] }`.
- `/mcp` accepts only Bearer personal access tokens. 401 responses carry `WWW-Authenticate: Bearer realm="rowflare"`.

## Review Focus

1. A select filter or select cell written with an option name in different letter case (`"won"` for `Won`) should resolve to the option, not fail. Pinned in Task 4 (`resolves option names case-insensitively`).
2. `update_field` that sends the full choice list for a select field must keep the existing choice ids, so cells holding those options are not wiped by the convert job. Pinned in Task 6 (`update_field keeps existing select values`).
3. Using `view` and `filter` together must narrow the view's own filter, not replace it. Pinned in Task 2 (`extraFilters narrows a view filter`) and Task 4.
4. `aggregate` on a table with zero matching rows and no grouping should return one group with zero counts, not an empty list. Pinned in Task 2 (`returns one zero group for no rows`).
5. A viewer token calling a schema tool must get a readable permission error as a tool result, not an HTTP error that breaks the client session. Pinned in Task 6 (`viewer cannot change schema`).

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/worker/records.ts` | create | Shared record shaping and name resolution: `tableOf`, `fieldsOf`, `resolveField`, `fieldOf`, `outValue`, `toRecord`, `inCells`, `unwrap`, `loadTable`, `filterIdsByFormula` |
| `src/worker/api-v1.ts` | modify | Import the helpers from `records.ts`; no behavior change |
| `src/worker/base/aggregate.ts` | create | Pure aggregation: input types, validation, group keys, date buckets, `Aggregator` |
| `src/worker/base/store.ts` | modify | `QueryInput.extraFilters`, `BaseStore.aggregate` |
| `src/worker/base-do.ts` | modify | `BaseDO.aggregate` RPC |
| `src/worker/access.ts` | modify | Add `"aggregate"` to `BaseStub` |
| `src/worker/mcp/server.ts` | create | `/mcp` Hono routes, auth, server construction |
| `src/worker/mcp/result.ts` | create | `ok`, `fail`, `guard`, `truncateRecord` |
| `src/worker/mcp/describe.ts` | create | Schema to friendly JSON (`describeTable`, `describeField`, `describeView`) |
| `src/worker/mcp/translate.ts` | create | Friendly input to internal: filters, sorts, views, choice and user resolution, field specs |
| `src/worker/mcp/schemas.ts` | create | Shared zod shapes for tool inputs |
| `src/worker/mcp/tools-read.ts` | create | `list_bases`, `describe_base`, `query_records`, `get_records`, `aggregate` |
| `src/worker/mcp/tools-write.ts` | create | `create_records`, `update_records`, `delete_records` |
| `src/worker/mcp/tools-schema.ts` | create | `create_table`, `update_table`, `delete_table`, `create_field`, `update_field`, `delete_field`, `create_view`, `update_view` |
| `src/worker/index.ts` | modify | Mount `mcpRoutes` at `/mcp` |
| `wrangler.jsonc` | modify | `run_worker_first` gains `/mcp` |
| `test/worker/helpers.ts` | create | HTTP client, signup, token, viewer and MCP client helpers for new tests |
| `test/worker/mcp.test.ts` | create | MCP integration tests |
| `test/worker/engine.test.ts` | modify | Aggregate engine tests |
| `docs/mcp.md`, `README.md`, `docs/architecture.md` | create / modify | Docs |

Two files beyond the spec's list (`describe.ts`, `schemas.ts`) keep `translate.ts` and the tool files small; they change nothing in the design.

---

### Task 1: Extract shared record helpers from the REST API

**Files:**
- Create: `src/worker/records.ts`
- Modify: `src/worker/api-v1.ts` (whole file: remove moved helpers, import them)
- Test: `test/worker/api.test.ts` (unchanged, must keep passing)

**Interfaces:**
- Consumes: `baseAccess`, `workspaceMembers`, `HttpError`, `BaseAccess`, `BaseStub`, `AppContext` from `src/worker/access.ts`.
- Produces (all exported from `src/worker/records.ts`):
  - `tableOf(schema: Schema, idOrName: string): Table` (throws `HttpError(404)`)
  - `fieldsOf(schema: Schema, tableId: string): Field[]`
  - `resolveField(fields: Field[], key: string): Field | undefined`
  - `fieldOf(fields: Field[], key: string, tableName: string): Field` (throws `HttpError(422, 'Unknown field "<key>" in table <T>. Fields: a, b')`)
  - `outValue(f: Field, row: Row, members: Map<string, Member>, origin: string): unknown`
  - `toRecord(row: Row, fields: Field[], members: Map<string, Member>, origin: string, byId: boolean, only?: Set<string>): ApiRecord`
  - `interface ApiRecord { id: number; createdTime: string; fields: Record<string, unknown> }`
  - `inCells(fields: Field[], input: Record<string, unknown> | undefined, replace?: boolean): Record<string, unknown>`
  - `unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T` (throws `HttpError(422)`)
  - `interface TableCtx { a: BaseAccess; schema: Schema; table: Table; fields: Field[]; members: Map<string, Member>; origin: string }`
  - `loadTable(c: AppContext, baseId: string, tableKey: string, need: "read" | "write"): Promise<TableCtx>`
  - `filterIdsByFormula(t: TableCtx, ids: number[], formula: string): Promise<number[]>` (throws `HttpError(422, "Invalid filterByFormula: ...")`)

- [ ] **Step 1: Run the existing API tests to record the baseline**

Run: `npx vitest run --project worker test/worker/api.test.ts`
Expected: all tests PASS. If any fail before you change anything, stop and report.

- [ ] **Step 2: Create `src/worker/records.ts`**

```ts
// Record shape and name resolution shared by the REST API and the MCP server.
import type { Attachment, Field, LinkValue, Member, Row, Schema, Table } from "../shared/types";
import { COMPUTED_TYPES } from "../shared/types";
import { compileFormula, evaluate, FormulaError, truthy } from "../shared/formula";
import { formulaValue } from "../shared/cells";
import { baseAccess, HttpError, workspaceMembers, type AppContext, type BaseAccess } from "./access";

export interface ApiRecord {
  id: number;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface TableCtx {
  a: BaseAccess;
  schema: Schema;
  table: Table;
  fields: Field[];
  members: Map<string, Member>;
  origin: string;
}

export function tableOf(schema: Schema, idOrName: string): Table {
  const decoded = decodeURIComponent(idOrName);
  const t = schema.tables.find(t => t.id === decoded) ?? schema.tables.find(t => t.name === decoded) ?? schema.tables.find(t => t.name.toLowerCase() === decoded.toLowerCase());
  if (!t) throw new HttpError(404, `Table ${decoded} not found`);
  return t;
}

export function fieldsOf(schema: Schema, tableId: string): Field[] {
  return schema.fields.filter(f => f.tableId === tableId);
}

export function resolveField(fields: Field[], key: string): Field | undefined {
  return fields.find(f => f.id === key) ?? fields.find(f => f.name === key) ?? fields.find(f => f.name.toLowerCase() === key.toLowerCase());
}

/** Like resolveField, but fails with the list of valid names so a caller (or a model) can correct itself. */
export function fieldOf(fields: Field[], key: string, tableName: string): Field {
  const f = resolveField(fields, key);
  if (!f) throw new HttpError(422, `Unknown field "${key}" in table ${tableName}. Fields: ${fields.map(f => f.name).join(", ")}`);
  return f;
}

export function outValue(f: Field, row: Row, members: Map<string, Member>, origin: string): unknown {
  // Body copied verbatim from api-v1.ts outValue.
}

export function toRecord(row: Row, fields: Field[], members: Map<string, Member>, origin: string, byId: boolean, only?: Set<string>): ApiRecord {
  // Body copied verbatim from api-v1.ts toRecord.
}

export function inCells(fields: Field[], input: Record<string, unknown> | undefined, replace = false): Record<string, unknown> {
  // Body copied verbatim from api-v1.ts inCells.
}

export function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new HttpError(422, r.error);
  return r.value;
}

export async function loadTable(c: AppContext, baseId: string, tableKey: string, need: "read" | "write"): Promise<TableCtx> {
  const a = await baseAccess(c, baseId, need);
  const schema = await a.stub.schema();
  const table = tableOf(schema, tableKey);
  const fields = fieldsOf(schema, table.id);
  const members = new Map((await workspaceMembers(c.env, a.base.workspace_id)).map(m => [m.id, m]));
  return { a, schema, table, fields, members, origin: new URL(c.req.url).origin };
}

/** Evaluates an Airtable formula per row (in the Worker) and keeps the ids where it is truthy, preserving order. */
export async function filterIdsByFormula(t: TableCtx, ids: number[], formula: string): Promise<number[]> {
  let compiled;
  try {
    compiled = compileFormula(formula, t.fields.map(f => ({ id: f.id, name: f.name })));
  } catch (e) {
    throw new HttpError(422, e instanceof FormulaError ? `Invalid filterByFormula: ${e.message}` : "Invalid filterByFormula");
  }
  const keep: number[] = [];
  const fmap = new Map(t.fields.map(f => [f.id, f]));
  const userName = (id: string) => t.members.get(id)?.name ?? id;
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = unwrap(await t.a.stub.rows(t.table.id, ids.slice(i, i + 1000)));
    for (const r of rows) {
      const v = evaluate(compiled.ast, {
        get: fid => {
          const f = fmap.get(fid);
          if (!f) return null;
          const raw = f.type === "createdTime" ? r.createdAt : f.type === "modifiedTime" ? r.updatedAt : f.type === "autonumber" ? r.id : r.cells[f.id];
          return formulaValue(f, raw, { userName });
        },
        recordId: r.id,
        createdTime: new Date(r.createdAt).toISOString(),
        modifiedTime: new Date(r.updatedAt).toISOString(),
        now: new Date(),
      });
      if (truthy(v) && v !== "#ERROR!") keep.push(r.id);
    }
  }
  return keep;
}
```

Replace each "Body copied verbatim" comment with the exact body of the same-named function in the current `src/worker/api-v1.ts` (lines 31 to 76). Do not alter logic. The unused-import check in Step 4 will flag anything missed (`Attachment`, `LinkValue`, `COMPUTED_TYPES` are used by those bodies).

- [ ] **Step 3: Rewrite the top of `src/worker/api-v1.ts` to use the shared helpers**

Delete the local `tableOf`, `fieldsOf`, `resolveField`, `outValue`, `toRecord`, `inCells`, `unwrap` and `ctx` definitions and the formula loop inside `GET /:base/:table`. Replace the imports and `ctx` with:

```ts
import { Hono } from "hono";
import type { Env } from "./env";
import type { SortSpec } from "../shared/types";
import { HttpError, type AppContext, type Vars } from "./access";
import { filterIdsByFormula, inCells, loadTable, resolveField, toRecord, unwrap } from "./records";

export const apiV1 = new Hono<{ Bindings: Env; Variables: Vars }>();

const MAX_PAGE = 100;

async function ctx(c: AppContext, write: boolean) {
  const t = await loadTable(c, c.req.param("base")!, c.req.param("table")!, write ? "write" : "read");
  return { ...t, byId: c.req.query("returnFieldsByFieldId") === "true" };
}
```

`GET /bases` and `GET /bases/:base/tables` still use `baseAccess` and `fieldsOf`; import `baseAccess` from `./access` and `fieldsOf` from `./records` for them. In `GET /:base/:table` replace the whole `if (formula) { ... }` block with:

```ts
  const formula = c.req.query("filterByFormula");
  if (formula) ids = await filterIdsByFormula(x, ids, formula);
```

Every other use of `x.a`, `x.schema`, `x.table`, `x.fields`, `x.members`, `x.origin`, `x.byId` keeps working because `ctx` returns the same property names.

- [ ] **Step 4: Typecheck and run the API tests**

Run: `npm run typecheck && npx vitest run --project worker test/worker/api.test.ts`
Expected: no type errors; all API tests PASS (same count as Step 1).

- [ ] **Step 5: Checkpoint (no git)**

Run: `npm test`
Expected: all unit and worker tests PASS.

---

### Task 2: Aggregation engine in the Durable Object

**Files:**
- Create: `src/worker/base/aggregate.ts`
- Modify: `src/worker/base/store.ts` (`QueryInput` at lines 38-47, `query` at lines 342-373, new `aggregate` method after `query`, imports at top)
- Modify: `src/worker/base-do.ts` (new `aggregate` read method next to `query`)
- Modify: `src/worker/access.ts` (`BaseStub` key union)
- Test: `test/worker/engine.test.ts`

**Interfaces:**
- Consumes: `filterSql` (already used by `query`), `BaseStore.rawFromRow`, `BaseStore.getRows`, `BaseStore.fieldMap`, the private `userName` arrow in `BaseStore`.
- Produces:
  - In `src/worker/base/aggregate.ts`: `type AggFn = "count" | "countUnique" | "countEmpty" | "countFilled" | "sum" | "avg" | "min" | "max"`, `type DateBucket = "day" | "week" | "month" | "year"`, `interface AggMetric { fn: AggFn; fieldId?: string; as: string }`, `interface AggGroupBy { fieldId: string; bucket?: DateBucket }`, `interface AggregateInput { viewId?: string; filters?: FilterSpec; groupBy?: AggGroupBy[]; metrics: AggMetric[] }`, `type GroupKey = string | boolean | null`, `interface AggregateGroup { key: GroupKey[]; values: Record<string, number | string | null> }`, `interface AggregateResult { groups: AggregateGroup[]; total: number; truncated?: boolean }`, constants `MAX_GROUPS = 1000`, `MAX_GROUP_BY = 2`, `MAX_METRICS = 10`, functions `validateAggregate`, `groupKeys`, `bucketDate`, class `Aggregator`.
  - `QueryInput.extraFilters?: FilterSpec`: ANDed with the effective filters (explicit or the view's).
  - `BaseStore.aggregate(tableId: string, input: AggregateInput): AggregateResult` (throws `UserError`).
  - `BaseDO.aggregate(tableId: string, input: AggregateInput): Result<AggregateResult>`; `BaseStub` includes `aggregate`.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("base store", ...)` block of `test/worker/engine.test.ts` (it already has `actor`, `withStore` and `setupProjects`):

```ts
  function seedAggregate(s: BaseStore) {
    const p = setupProjects(s);
    const hours = p.f(p.tasks, "Hours");
    const status = p.f(p.tasks, "Status");
    const tname = p.f(p.tasks, "Name");
    const tags = s.createField(p.tasks, { name: "Tags", type: "multiSelect", options: { choices: [{ id: "selA0000000", name: "A", color: "#eee" }, { id: "selB0000000", name: "B", color: "#eee" }] } }).fieldId;
    const due = s.createField(p.tasks, { name: "Due", type: "date" }).fieldId;
    const double = s.createField(p.tasks, { name: "Double", type: "formula", options: { formula: "{Hours} * 2" } }).fieldId;
    s.createRows(actor, p.tasks, [
      { cells: { [tname]: "t1", [hours]: 3, [status]: "selTodo00000", [p.link]: [p.apollo], [tags]: ["selA0000000", "selB0000000"], [due]: "2026-01-05" } },
      { cells: { [tname]: "t2", [hours]: 5, [status]: "selDone00000", [p.link]: [p.apollo], [tags]: ["selA0000000"], [due]: "2026-01-20" } },
      { cells: { [tname]: "t3", [hours]: 2, [status]: "selDone00000", [p.link]: [p.gemini], [due]: "2026-02-01" } },
      { cells: { [tname]: "t4" } },
    ]);
    return { ...p, hours, status, tname, tags, due, double };
  }

  it("aggregates without grouping", async () => {
    await withStore("agg-total", s => {
      const p = seedAggregate(s);
      const r = s.aggregate(p.tasks, { metrics: [{ fn: "count", as: "n" }, { fn: "sum", fieldId: p.hours, as: "hours" }, { fn: "avg", fieldId: p.hours, as: "avg" }, { fn: "sum", fieldId: p.double, as: "double" }, { fn: "countUnique", fieldId: p.status, as: "statuses" }, { fn: "countEmpty", fieldId: p.status, as: "noStatus" }] });
      expect(r.total).toBe(4);
      expect(r.groups).toEqual([{ key: [], values: { n: 4, hours: 10, avg: 10 / 3, double: 20, statuses: 2, noStatus: 1 } }]);
    });
  });

  it("returns one zero group for no rows", async () => {
    await withStore("agg-empty", s => {
      const p = seedAggregate(s);
      const r = s.aggregate(p.tasks, { filters: { conjunction: "and", conditions: [{ fieldId: p.tname, op: "eq", value: "nope" }] }, metrics: [{ fn: "count", as: "n" }, { fn: "avg", fieldId: p.hours, as: "avg" }] });
      expect(r).toEqual({ groups: [{ key: [], values: { n: 0, avg: null } }], total: 0 });
    });
  });

  it("groups by select, multi select fan-out and links", async () => {
    await withStore("agg-groups", s => {
      const p = seedAggregate(s);
      const count = [{ fn: "count" as const, as: "n" }, { fn: "sum" as const, fieldId: p.hours, as: "h" }];
      expect(s.aggregate(p.tasks, { groupBy: [{ fieldId: p.status }], metrics: count }).groups).toEqual([
        { key: ["Done"], values: { n: 2, h: 7 } },
        { key: ["Todo"], values: { n: 1, h: 3 } },
        { key: [null], values: { n: 1, h: 0 } },
      ]);
      expect(s.aggregate(p.tasks, { groupBy: [{ fieldId: p.tags }], metrics: [{ fn: "count", as: "n" }] }).groups.map(g => [g.key[0], g.values.n])).toEqual([["A", 2], [null, 2], ["B", 1]]);
      expect(s.aggregate(p.tasks, { groupBy: [{ fieldId: p.link }], metrics: [{ fn: "count", as: "n" }] }).groups.map(g => [g.key[0], g.values.n])).toEqual([["Apollo", 2], ["Gemini", 1], [null, 1]]);
      const two = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.status }, { fieldId: p.tags }], metrics: [{ fn: "count", as: "n" }] });
      expect(two.groups).toHaveLength(5);
      expect(two.total).toBe(4);
    });
  });

  it("buckets dates and takes date min and max", async () => {
    await withStore("agg-dates", s => {
      const p = seedAggregate(s);
      const months = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.due, bucket: "month" }], metrics: [{ fn: "count", as: "n" }] });
      expect(months.groups.map(g => [g.key[0], g.values.n])).toEqual([["2026-01", 2], [null, 1], ["2026-02", 1]]);
      const weeks = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.due, bucket: "week" }], metrics: [{ fn: "count", as: "n" }] });
      expect(weeks.groups.map(g => g.key[0])).toContain("2026-01-05");
      expect(weeks.groups.map(g => g.key[0])).toContain("2026-01-19");
      const range = s.aggregate(p.tasks, { metrics: [{ fn: "min", fieldId: p.due, as: "first" }, { fn: "max", fieldId: p.due, as: "last" }] });
      expect(range.groups[0].values).toEqual({ first: "2026-01-05", last: "2026-02-01" });
    });
  });

  it("aggregates a rollup and applies filters", async () => {
    await withStore("agg-rollup", s => {
      const p = seedAggregate(s);
      const total = s.createField(p.projects, { name: "Total", type: "rollup", options: { linkFieldId: p.inverse, targetFieldId: p.hours, fn: "sum" } }).fieldId;
      expect(s.aggregate(p.projects, { metrics: [{ fn: "sum", fieldId: total, as: "t" }] }).groups[0].values.t).toBe(10);
      const done = s.aggregate(p.tasks, { filters: { conjunction: "and", conditions: [{ fieldId: p.status, op: "eq", value: "selDone00000" }] }, metrics: [{ fn: "count", as: "n" }] });
      expect(done.total).toBe(2);
    });
  });

  it("extraFilters narrows a view filter", async () => {
    await withStore("agg-view", s => {
      const p = seedAggregate(s);
      const viewId = s.createView(p.tasks, { name: "Done", type: "grid", config: { filters: { conjunction: "and", conditions: [{ fieldId: p.status, op: "eq", value: "selDone00000" }] } } }).viewId;
      const q = s.query(p.tasks, { viewId, extraFilters: { conjunction: "and", conditions: [{ fieldId: p.hours, op: "gt", value: 4 }] }, limit: 0 });
      expect(q.total).toBe(1);
      const r = s.aggregate(p.tasks, { viewId, filters: { conjunction: "and", conditions: [{ fieldId: p.hours, op: "gt", value: 4 }] }, metrics: [{ fn: "count", as: "n" }] });
      expect(r.total).toBe(1);
    });
  });

  it("rejects bad metrics and caps groups", async () => {
    await withStore("agg-errors", s => {
      const p = seedAggregate(s);
      expect(() => s.aggregate(p.tasks, { metrics: [{ fn: "sum", fieldId: p.tname, as: "x" }] })).toThrow(/needs a number field/);
      expect(() => s.aggregate(p.tasks, { metrics: [] })).toThrow(/1 to 10 metrics/);
      expect(() => s.aggregate(p.tasks, { groupBy: [{ fieldId: p.status }, { fieldId: p.tags }, { fieldId: p.due }], metrics: [{ fn: "count", as: "n" }] })).toThrow(/at most 2/);
      s.createRows(actor, p.tasks, Array.from({ length: 1005 }, (_, i) => ({ cells: { [p.tname]: `bulk ${i}` } })));
      const r = s.aggregate(p.tasks, { groupBy: [{ fieldId: p.tname }], metrics: [{ fn: "count", as: "n" }] });
      expect(r.groups).toHaveLength(1000);
      expect(r.truncated).toBe(true);
      expect(r.total).toBe(1009);
    });
  });
```

Why the expected orders hold: groups sort by the first metric descending, then by `JSON.stringify(key)` ascending. `'["Todo"]' < '[null]'` because `"` (34) sorts before `n` (110). 2026-01-20 is a Tuesday, so its ISO week starts 2026-01-19.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project worker test/worker/engine.test.ts -t "agg|extraFilters|rejects bad metrics|zero group"`
Expected: FAIL with a TypeScript or runtime error that `s.aggregate` is not a function and `extraFilters` is unknown.

- [ ] **Step 3: Create `src/worker/base/aggregate.ts`**

```ts
// Grouped counts and totals over one table, computed inside the Durable Object so only the result leaves it.
// Rows are folded in batches; there is no SQL GROUP BY over the row JSON (see the no-expression-index rule in store.ts).
import type { Attachment, Field, FilterSpec, LinkValue, Row } from "../../shared/types";

export type AggFn = "count" | "countUnique" | "countEmpty" | "countFilled" | "sum" | "avg" | "min" | "max";
export type DateBucket = "day" | "week" | "month" | "year";

export interface AggMetric {
  fn: AggFn;
  fieldId?: string;
  as: string;
}

export interface AggGroupBy {
  fieldId: string;
  bucket?: DateBucket;
}

export interface AggregateInput {
  viewId?: string;
  filters?: FilterSpec;
  groupBy?: AggGroupBy[];
  metrics: AggMetric[];
}

export type GroupKey = string | boolean | null;

export interface AggregateGroup {
  key: GroupKey[];
  values: Record<string, number | string | null>;
}

export interface AggregateResult {
  groups: AggregateGroup[];
  total: number;
  truncated?: boolean;
}

export const MAX_GROUPS = 1000;
export const MAX_GROUP_BY = 2;
export const MAX_METRICS = 10;

const isNumeric = (f: Field) => f.type === "number" || f.type === "autonumber" || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "number");
const isDateLike = (f: Field) => f.type === "date" || f.type === "createdTime" || f.type === "modifiedTime" || ((f.type === "formula" || f.type === "rollup") && f.options.resultType === "date");
const isBlank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Returns an error message, or null when the input is valid for these fields. */
export function validateAggregate(fields: Map<string, Field>, input: AggregateInput): string | null {
  if (!input.metrics?.length || input.metrics.length > MAX_METRICS) return `Ask for 1 to ${MAX_METRICS} metrics`;
  if ((input.groupBy?.length ?? 0) > MAX_GROUP_BY) return `Group by at most ${MAX_GROUP_BY} fields`;
  for (const g of input.groupBy ?? []) if (!fields.has(g.fieldId)) return `Unknown group field ${g.fieldId}`;
  const names = new Set<string>();
  for (const m of input.metrics) {
    if (names.has(m.as)) return `Duplicate metric name "${m.as}"`;
    names.add(m.as);
    if (m.fn === "count") continue;
    const f = m.fieldId ? fields.get(m.fieldId) : undefined;
    if (!f) return `Metric ${m.fn} needs a field`;
    if ((m.fn === "sum" || m.fn === "avg") && !isNumeric(f)) return `${m.fn} needs a number field; "${f.name}" is ${f.type}`;
    if ((m.fn === "min" || m.fn === "max") && !isNumeric(f) && !isDateLike(f)) return `${m.fn} needs a number or date field; "${f.name}" is ${f.type}`;
  }
  return null;
}

function toDateString(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
  if (typeof raw === "string" && raw) return raw;
  return null;
}

/** Day buckets are YYYY-MM-DD (UTC), weeks are the Monday that starts the ISO week, months YYYY-MM, years YYYY. */
export function bucketDate(raw: unknown, bucket: DateBucket = "day"): string | null {
  const s = toDateString(raw);
  if (!s) return null;
  const day = s.slice(0, 10);
  if (bucket === "year") return day.slice(0, 4);
  if (bucket === "month") return day.slice(0, 7);
  if (bucket === "week") {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return day;
}

const uniq = (keys: GroupKey[]): GroupKey[] => [...new Set(keys)];

/** The groups one cell belongs to. Multi-valued cells fan out: a record counts once in each of its values. */
export function groupKeys(f: Field, raw: unknown, bucket: DateBucket | undefined, userName: (id: string) => string): GroupKey[] {
  if (f.type === "checkbox") return [!!raw];
  if (isDateLike(f)) return [bucketDate(raw, bucket)];
  if (isBlank(raw)) return [null];
  const choice = (id: unknown) => f.options.choices?.find(c => c.id === id)?.name ?? null;
  switch (f.type) {
    case "singleSelect":
      return [choice(raw)];
    case "multiSelect":
      return uniq((raw as unknown[]).map(choice));
    case "user":
      return uniq((Array.isArray(raw) ? raw : [raw]).map(id => userName(String(id))));
    case "link":
      return uniq((raw as LinkValue[]).map(x => x.t ?? String(x.id)));
    case "attachment":
      return uniq((raw as Attachment[]).map(a => a.name));
  }
  if (Array.isArray(raw)) return uniq(raw.map(v => (isBlank(v) ? null : String(v))));
  return [String(raw)];
}

function product(lists: GroupKey[][]): GroupKey[][] {
  return lists.reduce<GroupKey[][]>((acc, list) => acc.flatMap(a => list.map(k => [...a, k])), [[]]);
}

interface MetricAcc {
  count: number;
  sum: number;
  min: number | string | null;
  max: number | string | null;
  seen: Set<string>;
}

const newAcc = (): MetricAcc => ({ count: 0, sum: 0, min: null, max: null, seen: new Set() });

function finish(a: MetricAcc, m: AggMetric): number | string | null {
  switch (m.fn) {
    case "count":
    case "countEmpty":
    case "countFilled":
      return a.count;
    case "countUnique":
      return a.seen.size;
    case "sum":
      return a.sum;
    case "avg":
      return a.count ? a.sum / a.count : null;
    case "min":
      return a.min;
    case "max":
      return a.max;
  }
}

function desc(a: number | string | null | undefined, b: number | string | null | undefined): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? 1 : -1;
}

export class Aggregator {
  private groups = new Map<string, { key: GroupKey[]; m: MetricAcc[] }>();
  private total = 0;

  constructor(
    private fields: Map<string, Field>,
    private input: AggregateInput,
    private raw: (f: Field, r: Row) => unknown,
    private userName: (id: string) => string,
  ) {}

  add(rows: Row[]) {
    const groupBy = this.input.groupBy ?? [];
    for (const r of rows) {
      this.total++;
      const lists = groupBy.map(g => {
        const f = this.fields.get(g.fieldId)!;
        return groupKeys(f, this.raw(f, r), g.bucket, this.userName);
      });
      for (const key of product(lists)) {
        const k = JSON.stringify(key);
        let g = this.groups.get(k);
        if (!g) this.groups.set(k, (g = { key, m: this.input.metrics.map(newAcc) }));
        this.input.metrics.forEach((m, i) => this.addMetric(g!.m[i], m, r));
      }
    }
  }

  private addMetric(a: MetricAcc, m: AggMetric, r: Row) {
    if (m.fn === "count") {
      a.count++;
      return;
    }
    const f = this.fields.get(m.fieldId!)!;
    const v = this.raw(f, r);
    const blank = isBlank(v) || (f.type === "checkbox" && !v);
    switch (m.fn) {
      case "countEmpty":
        if (blank) a.count++;
        return;
      case "countFilled":
        if (!blank) a.count++;
        return;
      case "countUnique":
        if (!blank) a.seen.add(JSON.stringify(v));
        return;
      case "sum":
      case "avg":
        if (typeof v === "number" && Number.isFinite(v)) {
          a.sum += v;
          a.count++;
        }
        return;
      case "min":
      case "max": {
        const x = isDateLike(f) ? toDateString(v) : typeof v === "number" && Number.isFinite(v) ? v : null;
        if (x === null) return;
        if (a.min === null || x < a.min) a.min = x;
        if (a.max === null || x > a.max) a.max = x;
        return;
      }
    }
  }

  result(): AggregateResult {
    if (!this.input.groupBy?.length && !this.groups.size) this.groups.set("[]", { key: [], m: this.input.metrics.map(newAcc) });
    const metrics = this.input.metrics;
    const list: AggregateGroup[] = [...this.groups.values()].map(g => ({ key: g.key, values: Object.fromEntries(metrics.map((m, i) => [m.as, finish(g.m[i], m)])) }));
    const first = metrics[0].as;
    list.sort((x, y) => desc(x.values[first], y.values[first]) || (JSON.stringify(x.key) < JSON.stringify(y.key) ? -1 : 1));
    const out: AggregateResult = { groups: list.slice(0, MAX_GROUPS), total: this.total };
    if (list.length > MAX_GROUPS) out.truncated = true;
    return out;
  }
}
```

- [ ] **Step 4: Add `extraFilters` and `aggregate` to `BaseStore`**

In `src/worker/base/store.ts`, add to the imports:

```ts
import { Aggregator, validateAggregate, type AggregateInput, type AggregateResult } from "./aggregate";
```

The file already imports `aggregate` from `../../shared/rollup`; keep that import unchanged (the new names do not clash).

Add to `QueryInput` after `search?: string;`:

```ts
  /** ANDed with the effective filters (explicit or the view's), so a caller can narrow a view. */
  extraFilters?: ViewConfig["filters"];
```

In `query`, directly after the line `if (f) { where.push(f.sql); params.push(...f.params); }`, add:

```ts
    const xf = filterSql(q.extraFilters, fields);
    if (xf) { where.push(xf.sql); params.push(...xf.params); }
```

Add this method directly after `query`:

```ts
  aggregate(tableId: string, input: AggregateInput): AggregateResult {
    const fields = this.fieldMap(tableId);
    const err = validateAggregate(fields, input);
    if (err) throw new UserError(err);
    const ids = this.query(tableId, { viewId: input.viewId, extraFilters: input.filters, limit: 0 }).ids;
    const agg = new Aggregator(fields, input, (f, r) => this.rawFromRow(f, r), this.userName);
    for (let i = 0; i < ids.length; i += 1000) agg.add(this.getRows(tableId, ids.slice(i, i + 1000)));
    return agg.result();
  }
```

`userName` is declared as a private arrow property further down the class (line 298); class property initializers run before any method call, so referencing it here is fine.

- [ ] **Step 5: Expose it over RPC**

In `src/worker/base-do.ts`, add to the store import: `type AggregateInput` is in a different module, so add a new import line:

```ts
import type { AggregateInput, AggregateResult } from "./base/aggregate";
```

Add after the `rows(...)` method in the `// ---------- reads ----------` section:

```ts
  aggregate(tableId: string, input: AggregateInput): Result<AggregateResult> {
    return this.safe(() => this.store.aggregate(tableId, input));
  }
```

In `src/worker/access.ts`, add `"aggregate"` to the key union in `BaseStub`:

```ts
  [K in "init" | "destroy" | "setMembers" | "schema" | "query" | "rows" | "aggregate" | "exportCsv" | "findTable" | "rowOp" | "schemaOp" | "startAirtableImport"]: ...
```

(Only the union literal changes; keep the rest of the mapped type as it is.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run --project worker test/worker/engine.test.ts`
Expected: no type errors; all engine tests PASS, including the 7 new ones.

- [ ] **Step 7: Checkpoint (no git)**

Run: `npm test`
Expected: all tests PASS.

---

### Task 3: `/mcp` endpoint, auth, `list_bases` and `describe_base`

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)
- Modify: `wrangler.jsonc` (`assets.run_worker_first`)
- Create: `src/worker/mcp/server.ts`, `src/worker/mcp/result.ts`, `src/worker/mcp/describe.ts`, `src/worker/mcp/tools-read.ts`
- Modify: `src/worker/index.ts` (mount route before `app.all("/api/*", ...)`)
- Create: `test/worker/helpers.ts`, `test/worker/mcp.test.ts`

**Interfaces:**
- Consumes: `authenticate` (`src/worker/auth.ts`), `ensureSchema` (`src/worker/schema.ts`), `baseAccess`, `HttpError`, `AppContext`, `Vars` (`access.ts`), `fieldsOf`, `tableOf` (`records.ts`).
- Produces:
  - `src/worker/mcp/server.ts`: `export const mcpRoutes: Hono<{ Bindings: Env; Variables: Vars }>`; internal `buildServer(c: AppContext): McpServer`.
  - `src/worker/mcp/result.ts`: `ok(data: Record<string, unknown>): CallToolResult`, `fail(message: string): CallToolResult`, `guard<A>(fn: (args: A) => Promise<Record<string, unknown>>): (args: A) => Promise<CallToolResult>`, `truncateRecord(rec: ApiRecord, max?: number): ApiRecord`, `const TEXT_LIMIT = 2000`.
  - `src/worker/mcp/describe.ts`: `describeField(schema: Schema, f: Field): FieldInfo`, `describeView(v: View): { id: string; name: string; type: ViewType }`, `describeTable(schema: Schema, t: Table): TableInfo`.
  - `src/worker/mcp/tools-read.ts`: `registerReadTools(server: McpServer, c: AppContext): void` (this task registers `list_bases` and `describe_base`; Task 4 adds the rest to the same function).
  - `test/worker/helpers.ts`: `HttpClient`, `signup(email)`, `ownerWithBase(prefix, template?)`, `addViewer(owner, wsId, email)`, `mcpClient(token)`, `call(client, name, args)`.

- [ ] **Step 1: Record the baseline bundle size, then install dependencies**

Run: `npx wrangler deploy --dry-run --outdir /private/tmp/claude-501/-Users-znjac-htdocs-Rowflare/fdd2b911-54da-46d3-a466-abf2afe3defe/scratchpad/bundle-before 2>&1 | grep -i "total upload"`
Expected: a line like `Total Upload: N KiB / gzip: M KiB`. Write the gzip number down as the baseline.

Run: `npm install --save-exact @modelcontextprotocol/sdk@1.32.1 zod@4.6.4 @cfworker/json-schema@4.1.1`
Expected: three entries added to `dependencies` in `package.json` with exact versions.

If npm prints an `allowScripts` warning for a new package with an install script, do not add it to `allowScripts`; none of these packages need one.

- [ ] **Step 2: Route `/mcp` to the Worker**

In `wrangler.jsonc` change:

```jsonc
    "run_worker_first": ["/api/*"]
```

to:

```jsonc
    "run_worker_first": ["/api/*", "/mcp"]
```

- [ ] **Step 3: Write test helpers**

Create `test/worker/helpers.ts`:

```ts
import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class HttpClient {
  cookie = "";
  constructor(public token?: string) {}
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { "x-rf": "1", ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await SELF.fetch("https://app.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("Set-Cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  }
}

export async function signup(email: string, invite?: string) {
  const c = new HttpClient();
  const r = await c.req("POST", "/api/auth/signup", { email, password: "correct horse", name: email.split("@")[0], invite });
  expect(r.status).toBe(200);
  return c;
}

export async function tokenFor(c: HttpClient): Promise<string> {
  const r = await c.req("POST", "/api/tokens", { name: "mcp" });
  expect(r.status).toBe(200);
  return r.json.token;
}

export async function ownerWithBase(prefix: string, template = "crm") {
  const c = await signup(`${prefix}@example.com`);
  const ws = (await c.req("GET", "/api/auth/me")).json.workspaces[0];
  const baseId = (await c.req("POST", `/api/workspaces/${ws.id}/bases`, { template })).json.id as string;
  return { c, wsId: ws.id as string, baseId, token: await tokenFor(c) };
}

export async function addViewer(owner: HttpClient, wsId: string, email: string): Promise<string> {
  const inv = await owner.req("POST", `/api/workspaces/${wsId}/invites`, { role: "viewer" });
  const viewer = await signup(email, inv.json.id);
  return tokenFor(viewer);
}

export async function mcpClient(token?: string): Promise<Client> {
  const client = new Client({ name: "rowflare-test", version: "1.0.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  const transport = new StreamableHTTPClientTransport(new URL("https://app.test/mcp"), {
    fetch: (url, init) => SELF.fetch(url, init),
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult & { structuredContent?: any }> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult & { structuredContent?: any };
}
```

- [ ] **Step 4: Write the failing tests**

Create `test/worker/mcp.test.ts`:

```ts
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
    expect(names).toEqual(expect.arrayContaining(["list_bases", "describe_base"]));
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
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run --project worker test/worker/mcp.test.ts`
Expected: FAIL. The 401 tests get a non-401 status (the request falls through to assets or a 404), and the client tests fail to connect.

- [ ] **Step 6: Create `src/worker/mcp/result.ts`**

```ts
// Tool result helpers: every tool returns JSON as structuredContent plus the same JSON as text.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../access";
import type { ApiRecord } from "../records";

export const TEXT_LIMIT = 2000;

export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Runs a tool body; user-correctable errors become tool errors with their message so the model can retry. */
export function guard<A>(fn: (args: A) => Promise<Record<string, unknown>>): (args: A) => Promise<CallToolResult> {
  return async args => {
    try {
      return ok(await fn(args));
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message);
      console.error(e);
      return fail("Internal error");
    }
  };
}

export function truncateRecord(rec: ApiRecord, max = TEXT_LIMIT): ApiRecord {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec.fields)) fields[k] = typeof v === "string" && v.length > max ? `${v.slice(0, max)}… [truncated, ${v.length} chars]` : v;
  return { ...rec, fields };
}
```

- [ ] **Step 7: Create `src/worker/mcp/describe.ts`**

```ts
// Schema rendered for models: names instead of internal ids, formulas with field names.
import type { Field, Schema, Table, View, ViewType } from "../../shared/types";
import { toDisplay } from "../../shared/formula";
import { fieldsOf } from "../records";

export interface FieldInfo {
  id: string;
  name: string;
  type: Field["type"];
  description?: string;
  options?: Record<string, unknown>;
}

export interface TableInfo {
  id: string;
  name: string;
  primaryField: string | undefined;
  rowCount: number | undefined;
  fields: FieldInfo[];
  views: { id: string; name: string; type: ViewType }[];
}

export function describeField(schema: Schema, f: Field): FieldInfo {
  const o = f.options;
  const fieldName = (id?: string) => schema.fields.find(x => x.id === id)?.name;
  const options: Record<string, unknown> = {};
  switch (f.type) {
    case "number":
      if (o.precision !== undefined) options.precision = o.precision;
      if (o.format) options.format = o.format;
      if (o.symbol) options.symbol = o.symbol;
      break;
    case "singleSelect":
    case "multiSelect":
      options.choices = (o.choices ?? []).map(c => c.name);
      break;
    case "date":
      options.includeTime = !!o.includeTime;
      break;
    case "link":
      options.linkedTable = schema.tables.find(t => t.id === o.linkedTableId)?.name;
      options.inverseField = fieldName(o.inverseFieldId);
      break;
    case "lookup":
    case "rollup":
      options.linkField = fieldName(o.linkFieldId);
      options.targetField = fieldName(o.targetFieldId);
      if (f.type === "rollup") options.fn = o.fn;
      options.resultType = o.resultType;
      break;
    case "formula":
      options.formula = toDisplay(o.formula ?? "", fieldsOf(schema, f.tableId).map(x => ({ id: x.id, name: x.name })));
      options.resultType = o.resultType;
      if (o.format) options.format = o.format;
      break;
    case "user":
      options.multiple = !!o.multiple;
      break;
  }
  return { id: f.id, name: f.name, type: f.type, ...(f.description ? { description: f.description } : {}), ...(Object.keys(options).length ? { options } : {}) };
}

export function describeView(v: View) {
  return { id: v.id, name: v.name, type: v.type };
}

export function describeTable(schema: Schema, t: Table): TableInfo {
  return {
    id: t.id,
    name: t.name,
    primaryField: schema.fields.find(f => f.id === t.primaryFieldId)?.name,
    rowCount: t.rowCount,
    fields: fieldsOf(schema, t.id).map(f => describeField(schema, f)),
    views: schema.views.filter(v => v.tableId === t.id).map(describeView),
  };
}
```

- [ ] **Step 8: Create `src/worker/mcp/tools-read.ts` with the first two tools**

```ts
// Read-only MCP tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baseAccess, requireUser, type AppContext } from "../access";
import { describeTable } from "./describe";
import { guard } from "./result";

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export function registerReadTools(server: McpServer, c: AppContext) {
  server.registerTool(
    "list_bases",
    { title: "List bases", description: "List the Rowflare bases you can access, with their workspace and your permission (read, edit, create).", inputSchema: {}, annotations: READ },
    guard(async () => {
      const user = requireUser(c);
      const { results } = await c.env.DB.prepare(
        "SELECT b.id, b.name, w.name workspace, m.role FROM bases b JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = ? JOIN workspaces w ON w.id = b.workspace_id ORDER BY b.created_at",
      )
        .bind(user.id)
        .all<{ id: string; name: string; workspace: string; role: string }>();
      return { bases: results.map(b => ({ id: b.id, name: b.name, workspace: b.workspace, permission: b.role === "viewer" ? "read" : b.role === "owner" ? "create" : "edit" })) };
    }),
  );

  server.registerTool(
    "describe_base",
    {
      title: "Describe base",
      description: "Show every table in a base with its fields (type and options), primary field, row count and views. Call this before reading or writing records so you use the right table and field names.",
      inputSchema: { baseId: z.string().describe("Base id from list_bases") },
      annotations: READ,
    },
    guard(async ({ baseId }: { baseId: string }) => {
      const a = await baseAccess(c, baseId, "read");
      const schema = await a.stub.schema();
      return { baseId, name: a.base.name, tables: schema.tables.map(t => describeTable(schema, t)) };
    }),
  );
}
```

- [ ] **Step 9: Create `src/worker/mcp/server.ts`**

```ts
// MCP endpoint: stateless Streamable HTTP, one server per request, personal access tokens only.
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { Env } from "../env";
import type { AppContext, Vars } from "../access";
import { authenticate } from "../auth";
import { ensureSchema } from "../schema";
import { registerReadTools } from "./tools-read";

const INSTRUCTIONS =
  "Rowflare is an Airtable-style database. Start with list_bases, then describe_base to learn table and field names. " +
  "Use field names (not ids) in records and filters; select options and linked records can be given by name. " +
  "Prefer the structured filter over formula for speed, and use aggregate instead of reading every record to count or total.";

export const mcpRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function buildServer(c: AppContext): McpServer {
  const server = new McpServer({ name: "rowflare", version: "0.1.0" }, { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  registerReadTools(server, c);
  return server;
}

mcpRoutes.post("/", async c => {
  await ensureSchema(c.env);
  const auth = await authenticate(c.env, c.req.raw);
  if (!auth || auth.via !== "token") {
    return c.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Send a personal access token: Authorization: Bearer <token>" }, id: null },
      401,
      { "WWW-Authenticate": 'Bearer realm="rowflare"' },
    );
  }
  c.set("user", auth.user);
  c.set("via", "token");
  const server = buildServer(c as AppContext);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

mcpRoutes.on(["GET", "DELETE"], "/", c => c.json({ error: "Method not allowed" }, 405, { Allow: "POST" }));
```

- [ ] **Step 10: Mount the route**

In `src/worker/index.ts`, add the import next to the `apiV1` import:

```ts
import { mcpRoutes } from "./mcp/server";
```

and add directly after `app.route("/api/_bench", benchRoutes);`:

```ts
app.route("/mcp", mcpRoutes);
```

The `/api/*` auth middleware does not run for `/mcp`; `server.ts` authenticates on its own, and the app-level `onError` still turns any thrown `HttpError` into JSON.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run --project worker test/worker/mcp.test.ts`
Expected: all 7 tests PASS.

If the client connect fails with an error mentioning `EvalError` or `Code generation from strings disallowed`, some code path still uses Ajv: confirm both the server (`server.ts`) and the test client (`helpers.ts`) pass `CfWorkerJsonSchemaValidator`.

If typecheck rejects the `guard(async ({ baseId }: { baseId: string }) => ...)` callback type against `registerTool`, cast the guarded function with `as never` only at that call site and note it in the review; do not loosen `guard` itself.

- [ ] **Step 12: Check bundle size**

Run: `npx wrangler deploy --dry-run --outdir /private/tmp/claude-501/-Users-znjac-htdocs-Rowflare/fdd2b911-54da-46d3-a466-abf2afe3defe/scratchpad/bundle 2>&1 | grep -i "total upload"`
Expected: a line like `Total Upload: N KiB / gzip: M KiB`. Write the gzip number down for Task 7. It must stay under 3,000 KiB gzip (the Workers Free limit; Paid is 10 MiB).

- [ ] **Step 13: Checkpoint (no git)**

Run: `npm test`
Expected: all tests PASS.

---

### Task 4: `query_records`, `get_records` and `aggregate` tools

**Files:**
- Create: `src/worker/mcp/translate.ts`, `src/worker/mcp/schemas.ts`
- Modify: `src/worker/mcp/tools-read.ts` (add three tools inside `registerReadTools`)
- Test: `test/worker/mcp.test.ts`

**Interfaces:**
- Consumes: `loadTable`, `TableCtx`, `fieldOf`, `toRecord`, `unwrap`, `filterIdsByFormula` (`records.ts`); `BaseStub.query`, `BaseStub.rows`, `BaseStub.aggregate`; `QueryInput.extraFilters`; `AggregateInput`, `AggFn`, `DateBucket` (`base/aggregate.ts`); `guard`, `truncateRecord` (`result.ts`).
- Produces:
  - `src/worker/mcp/schemas.ts`: zod values `filterSchema`, `sortSchema`, `fieldsSchema`, `FILTER_OPS`; types `FilterInput = z.infer<typeof filterSchema>`, `SortInput = z.infer<typeof sortSchema>`.
  - `src/worker/mcp/translate.ts`: `choiceId(f: Field, value: unknown): string`, `userId(members: Map<string, Member>, value: unknown): string`, `toFilterSpec(t: TableCtx, filter?: FilterInput): FilterSpec | undefined`, `toSorts(t: TableCtx, sort?: SortInput): SortSpec[] | undefined`, `viewOf(t: TableCtx, key: string): View`, `onlyFields(t: TableCtx, keys?: string[]): Set<string> | undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/mcp.test.ts`:

```ts
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
    expect(Object.keys(r.structuredContent.records[0]?.fields ?? { Name: 1 }).every(k => k === "Name" || k === "Amount")).toBe(true);

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
    const bad = await call(client, "query_records", { baseId, table: "Deals", filter: { conditions: [{ field: "Stage", op: "eq", value: "Closed" }] } });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toBe('Unknown option "Closed" for field Stage. Options: Lead, Qualified, Proposal, Negotiation, Won, Lost');
    const badField = await call(client, "query_records", { baseId, table: "Deals", filter: { conditions: [{ field: "Statu", op: "eq", value: "x" }] } });
    expect((badField.content[0] as { text: string }).text).toBe('Unknown field "Statu" in table Deals. Fields: Name, Company, Stage, Amount, Close date, Probability, Weighted');
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
```

The blank template's first table has fields Name, Notes, Status and 3 empty rows (see `BaseStore.createTable`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project worker test/worker/mcp.test.ts -t "MCP record queries"`
Expected: FAIL with tool-not-found errors (`Tool query_records not found` or similar MCP error).

- [ ] **Step 3: Create `src/worker/mcp/schemas.ts`**

```ts
// Zod shapes shared by several MCP tools.
import { z } from "zod";

export const FILTER_OPS = ["eq", "neq", "contains", "ncontains", "empty", "notempty", "gt", "gte", "lt", "lte", "anyOf", "noneOf", "allOf"] as const;

export const filterSchema = z
  .object({
    conjunction: z.enum(["and", "or"]).optional(),
    conditions: z
      .array(
        z.object({
          field: z.string().describe("Field name or id"),
          op: z.enum(FILTER_OPS),
          value: z.unknown().optional().describe("Option names for select fields, record ids for links, YYYY-MM-DD for dates; omit for empty/notempty"),
        }),
      )
      .max(20),
  })
  .describe("Structured filter, evaluated as SQL in the database (fast)");

export const sortSchema = z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).max(5);

export const fieldsSchema = z.array(z.string()).max(100).describe("Only return these fields (names or ids)");

export type FilterInput = z.infer<typeof filterSchema>;
export type SortInput = z.infer<typeof sortSchema>;
```

- [ ] **Step 4: Create `src/worker/mcp/translate.ts` (query part)**

```ts
// Translates model-friendly input (names) into the engine's id-based structures.
import type { Field, FilterSpec, Member, SortSpec, View } from "../../shared/types";
import { HttpError } from "../access";
import { fieldOf, type TableCtx } from "../records";
import type { FilterInput, SortInput } from "./schemas";

export function choiceId(f: Field, value: unknown): string {
  const s = String(value);
  const choices = f.options.choices ?? [];
  const c = choices.find(c => c.id === s || c.name === s) ?? choices.find(c => c.name.toLowerCase() === s.toLowerCase());
  if (!c) throw new HttpError(422, `Unknown option "${s}" for field ${f.name}. Options: ${choices.map(c => c.name).join(", ")}`);
  return c.id;
}

export function userId(members: Map<string, Member>, value: unknown): string {
  const s = String(value).toLowerCase();
  for (const m of members.values()) if (m.id.toLowerCase() === s || m.email.toLowerCase() === s || m.name.toLowerCase() === s) return m.id;
  return String(value);
}

function conditionValue(t: TableCtx, f: Field, v: unknown): unknown {
  if (v === undefined || v === null) return v;
  const each = (fn: (x: unknown) => unknown) => (Array.isArray(v) ? v.map(fn) : fn(v));
  if (f.type === "singleSelect" || f.type === "multiSelect") return each(x => choiceId(f, x));
  if (f.type === "user") return each(x => userId(t.members, x));
  return v;
}

export function toFilterSpec(t: TableCtx, filter?: FilterInput): FilterSpec | undefined {
  if (!filter?.conditions.length) return undefined;
  return {
    conjunction: filter.conjunction ?? "and",
    conditions: filter.conditions.map(c => {
      const f = fieldOf(t.fields, c.field, t.table.name);
      return { fieldId: f.id, op: c.op, value: conditionValue(t, f, c.value) };
    }),
  };
}

export function toSorts(t: TableCtx, sort?: SortInput): SortSpec[] | undefined {
  if (!sort?.length) return undefined;
  return sort.map(s => ({ fieldId: fieldOf(t.fields, s.field, t.table.name).id, dir: s.direction === "desc" ? "desc" : "asc" }));
}

export function viewOf(t: TableCtx, key: string): View {
  const views = t.schema.views.filter(v => v.tableId === t.table.id);
  const v = views.find(v => v.id === key || v.name === key) ?? views.find(v => v.name.toLowerCase() === key.toLowerCase());
  if (!v) throw new HttpError(422, `Unknown view "${key}" in table ${t.table.name}. Views: ${views.map(v => v.name).join(", ")}`);
  return v;
}

export function onlyFields(t: TableCtx, keys?: string[]): Set<string> | undefined {
  return keys?.length ? new Set(keys.map(k => fieldOf(t.fields, k, t.table.name).id)) : undefined;
}
```

- [ ] **Step 5: Add the three tools to `registerReadTools`**

Add these imports to `src/worker/mcp/tools-read.ts`:

```ts
import { filterIdsByFormula, loadTable, toRecord, unwrap, fieldOf } from "../records";
import type { AggFn, DateBucket } from "../base/aggregate";
import { fieldsSchema, filterSchema, sortSchema, type FilterInput, type SortInput } from "./schemas";
import { onlyFields, toFilterSpec, toSorts, viewOf } from "./translate";
import { truncateRecord } from "./result";
```

(`truncateRecord` joins the existing `guard` import from `./result`.)

Append inside `registerReadTools`:

```ts
  const table = z.string().describe("Table name or id");

  server.registerTool(
    "query_records",
    {
      title: "Query records",
      description: "Find records in a table. Use filter (structured, fast) and/or formula (an Airtable formula such as AND({Status} = \"Done\", {Hours} > 5), slower). With view, the view's own filters and sorts apply and filter narrows them. Returns total and nextOffset for paging.",
      inputSchema: {
        baseId: z.string(),
        table,
        filter: filterSchema.optional(),
        formula: z.string().optional(),
        sort: sortSchema.optional(),
        view: z.string().optional().describe("View name or id"),
        fields: fieldsSchema.optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ,
    },
    guard(async (args: { baseId: string; table: string; filter?: FilterInput; formula?: string; sort?: SortInput; view?: string; fields?: string[]; limit?: number; offset?: number }) => {
      const t = await loadTable(c, args.baseId, args.table, "read");
      const viewId = args.view ? viewOf(t, args.view).id : undefined;
      let ids = unwrap(await t.a.stub.query(t.table.id, { viewId, extraFilters: toFilterSpec(t, args.filter), sorts: toSorts(t, args.sort), limit: 0 })).ids;
      if (args.formula) ids = await filterIdsByFormula(t, ids, args.formula);
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const page = unwrap(await t.a.stub.rows(t.table.id, ids.slice(offset, offset + limit)));
      const only = onlyFields(t, args.fields);
      const records = page.map(r => truncateRecord(toRecord(r, t.fields, t.members, t.origin, false, only)));
      return { records, total: ids.length, ...(offset + limit < ids.length ? { nextOffset: offset + limit } : {}) };
    }),
  );

  server.registerTool(
    "get_records",
    {
      title: "Get records",
      description: "Fetch up to 100 records by id. Long text is cut at 2,000 characters unless fullText is true.",
      inputSchema: { baseId: z.string(), table, ids: z.array(z.number().int()).min(1).max(100), fields: fieldsSchema.optional(), fullText: z.boolean().optional() },
      annotations: READ,
    },
    guard(async (args: { baseId: string; table: string; ids: number[]; fields?: string[]; fullText?: boolean }) => {
      const t = await loadTable(c, args.baseId, args.table, "read");
      const rows = unwrap(await t.a.stub.rows(t.table.id, args.ids));
      const only = onlyFields(t, args.fields);
      return { records: rows.map(r => toRecord(r, t.fields, t.members, t.origin, false, only)).map(r => (args.fullText ? r : truncateRecord(r))) };
    }),
  );

  server.registerTool(
    "aggregate",
    {
      title: "Aggregate",
      description:
        "Count, total, average, min or max over a table, optionally grouped by up to 2 fields, computed in the database. Use this instead of reading all records to answer how many / how much questions. " +
        "Multi-value fields (multiple select, links, users) count a record once per value. Dates group by day unless bucket is week, month or year.",
      inputSchema: {
        baseId: z.string(),
        table,
        filter: filterSchema.optional(),
        view: z.string().optional(),
        groupBy: z.array(z.object({ field: z.string(), bucket: z.enum(["day", "week", "month", "year"]).optional() })).max(2).optional(),
        metrics: z
          .array(z.object({ fn: z.enum(["count", "countUnique", "countEmpty", "countFilled", "sum", "avg", "min", "max"]), field: z.string().optional(), as: z.string().optional().describe("Result key; defaults to fn or 'fn Field'") }))
          .min(1)
          .max(10),
      },
      annotations: READ,
    },
    guard(async (args: { baseId: string; table: string; filter?: FilterInput; view?: string; groupBy?: { field: string; bucket?: DateBucket }[]; metrics: { fn: AggFn; field?: string; as?: string }[] }) => {
      const t = await loadTable(c, args.baseId, args.table, "read");
      const metrics = args.metrics.map(m => {
        const f = m.field ? fieldOf(t.fields, m.field, t.table.name) : undefined;
        return { fn: m.fn, fieldId: f?.id, as: m.as ?? (f ? `${m.fn} ${f.name}` : m.fn) };
      });
      const groupBy = args.groupBy?.map(g => ({ fieldId: fieldOf(t.fields, g.field, t.table.name).id, bucket: g.bucket }));
      const res = unwrap(await t.a.stub.aggregate(t.table.id, { viewId: args.view ? viewOf(t, args.view).id : undefined, filters: toFilterSpec(t, args.filter), groupBy, metrics }));
      return { ...res, groupBy: args.groupBy?.map(g => g.field) ?? [] };
    }),
  );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run --project worker test/worker/mcp.test.ts`
Expected: all MCP tests PASS.

- [ ] **Step 7: Checkpoint (no git)**

Run: `npm test`
Expected: all tests PASS.

---

### Task 5: Record write tools

**Files:**
- Create: `src/worker/mcp/tools-write.ts`
- Modify: `src/worker/mcp/server.ts` (call `registerWriteTools`)
- Test: `test/worker/mcp.test.ts`

**Interfaces:**
- Consumes: `loadTable`, `fieldOf`, `inCells`, `toRecord`, `unwrap` (`records.ts`); `BaseStub.rowOp`, `BaseStub.rows`; `guard`, `truncateRecord`.
- Produces: `registerWriteTools(server: McpServer, c: AppContext): void`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/mcp.test.ts`:

```ts
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
    expect((unknown.content[0] as { text: string }).text).toBe('Unknown field "Nmae" in table Deals. Fields: Name, Company, Stage, Amount, Close date, Probability, Weighted');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project worker test/worker/mcp.test.ts -t "MCP record writes"`
Expected: FAIL (tools not found).

- [ ] **Step 3: Create `src/worker/mcp/tools-write.ts`**

```ts
// Record write tools. typecast defaults to true so models can write option names and linked record names.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../access";
import { fieldOf, inCells, loadTable, toRecord, unwrap, type TableCtx } from "../records";
import { guard, truncateRecord } from "./result";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const fieldsValue = z.record(z.string(), z.unknown()).describe("Field name to value. Select fields take option names, links take record ids or primary field values, users take emails, dates take YYYY-MM-DD");

/** Same as inCells, but unknown names fail with the list of valid fields. */
function cells(t: TableCtx, input: Record<string, unknown>) {
  for (const k of Object.keys(input)) fieldOf(t.fields, k, t.table.name);
  return inCells(t.fields, input);
}

export function registerWriteTools(server: McpServer, c: AppContext) {
  const table = z.string().describe("Table name or id");
  const typecast = z.boolean().optional().describe("Default true: create missing select options and match linked records by name");

  server.registerTool(
    "create_records",
    { title: "Create records", description: "Create 1 to 200 records.", inputSchema: { baseId: z.string(), table, records: z.array(z.object({ fields: fieldsValue })).min(1).max(200), typecast }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; records: { fields: Record<string, unknown> }[]; typecast?: boolean }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const res = unwrap(await t.a.stub.rowOp(t.a.actor, { op: "create", tableId: t.table.id, rows: args.records.map(r => ({ cells: cells(t, r.fields) })), typecast: args.typecast ?? true }));
      const created = res.changes.find(ch => ch.tableId === t.table.id)?.rows ?? [];
      return { records: created.slice(0, args.records.length).map(r => truncateRecord(toRecord(r, t.fields, t.members, t.origin, false))) };
    }),
  );

  server.registerTool(
    "update_records",
    { title: "Update records", description: "Update 1 to 200 records by id. Only the given fields change.", inputSchema: { baseId: z.string(), table, records: z.array(z.object({ id: z.number().int(), fields: fieldsValue })).min(1).max(200), typecast }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; records: { id: number; fields: Record<string, unknown> }[]; typecast?: boolean }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const updates = args.records.map(r => ({ id: r.id, cells: cells(t, r.fields) }));
      unwrap(await t.a.stub.rowOp(t.a.actor, { op: "update", tableId: t.table.id, updates, typecast: args.typecast ?? true }));
      const rows = unwrap(await t.a.stub.rows(t.table.id, updates.map(u => u.id)));
      return { records: rows.map(r => truncateRecord(toRecord(r, t.fields, t.members, t.origin, false))) };
    }),
  );

  server.registerTool(
    "delete_records",
    { title: "Delete records", description: "Permanently delete 1 to 200 records by id.", inputSchema: { baseId: z.string(), table, ids: z.array(z.number().int()).min(1).max(200) }, annotations: DELETE },
    guard(async (args: { baseId: string; table: string; ids: number[] }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const res = unwrap(await t.a.stub.rowOp(t.a.actor, { op: "delete", tableId: t.table.id, ids: args.ids }));
      return { deleted: res.deleted.find(d => d.tableId === t.table.id)?.ids ?? [] };
    }),
  );
}
```

- [ ] **Step 4: Register in `server.ts`**

Add `import { registerWriteTools } from "./tools-write";` and, in `buildServer`, `registerWriteTools(server, c);` after `registerReadTools(server, c);`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run --project worker test/worker/mcp.test.ts`
Expected: all MCP tests PASS.

If the typecast test fails because the linked company is not matched by name, check what `coerceCell` accepts for link cells with `typecast` (`src/shared/cells.ts`, `coerceCtx` in `store.ts`); do not change the engine, adjust only the test value to a form the REST API also accepts and note it in the review.

- [ ] **Step 6: Checkpoint (no git)**

Run: `npm test`
Expected: all tests PASS.

---

### Task 6: Schema tools (tables, fields, views)

**Files:**
- Modify: `src/worker/mcp/translate.ts` (field spec and view config translation)
- Modify: `src/worker/mcp/schemas.ts` (field spec and view zod shapes)
- Create: `src/worker/mcp/tools-schema.ts`
- Modify: `src/worker/mcp/server.ts` (call `registerSchemaTools`)
- Test: `test/worker/mcp.test.ts`

**Interfaces:**
- Consumes: `baseAccess`, `HttpError`; `tableOf`, `fieldsOf`, `fieldOf`, `unwrap`, `loadTable`, `TableCtx`; `BaseStub.schemaOp`; `SchemaOp` types from `base-do.ts`; `FieldInput`; `describeTable`, `describeField`, `describeView`; `toFilterSpec`, `toSorts`, `viewOf`.
- Produces:
  - `schemas.ts`: `FIELD_TYPES_ENUM`, `fieldSpecSchema`, `fieldSpecOptionsSchema`, `viewOptionsShape`; types `FieldSpec`, `FieldSpecOptions`.
  - `translate.ts`: `COMPLEX_TYPES: ReadonlySet<FieldType>`, `toFieldOptions(schema: Schema, tableId: string, o: FieldSpecOptions | undefined, existing?: Field): FieldOptions`, `toViewConfig(t: TableCtx, v: { filter?: FilterInput; sort?: SortInput; hiddenFields?: string[]; groupBy?: string }): ViewConfig`.
  - `registerSchemaTools(server: McpServer, c: AppContext): void`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker/mcp.test.ts`:

```ts
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
    expect(view.structuredContent.view).toEqual({ id: expect.any(String), name: "Board", type: "kanban" });
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

  it("viewer cannot change schema", async () => {
    const { c, wsId, baseId } = await ownerWithBase("mcp-viewer-schema");
    const client = await mcpClient(await addViewer(c, wsId, "mcp-viewer-schema2@example.com"));
    const r = await call(client, "create_table", { baseId, name: "Nope" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("You have read-only access to this base");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project worker test/worker/mcp.test.ts -t "MCP schema tools"`
Expected: FAIL (tools not found).

- [ ] **Step 3: Add zod shapes to `src/worker/mcp/schemas.ts`**

Append:

```ts
export const FIELD_TYPES_ENUM = ["text", "longText", "email", "url", "phone", "number", "singleSelect", "multiSelect", "date", "checkbox", "attachment", "link", "lookup", "rollup", "formula", "createdTime", "modifiedTime", "user", "autonumber"] as const;

export const fieldSpecOptionsSchema = z
  .object({
    choices: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional().describe("Select options; on update send the full list, existing options are matched by name"),
    precision: z.number().int().min(0).max(8).optional(),
    format: z.enum(["number", "currency", "percent"]).optional(),
    symbol: z.string().max(4).optional(),
    includeTime: z.boolean().optional(),
    linkedTable: z.string().optional().describe("link: table name or id to link to"),
    linkField: z.string().optional().describe("lookup / rollup: link field in this table"),
    targetField: z.string().optional().describe("lookup / rollup: field in the linked table"),
    fn: z.enum(["sum", "avg", "min", "max", "count", "counta", "countall", "arrayjoin", "arrayunique", "arraycompact", "and", "or", "concat"]).optional().describe("rollup function"),
    formula: z.string().optional().describe("Airtable formula with field names in braces, e.g. {Amount} * {Probability}"),
    multiple: z.boolean().optional().describe("user: allow several users"),
  })
  .optional();

export const fieldSpecSchema = z.object({ name: z.string().min(1), type: z.enum(FIELD_TYPES_ENUM), description: z.string().optional(), options: fieldSpecOptionsSchema });

export const viewOptionsShape = {
  filter: filterSchema.optional(),
  sort: sortSchema.optional(),
  hiddenFields: z.array(z.string()).optional(),
  groupBy: z.string().optional().describe("kanban: single select field to group cards by"),
};

export type FieldSpec = z.infer<typeof fieldSpecSchema>;
export type FieldSpecOptions = NonNullable<FieldSpec["options"]>;
```

- [ ] **Step 4: Add field spec and view translation to `src/worker/mcp/translate.ts`**

Change the type import line to:

```ts
import type { Field, FieldOptions, FieldType, FilterSpec, Member, Schema, SortSpec, View, ViewConfig } from "../../shared/types";
```

and the records import to:

```ts
import { fieldOf, fieldsOf, tableOf, type TableCtx } from "../records";
```

and the schemas import to:

```ts
import type { FieldSpecOptions, FilterInput, SortInput } from "./schemas";
```

Append:

```ts
/** Types that need other fields to exist first, so create_table adds them one by one after the plain fields. */
export const COMPLEX_TYPES: ReadonlySet<FieldType> = new Set(["link", "lookup", "rollup", "formula"]);

export function toFieldOptions(schema: Schema, tableId: string, o: FieldSpecOptions | undefined, existing?: Field): FieldOptions {
  const out: FieldOptions = {};
  if (!o) return out;
  if (o.precision !== undefined) out.precision = o.precision;
  if (o.format) out.format = o.format;
  if (o.symbol) out.symbol = o.symbol;
  if (o.includeTime !== undefined) out.includeTime = o.includeTime;
  if (o.multiple !== undefined) out.multiple = o.multiple;
  if (o.fn) out.fn = o.fn;
  if (o.formula !== undefined) out.formula = o.formula;
  if (o.choices) {
    // Keep ids of options that already exist (matched by name) so cells holding them survive the update.
    out.choices = o.choices.map(ch => {
      const name = typeof ch === "string" ? ch : ch.name;
      const prev = existing?.options.choices?.find(c => c.name.toLowerCase() === name.toLowerCase());
      return { id: prev?.id ?? "", name, color: (typeof ch === "string" ? undefined : ch.color) ?? prev?.color ?? "" };
    });
  }
  if (o.linkedTable) out.linkedTableId = tableOf(schema, o.linkedTable).id;
  if (o.linkField) {
    const table = schema.tables.find(t => t.id === tableId)!;
    const link = fieldOf(fieldsOf(schema, tableId), o.linkField, table.name);
    out.linkFieldId = link.id;
    if (o.targetField) {
      const target = schema.tables.find(t => t.id === link.options.linkedTableId);
      if (!target) throw new HttpError(422, `"${link.name}" is not a link field`);
      out.targetFieldId = fieldOf(fieldsOf(schema, target.id), o.targetField, target.name).id;
    }
  }
  return out;
}

export function toViewConfig(t: TableCtx, v: { filter?: FilterInput; sort?: SortInput; hiddenFields?: string[]; groupBy?: string }): ViewConfig {
  const config: ViewConfig = {};
  if (v.filter) config.filters = toFilterSpec(t, v.filter) ?? { conjunction: "and", conditions: [] };
  if (v.sort) config.sorts = toSorts(t, v.sort) ?? [];
  if (v.hiddenFields) config.hidden = v.hiddenFields.map(k => fieldOf(t.fields, k, t.table.name).id);
  if (v.groupBy) config.groupFieldId = fieldOf(t.fields, v.groupBy, t.table.name).id;
  return config;
}
```

An empty `id` and empty `color` are replaced by `BaseStore.normalizeOptions` (`isSafeId("")` is false, so a new choice id is generated; an empty color falls back to the palette).

- [ ] **Step 5: Create `src/worker/mcp/tools-schema.ts`**

```ts
// Schema tools: tables, fields and views.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Schema, ViewType } from "../../shared/types";
import { baseAccess, HttpError, type AppContext, type BaseAccess } from "../access";
import type { SchemaOp } from "../base-do";
import { fieldOf, loadTable, unwrap } from "../records";
import { describeField, describeTable, describeView } from "./describe";
import { guard } from "./result";
import { fieldSpecOptionsSchema, fieldSpecSchema, FIELD_TYPES_ENUM, viewOptionsShape, type FieldSpec, type FieldSpecOptions, type FilterInput, type SortInput } from "./schemas";
import { COMPLEX_TYPES, toFieldOptions, toViewConfig, viewOf } from "./translate";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

async function op(a: BaseAccess, o: SchemaOp): Promise<{ schema: Schema; id?: string }> {
  return unwrap(await a.stub.schemaOp(a.actor, o));
}

export function registerSchemaTools(server: McpServer, c: AppContext) {
  const table = z.string().describe("Table name or id");

  server.registerTool(
    "create_table",
    {
      title: "Create table",
      description: "Create a table. The first field is the primary field and must be a plain type (text, number, date...). Link, lookup, rollup and formula fields may reference fields listed earlier in the same call. Without fields you get Name, Notes and Status.",
      inputSchema: { baseId: z.string(), name: z.string().min(1), fields: z.array(fieldSpecSchema).max(50).optional() },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; name: string; fields?: FieldSpec[] }) => {
      const a = await baseAccess(c, args.baseId, "write");
      const specs = args.fields ?? [];
      if (specs.length && COMPLEX_TYPES.has(specs[0].type)) throw new HttpError(422, "The first field is the primary field and must be a plain type such as text, number or date; link, lookup, rollup and formula fields cannot come first");
      let schema = await a.stub.schema();
      const plain = specs.filter(s => !COMPLEX_TYPES.has(s.type)).map(s => ({ name: s.name, type: s.type, description: s.description, options: toFieldOptions(schema, "", s.options) }));
      const created = await op(a, { op: "createTable", name: args.name, fields: plain.length ? plain : undefined });
      const tableId = created.id!;
      schema = created.schema;
      for (const s of specs.filter(s => COMPLEX_TYPES.has(s.type))) {
        schema = (await op(a, { op: "createField", tableId, field: { name: s.name, type: s.type, description: s.description, options: toFieldOptions(schema, tableId, s.options) } })).schema;
      }
      const t = schema.tables.find(t => t.id === tableId)!;
      // Present fields in the order the caller asked for.
      const info = describeTable(schema, t);
      const order = new Map(specs.map((s, i) => [s.name.toLowerCase(), i]));
      info.fields.sort((x, y) => (order.get(x.name.toLowerCase()) ?? 999) - (order.get(y.name.toLowerCase()) ?? 999));
      return { table: info };
    }),
  );

  server.registerTool(
    "update_table",
    { title: "Update table", description: "Rename a table or change its primary field.", inputSchema: { baseId: z.string(), table, name: z.string().optional(), primaryField: z.string().optional() }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; name?: string; primaryField?: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const primaryFieldId = args.primaryField ? fieldOf(t.fields, args.primaryField, t.table.name).id : undefined;
      const { schema } = await op(t.a, { op: "updateTable", tableId: t.table.id, name: args.name, primaryFieldId });
      return { table: describeTable(schema, schema.tables.find(x => x.id === t.table.id)!) };
    }),
  );

  server.registerTool(
    "delete_table",
    { title: "Delete table", description: "Permanently delete a table, its records, and link fields in other tables that point at it.", inputSchema: { baseId: z.string(), table }, annotations: DELETE },
    guard(async (args: { baseId: string; table: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      await op(t.a, { op: "deleteTable", tableId: t.table.id });
      return { deleted: t.table.id };
    }),
  );

  server.registerTool(
    "create_field",
    { title: "Create field", description: "Add a field to a table. Formulas use field names in braces.", inputSchema: { baseId: z.string(), table, field: fieldSpecSchema }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; field: FieldSpec }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const s = args.field;
      const res = await op(t.a, { op: "createField", tableId: t.table.id, field: { name: s.name, type: s.type, description: s.description, options: toFieldOptions(t.schema, t.table.id, s.options) } });
      return { field: describeField(res.schema, res.schema.fields.find(f => f.id === res.id)!) };
    }),
  );

  server.registerTool(
    "update_field",
    {
      title: "Update field",
      description: "Rename a field, change its type or options, or set its description. For select fields send the full option list; existing options are kept by name and options left out are removed from cells.",
      inputSchema: { baseId: z.string(), table, field: z.string().describe("Field name or id"), name: z.string().optional(), type: z.enum(FIELD_TYPES_ENUM).optional(), description: z.string().optional(), options: fieldSpecOptionsSchema },
      annotations: WRITE,
    },
    guard(async (args: { baseId: string; table: string; field: string; name?: string; type?: FieldSpec["type"]; description?: string; options?: FieldSpecOptions }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const f = fieldOf(t.fields, args.field, t.table.name);
      const options = args.options ? toFieldOptions(t.schema, t.table.id, args.options, f) : undefined;
      const { schema } = await op(t.a, { op: "updateField", fieldId: f.id, patch: { name: args.name, type: args.type, options, description: args.description } });
      return { field: describeField(schema, schema.fields.find(x => x.id === f.id)!) };
    }),
  );

  server.registerTool(
    "delete_field",
    { title: "Delete field", description: "Permanently delete a field and its values. Deleting a link field also deletes its inverse.", inputSchema: { baseId: z.string(), table, field: z.string() }, annotations: DELETE },
    guard(async (args: { baseId: string; table: string; field: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const f = fieldOf(t.fields, args.field, t.table.name);
      await op(t.a, { op: "deleteField", fieldId: f.id });
      return { deleted: f.id };
    }),
  );

  server.registerTool(
    "create_view",
    { title: "Create view", description: "Add a grid, kanban or form view with optional filter, sort, hidden fields and kanban grouping.", inputSchema: { baseId: z.string(), table, name: z.string().min(1), type: z.enum(["grid", "kanban", "form"]), ...viewOptionsShape }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; name: string; type: ViewType; filter?: FilterInput; sort?: SortInput; hiddenFields?: string[]; groupBy?: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const res = await op(t.a, { op: "createView", tableId: t.table.id, view: { name: args.name, type: args.type, config: toViewConfig(t, args) } });
      return { view: describeView(res.schema.views.find(v => v.id === res.id)!) };
    }),
  );

  server.registerTool(
    "update_view",
    { title: "Update view", description: "Rename a view or replace its filter, sort, hidden fields or kanban grouping. Settings you leave out are kept.", inputSchema: { baseId: z.string(), table, view: z.string(), name: z.string().optional(), ...viewOptionsShape }, annotations: WRITE },
    guard(async (args: { baseId: string; table: string; view: string; name?: string; filter?: FilterInput; sort?: SortInput; hiddenFields?: string[]; groupBy?: string }) => {
      const t = await loadTable(c, args.baseId, args.table, "write");
      const v = viewOf(t, args.view);
      const { schema } = await op(t.a, { op: "updateView", viewId: v.id, patch: { name: args.name, config: toViewConfig(t, args) } });
      return { view: describeView(schema.views.find(x => x.id === v.id)!) };
    }),
  );
}
```

Note for the implementer: the `linkedTable` lookup for complex fields uses the schema returned after `createTable`, so a link field may target the table being created (a self link).

- [ ] **Step 6: Register in `server.ts`**

Add `import { registerSchemaTools } from "./tools-schema";` and `registerSchemaTools(server, c);` after `registerWriteTools(server, c);`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run --project worker test/worker/mcp.test.ts`
Expected: all MCP tests PASS.

If "update_field keeps existing select values" fails, inspect whether `BaseStore.updateField` enqueued a `convert` job (it does so only when an existing choice id disappears); a failure means `toFieldOptions` did not carry an id over.

- [ ] **Step 8: Add the full tool list assertion**

In the existing test `initializes and lists all tools`, replace the `expect(names).toEqual(expect.arrayContaining([...]))` line with:

```ts
    expect(names.sort()).toEqual(["aggregate", "create_field", "create_records", "create_table", "create_view", "delete_field", "delete_records", "delete_table", "describe_base", "get_records", "list_bases", "query_records", "update_field", "update_records", "update_table", "update_view"]);
```

Run: `npx vitest run --project worker test/worker/mcp.test.ts`
Expected: PASS.

- [ ] **Step 9: Checkpoint (no git)**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, no type errors.

---

### Task 7: Docs, benchmark number and manual verification

**Files:**
- Create: `docs/mcp.md`
- Modify: `README.md` (features list and links line)
- Modify: `docs/architecture.md` (performance table)
- Modify: `bench/run.mjs` and `src/worker/bench.ts` only if needed to time `aggregate` (see Step 3)

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing docs.

- [ ] **Step 1: Write `docs/mcp.md`**

Use the same front matter style as `docs/api.md` (`title`, `description`, `order: 35`). Sections, in order, each written as plain paragraphs or tables (no hard line wrapping):

1. What it is: one paragraph. Endpoint `https://<your instance>/mcp`, Streamable HTTP, personal access tokens.
2. Create a token: Settings, API tokens. The token acts as you; viewer access means read-only tools only.
3. Connect, with these snippets:

```sh
claude mcp add --transport http rowflare https://rowflare.example.com/mcp --header "Authorization: Bearer $ROWFLARE_TOKEN"
```

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "rowflare": { "url": "https://rowflare.example.com/mcp", "headers": { "Authorization": "Bearer rf_..." } } } }
```

Claude Desktop (`claude_desktop_config.json`, through the `mcp-remote` bridge):

```json
{ "mcpServers": { "rowflare": { "command": "npx", "args": ["-y", "mcp-remote", "https://rowflare.example.com/mcp", "--header", "Authorization: Bearer rf_..."] } } }
```

4. Tools: a table with all 16 tool names, one-line purpose each, and a "destructive" column for `delete_records`, `delete_table`, `delete_field`.
5. Limits: the numbers from Global Constraints.
6. Not yet supported: OAuth sign-in for claude.ai and ChatGPT web connectors (planned).

- [ ] **Step 2: Update README**

In `README.md`, add after the REST API bullet in Features:

```md
- **MCP server** at `/mcp` for Claude, Cursor and other AI clients: read, write, build tables and get grouped totals with a personal access token. See [docs/mcp.md](docs/mcp.md).
```

and change the links line to include `· [MCP](docs/mcp.md)` after `[REST API](docs/api.md)`. Leave the "Not in scope" line alone; it is updated in the AI fields project.

- [ ] **Step 3: Measure aggregate on the bench dataset**

Read `src/worker/bench.ts` and `bench/run.mjs` to see how existing operations are timed. If `benchCommand` has a switch over command names, add a case `"aggregate"` that runs `store.aggregate(<tasks table id the bench already uses>, { groupBy: [{ fieldId: <its single select field> }], metrics: [{ fn: "count", as: "n" }, { fn: "sum", fieldId: <its number field>, as: "s" }] })`, using the same table and field lookups the other bench cases use, and add it to the list of operations `bench/run.mjs` times. Then run, against local dev with `BENCH_TOKEN` set in `.dev.vars`:

Run: `npx wrangler dev` in one terminal (background), then `npm run bench`
Expected: the output includes an aggregate timing for 50,000 rows. Target from the spec: under 300 ms.

If it is over 300 ms, do not optimize in this task; record the number and report it.

- [ ] **Step 4: Record the number**

Add a row to the performance table in `docs/architecture.md`:

```md
| Group 50,000 rows by a select field with count and sum (`aggregate`) | n/a | <measured> |
```

Also add one sentence under "Storage layout" or a new short "Aggregation" paragraph: aggregation reuses the view query for matching ids and folds rows in 1,000-row batches inside the Durable Object; there is no SQL GROUP BY over row JSON.

- [ ] **Step 5: Manual end-to-end check with Claude Code**

With `npx wrangler dev` running and a token created in the local app:

Run: `claude mcp add --transport http rowflare-local http://localhost:8787/mcp --header "Authorization: Bearer <token>"`

In a Claude Code session ask: "Using rowflare-local, create a base-level CRM table set: Companies and Deals linked, with a rollup of deal amounts on Companies. Add 3 companies and 5 deals, then tell me total deal amount per company." Confirm in the web app that the tables, links and rollup exist and the totals match.

Remove the local server afterwards: `claude mcp remove rowflare-local`.

- [ ] **Step 6: Final checkpoint (no git)**

Run: `npm test && npm run typecheck && npx wrangler deploy --dry-run --outdir /private/tmp/claude-501/-Users-znjac-htdocs-Rowflare/fdd2b911-54da-46d3-a466-abf2afe3defe/scratchpad/bundle`
Expected: all tests PASS, no type errors, dry-run succeeds. Report the gzip bundle size next to the Task 3 Step 1 baseline.
