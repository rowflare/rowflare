# MCP server design

Date: 2026-10-13. Status: approved in conversation, awaiting written review.

Part 1 of 5 in the feature expansion (MCP, views, dashboards, automations, AI fields). Each part gets its own spec, plan and implementation.

## Goal

Let AI clients (Claude Code, Cursor, Claude Desktop, Codex and similar) read, write, restructure and summarize Rowflare bases through the Model Context Protocol, so a user can say "build me a CRM" or "how many deals closed per owner this month" and the AI does it directly.

## Scope

In scope (phase 1):

- Streamable HTTP MCP endpoint at `/mcp` on the existing Worker.
- Authentication with existing personal access tokens (Bearer header).
- Tools for reading, record writes, schema changes and aggregation (listed below).
- A `BaseStore.aggregate` method that later powers dashboards.
- Docs and tests.

Out of scope (phase 2, separate spec): OAuth 2.1 authorization server for claude.ai and ChatGPT web connectors. Phase 1 must not block it: unauthenticated requests return 401 with `WWW-Authenticate: Bearer`, and tool code only depends on a resolved user, never on how it was resolved.

## Approach

Official SDK `@modelcontextprotocol/sdk` (1.32.x) with `WebStandardStreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`). A new `McpServer` and transport are created per request, with tools registered in a closure that holds the authenticated user. No new Durable Object, binding or storage.

Rejected: Cloudflare `agents` `McpAgent` (adds a per-session Durable Object we do not need and ties us to a fast-moving 0.x framework), hand-written JSON-RPC (we would have to track protocol revisions ourselves).

## Routing and auth

- `POST /mcp` handles JSON-RPC. `GET` and `DELETE` return 405 (stateless mode has no server-initiated stream or session).
- `wrangler.jsonc` `assets.run_worker_first` gains `/mcp`.
- `/mcp` uses `ensureSchema` and `authenticate()` like `/api/*`, but accepts only `via === "token"`. A session cookie alone gets 401, which removes the CSRF surface.
- 401 responses carry `WWW-Authenticate: Bearer realm="rowflare"`.
- Per-base permission uses the existing `baseAccess(c, baseId, "read" | "write" | "admin")`. Viewer tokens see every tool; write tools return a clear permission error instead of being hidden, so the model does not get confused about what exists.
- Schema-changing tools need `write` (editor or owner), matching the web app.

## Code layout

New directory `src/worker/mcp/`:

| File | Responsibility |
| --- | --- |
| `server.ts` | Hono route for `/mcp`, auth, builds the `McpServer`, connects the transport |
| `tools-read.ts` | `list_bases`, `describe_base`, `query_records`, `get_records`, `aggregate` |
| `tools-write.ts` | `create_records`, `update_records`, `delete_records` |
| `tools-schema.ts` | table, field and view tools |
| `result.ts` | helpers for tool results (`ok(data)`, `fail(message)`), long-text truncation |

Shared with the REST API, extracted from `src/worker/api-v1.ts` into `src/worker/records.ts`: `tableOf`, `fieldsOf`, `resolveField`, `outValue`, `toRecord`, `inCells`, and the `filterByFormula` evaluation loop (as `filterIdsByFormula`). `api-v1.ts` imports them; its behavior must not change (existing API tests guard this). These helpers currently throw `HttpError`; they keep doing so, and the MCP layer converts `HttpError` into a tool error result.

Aggregation lives in the engine: `BaseStore.aggregate(tableId, input)` in `src/worker/base/store.ts` (or a new `src/worker/base/aggregate.ts` called from it if it exceeds about 100 lines), exposed as `BaseDO.aggregate` and added to `BaseStub` in `access.ts`.

## Tools

General rules:

- Every base-scoped tool takes `baseId`. Tables and fields accept id or name (exact, then case-insensitive), as in the REST API.
- Record output uses the REST API record shape: `{ id, createdTime, fields: { <field name>: value } }`.
- Results are returned as `structuredContent` plus the same JSON as a text block for clients without structured output support.
- Long text values over 2,000 characters are cut and suffixed with `… [truncated, N chars]`; `get_records` takes `fullText: true` to skip truncation.
- Tool annotations: read tools `readOnlyHint: true`; delete tools `destructiveHint: true`; others `destructiveHint: false`.

| Tool | Input | Output |
| --- | --- | --- |
| `list_bases` | none | `[{ id, name, workspace, permission: "read" \| "edit" \| "create" }]` |
| `describe_base` | `baseId` | tables with `id, name, primaryField, rowCount`, fields with `id, name, type, description` and simplified options, views with `id, name, type` |
| `query_records` | `baseId, table, filter?, formula?, sort?, view?, fields?, limit? (default 50, max 200), offset?` | `{ records, total, nextOffset? }` |
| `get_records` | `baseId, table, ids (1 to 100), fields?, fullText?` | `{ records }` |
| `aggregate` | `baseId, table, filter?, view?, groupBy? (0 to 2 fields), metrics (1 to 10)` | `{ groups: [{ key: [...], values: { <alias>: number } }], total }` |
| `create_records` | `baseId, table, records (1 to 200 of { fields }), typecast? (default true)` | `{ records }` |
| `update_records` | `baseId, table, records (1 to 200 of { id, fields }), typecast? (default true)` | `{ records }` |
| `delete_records` | `baseId, table, ids (1 to 200)` | `{ deleted: ids }` |
| `create_table` | `baseId, name, fields? (field specs)` | `{ table }` (described like `describe_base`) |
| `update_table` | `baseId, table, name?, primaryField?` | `{ table }` |
| `delete_table` | `baseId, table` | `{ deleted: tableId }` |
| `create_field` | `baseId, table, field spec` | `{ field }` |
| `update_field` | `baseId, table, field, name?, type?, options?, description?` | `{ field }` |
| `delete_field` | `baseId, table, field` | `{ deleted: fieldId }` |
| `create_view` | `baseId, table, name, type (grid \| kanban \| form), filter?, sort?, hiddenFields?, groupBy?` | `{ view }` |
| `update_view` | `baseId, table, view, name?, filter?, sort?, hiddenFields?, groupBy?` | `{ view }` |

### Structured filter

`filter` is `{ conjunction?: "and" | "or", conditions: [{ field, op, value? }] }` with `op` from the existing `FilterOp` set (`eq, neq, contains, ncontains, empty, notempty, gt, gte, lt, lte, anyOf, noneOf, allOf`). Field names are resolved to ids, select option names to choice ids, before calling `BaseDO.query`. This runs as SQL in the Durable Object and is the fast path.

`formula` is an Airtable formula evaluated like the REST API `filterByFormula` (row by row in the Worker). If both are given, `filter` narrows first, then `formula`. The tool description tells the model to prefer `filter`.

`sort` is `[{ field, direction?: "asc" | "desc" }]`.

### Field specs

`{ name, type, description?, options? }`, where `options` are friendly versions of `FieldOptions`:

- select: `choices: string[]` or `[{ name, color? }]`
- number: `precision, format (number | currency | percent), symbol`
- date: `includeTime`
- link: `linkedTable` (id or name)
- lookup and rollup: `linkField`, `targetField` (names or ids), `fn` for rollup
- formula: `formula` written with field names in braces, compiled to ids the same way the field editor does
- user: `multiple`

The tool translates to `FieldInput` / `FieldOptions` and lets `BaseStore` validate. Engine errors (`UserError`) come back as tool errors.

`describe_base` returns options in the same friendly form, so the model can round-trip them.

### Aggregate

Metrics: `{ fn: "count" | "countUnique" | "sum" | "avg" | "min" | "max" | "countEmpty" | "countFilled", field? , as? }`. `count` needs no field. `sum`, `avg`, `min`, `max` require a number, currency, percent, autonumber, rollup or formula field with a numeric result; `min`/`max` also accept date fields (returned as ISO strings).

Group keys:

- single select: option name; multiple select: a record counts once in each of its options; user: user name; link: linked record title (each link counts once); checkbox: true/false; date: the day (`YYYY-MM-DD`) by default, with optional `groupBy: [{ field, bucket: "day" | "week" | "month" | "year" }]`; anything else: the stored value as text; empty values group under `null`.
- At most 1,000 groups are returned, sorted by the first metric descending; `truncated: true` is set if more existed.

Implementation: reuse the query path (`filterSql`) to get matching ids, then stream rows in batches of 1,000 inside the Durable Object and fold into a map. No SQL `GROUP BY` on JSON, consistent with the engine rule of no expression indexes. Target: under 300 ms for 50,000 rows on the bench dataset; record the measured number in `docs/architecture.md`.

## Errors

- User-correctable errors (unknown table or field, bad option value, permission denied, trial ended, formula syntax) return a tool result with `isError: true` and a message that names the fix, e.g. `Unknown field "Statu" in table Tasks. Fields: Name, Status, Due, Owner`.
- `HttpError` and `UserError` map to tool errors with their message. HTTP status 402 and 403 keep their text.
- Input validation errors come from the SDK's zod schemas.
- Any other exception: tool error `Internal error`, details via `console.error`.
- Transport-level: missing or invalid token gives HTTP 401; non-POST gives 405.

## Dependencies

- `@modelcontextprotocol/sdk` pinned to an exact 1.32.x version.
- `zod` (peer of the SDK) pinned exactly.
- Check the bundle size after adding: `wrangler deploy --dry-run` output must stay under the Workers size limit; record the increase in the plan.

## Testing

- `test/worker/mcp.test.ts` (workerd integration, existing setup): connect with the SDK `Client` and `StreamableHTTPClientTransport` using a custom `fetch` that targets the worker. Cover initialize, `tools/list`, every tool's happy path, viewer token write rejection, missing token 401, session cookie without token 401, unknown field error text, formula filter, structured filter with select names, typecast creating a select option, `create_table` with link, lookup, rollup and formula fields in one call sequence.
- `test/worker/engine.test.ts`: `aggregate` cases for no grouping, single select, multiple select fan-out, link titles, date month buckets, empty group, numeric metrics on formula and rollup fields, filter plus group, the 1,000-group cap.
- `test/worker/api.test.ts` keeps passing unchanged after the helper extraction.
- Manual: `claude mcp add --transport http rowflare http://localhost:8787/mcp --header "Authorization: Bearer <token>"`, ask it to build a small CRM and report deals per stage.

## Docs

- New `docs/mcp.md`: what it does, creating a token, config snippets for Claude Code, Cursor and Claude Desktop, tool list, limits.
- README: add MCP to the feature list and link the doc.

## Success criteria

- An MCP client configured with a URL and a token can list bases, build a multi-table base with links and formulas, write and query records, and get grouped totals, with no manual steps in the web app.
- All existing tests pass; new tests pass.
- No change in REST API behavior.
