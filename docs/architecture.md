---
title: Architecture
description: How Rowflare stores a base in one SQLite-backed Durable Object, keeps lookups, rollups and formulas up to date, and pushes changes to every open browser.
order: 40
---

# Architecture

Rowflare is one Cloudflare Worker plus one Durable Object class.

```
browser ──HTTP──▶ Worker (auth, routing, REST API, assets) ──RPC──▶ Base Durable Object (one per base)
   ▲                         │                                         │  SQLite: tables, fields, views, rows
   └────── WebSocket ────────┴─────────────────────────────────────────┘  alarm: batch jobs
                             D1: users, workspaces, members, tokens      R2: attachments
```

- **Worker** (`src/worker/index.ts`): sessions and personal access tokens, workspaces and roles in D1, the REST API, file uploads to R2, public forms, the hosting extension point (see below), and the static web app.
- **Base Durable Object** (`src/worker/base-do.ts`, engine in `src/worker/base/store.ts`): owns all data of one base in its private SQLite database, applies every write, recomputes dependent fields, pushes changes to connected clients over WebSocket Hibernation, and runs long jobs from its alarm.
- **Web app** (`src/web`): React with Glide Data Grid (canvas, virtual scrolling) for the grid.

## Storage layout inside a base

| Rule | Why |
| --- | --- |
| One physical SQLite table per user table (`t_1`, `t_2`, ...) | A shared table with a `tbl` column made the query planner pick unrelated indexes and slowed filters 2 to 4 times in load tests. |
| Each row is a JSON document keyed by field id | Adding, renaming or deleting a field only changes metadata: no `ALTER TABLE`, no locking, no 100-column limit. Deleted fields leave keys behind that are ignored on read. |
| No expression indexes on the row JSON | They are rewritten on every write; in tests they tripled rows written and made full-column recomputes 3 times slower. |
| Manual order is a fractional index string with its own index | Dragging a row writes one row; the first page of a view is an index walk. |
| Links live in a pair table per link field (`l_1(a, b)`, indexed both ways) and are mirrored into both cells as `[{ id, t }]` | Reverse lookups ("which tasks point at this project?") use the index instead of scanning JSON. The cached title `t` is what the grid shows. |
| Lookups, rollups and formulas are materialized into the row | Reads are free; writes update only what depends on the change. |

## Keeping computed fields correct

A write goes through one transaction (`BaseStore.run`):

1. Coerce the incoming values to each field's stored form (`src/shared/cells.ts`). With `typecast`, unknown select options and linked records are created.
2. For link cells, diff old and new ids, update the pair table and patch the inverse cell on the other side.
3. Propagate: for every touched row, recompute local computed fields in dependency order (lookups and rollups depend on their link field, formulas on the fields they reference). Then follow incoming links: rows elsewhere whose lookups or rollups target a changed field, or whose link titles show a changed primary field, are queued and processed the same way. Cycles are rejected when a formula is saved.
4. Flush changed rows, then broadcast them to clients (or a "reload" hint when more than 500 rows changed).

Column-wide work (a new or edited formula, lookup or rollup; a field type conversion; renamed select options) is queued in a `_jobs` table. Tables up to 2,000 rows are processed inside the request. Larger tables are processed 500 rows per step from the Durable Object alarm, 4 steps per alarm, so other users' edits run between batches instead of waiting behind a multi-second rewrite. Durable Objects are single-threaded, so this batching is what keeps a 125,000-row base responsive.

## Formulas

`src/shared/formula` is a dependency-free parser and evaluator for Airtable's formula language (89 functions), shared by the server and the browser (the field editor validates as you type). Formulas are stored with field ids (`{fldXXXX}`) and shown with names, so renaming a field never breaks a formula. HyperFormula was not used because of its GPL / commercial license.

## Aggregation

`BaseStore.aggregate` (`src/worker/base/aggregate.ts`) answers grouped counts, sums, averages, minimums and maximums for the MCP `aggregate` tool. It reuses the view query (filters as SQL) for the matching ids, then folds rows in 1,000-row batches inside the Durable Object, so only the groups leave it. There is no SQL `GROUP BY` over the row JSON, for the same reason there are no expression indexes. Multi-value cells (multiple select, links, users) count a record once per value; at most 1,000 groups are returned.

Date windows (`QueryInput.range`) compute each record's span in SQL (the date part of the start; the end field, or start plus duration, as the end; an end before the start counts as the start) and keep the records that overlap the window, so calendars and timelines load only what is visible. Grid grouping orders rows by the group fields first and returns each row's group keys; group summaries use `aggregate` with `fanOut: false`, whose keys are the same text, so the client joins them to header rows directly.

Dashboards add four options to the same engine. `range` keeps records whose date (a date-only value as is, a value with a time by its UTC day) falls in a day window, with the SQL of the view date windows. `sort: "key"` orders groups by their keys (numbers by value, text and dates naturally, empty last) instead of by the first metric. `limit` keeps the first groups and, with `other`, folds the rest into one `"__other__"` group: counts and sums add, averages are recomputed from sum and count, minimums and maximums combine, and unique counts are left empty because they cannot be added up. Drill-down (`POST /api/bases/:base/aggregate/records`) walks the same ids and calls `Aggregator.keysOf`, the function that assigns a row to its groups, so the records listed are exactly the ones counted; it returns at most 500 ids.

Each base keeps the last 200 aggregate results in memory, keyed by table and the request with its keys sorted. Any row write (everything goes through `run()`), schema change or member change clears the whole cache, not just the written table: lookups, rollups and link titles make one table's numbers depend on others, and a base-wide reset is the rule that is always right. The cache lives in the Durable Object's memory only, so eviction just empties it.

## Real-time collaboration

Each browser opens a WebSocket to its base's Durable Object (Hibernation API, so idle connections cost no duration). Every write is broadcast with the author's client id; other clients patch their row cache and, when the view is filtered or sorted, re-run the view query after a short debounce. Cursor positions are relayed so collaborators show up as colored cell outlines. After a reconnect the client reloads the schema and open views.

Undo and redo are client-side command stacks: each edit records the previous values, deletes record full rows so they can be restored with the same ids and order keys.

## Automations

Automation definitions and runs live in the base's SQLite (`_automations`, `_auto_runs`), next to its tables. Definitions are not part of the schema that is broadcast to every open browser; editors fetch them separately, and the schema carries only the name and table of button automations.

- Detection: `BaseStore.run()` reports the rows a write touched directly, and record triggers are checked inside the same transaction, so a run is queued exactly when the write commits. Rows changed only as a side effect (a linked record's inverse link, a recomputed rollup) do not fire triggers. Imports, templates and background jobs do not fire them either.
- Execution: the Durable Object has one alarm, set to the earliest of pending background jobs, queued runs, retries, schedules and date triggers. Each alarm runs jobs, queues due schedules and date triggers, then executes runs for about 2 s; the rest wait for the next alarm, so edits are never blocked for long.
- Retries: network failures, timeouts, 5xx and 429 answers are retried after 10 s, 1 min and 5 min. Each step's result is saved as it finishes, so a retry, or a run cut off when the object was evicted, resumes at the step that did not finish. After 20 failed runs in a row an automation switches itself off and the base header shows a red dot.
- Plan limits: runs over the month's limit of the workspace's plan are recorded as skipped with that reason; editors can always switch automations off or delete them.
- Loops: writes made by a run carry the chain of automations that led to them. An automation never fires from a chain that already contains it, and chains stop at 5.
- Outbound safety: HTTP steps refuse localhost and private network addresses (unless `AUTOMATION_ALLOW_PRIVATE` is set), including host names that resolve to them in the Docker image (its server resolves every outgoing request; Cloudflare cannot reach private networks at all), do not follow redirects, time out after 10 s and read at most 1 MB. Header values that look like secrets are masked in the run log. Mail credentials are encrypted with `SECRET_KEY`.
- Writing a run does not prune history row by row: a write that queues many runs prunes once per automation, keeping 1,000 finished runs and 30 days.

## AI fields

AI settings live in `options.ai` of ordinary fields, so filters, sorts, dashboards, exports and the APIs treat AI values like any other value of the field's type. Services and monthly call counts are in D1 (`workspace_ai`, `ai_usage`), keys encrypted with `SECRET_KEY` and decrypted only right before a call.

- Queueing: the same `onWrite` hook that checks automation triggers runs inside each write's transaction and queues cells in `_ai_queue` when a record is created or a field named in a prompt changes, due 2 s later; another change in that time moves the due time instead of adding a call. A person typing into an AI cell marks it `edited` in `_ai_cells`, and it is not regenerated until someone chooses Regenerate. Imports, templates and background jobs queue nothing. Whole-column requests are one `INSERT ... SELECT`, so 100,000 rows queue in well under a second.
- Running: the alarm runs at most 6 model calls at once (the Workers limit on simultaneous outgoing connections) for about 25 s, then sets itself again. Each entry has a sequence number that changes whenever it is queued again; an answer is written only if its entry still has the number it started with and the record still exists, so edits, stops and deletes made during a call win. Inputs are hashed, and an unchanged input does not call the model again.
- Errors: 429, 5xx, timeouts and connection errors retry after 10 s, 1 min and 5 min (or `Retry-After`); 401 and 403 mark the service's key as rejected and make its other cells wait 10 minutes, until an owner saves a new key; other errors and answers that do not fit the field (an option that does not exist, text where a number belongs) show on the cell with the model's raw answer.
- AI fields that read other AI fields wait for them, and cycles are refused when a field is saved. Cell states travel with the rows (`row.ai`), progress per field in an `aiProgress` message.

## Hosting extensions and plan limits

Billing is not part of this repository. A hosted edition is a separate Worker project that imports this app, calls `extendApp(hosting)` at module load and re-exports the app's handler and `BaseDO`; the app and every Durable Object run in the same bundle, so both see it. A `Hosting` (`src/worker/hosting.ts`) supplies:

- `plan(env, workspaceId)`: the workspace's plan name and limits (bases, records per base, attachment bytes, automation runs per month per workspace or per base, Workers AI calls per month), cached for 60 seconds by the Worker and by each Durable Object; `BaseDO.planChanged()` drops a base's cache at once. When `plan` fails, a base keeps its last plan and asks again 10 seconds later.
- `routes(app)`: extra routes (checkout, payment webhooks, an admin page), which run after the auth middleware; `exemptPaths` lists prefixes that skip the `x-rf` header check, for webhooks from payment providers.
- `billing(env, workspaceId, userId)`: the content of Settings, Billing (plan, usage bars, buttons that open a URL or POST and follow the returned URL, notes). Without it the tab is hidden.
- `onWorkspaceCreated`, `beforeWorkspaceDeleted` (throw an `HttpError` to refuse, for example while a subscription is live) and `scheduled` hooks.

Self-hosted instances use `DEFAULT_HOSTING`: plan "Self-hosted" with only `AUTOMATION_MONTHLY_RUNS` per base and `AI_WORKERS_MONTHLY_CALLS`.

Counting and enforcing stays here, with the numbers from the plan:

- Bases: counted in D1 when a base is created (also from a template or an Airtable import).
- Records: the base's Durable Object checks its total row count in `createRows`, so one record, a paste, a CSV or Airtable import, an automation step, a form, the REST API and MCP are limited the same way; a write over the limit fails as a whole. Linked records that typecast creates count too (a field conversion leaves names unlinked past the limit, since its batches cannot be refused halfway). The app asks `POST /api/bases/:base/rows/check` before a CSV import or a paste that adds records, so those are refused before anything is written. The empty rows of a new table are not limited, so a full base can still get a table.
- Attachments: `workspace_storage` in D1. An upload checks and adds its size, and the base records the file with the size R2 reported (`_files`), since sizes in cells come from clients. The hourly cron recounts every workspace: a file counts once while any cell refers to it, and for a day after upload even if it was never attached. Removed files free space at the next recount; files no cell has used for a week are deleted from R2. Uploads made during a recount are kept.
- Automation runs: per base, the base's monthly counter; per workspace, `workspace_usage` in D1, written by each base's alarm about a second after runs are queued and read by a base with automations before each write, webhook and alarm. Runs that other bases queued in that last second are not seen yet, so a workspace can go slightly over. Runs over the limit are recorded as skipped.
- Workers AI: `ai_usage` in D1 against the plan's `workersAiCalls`.

Errors over a limit are `LimitError` (402 with `{ error, limit: { key, limit, upgradeUrl } }`); the app shows owners an Upgrade button (the plan's `upgradeUrl`, or the Billing tab) and tells other members to ask an owner. At 80% of any limit the home page shows a notice.

For local work, `DEV_TEST_HOSTING=true` in `.dev.vars` installs a test hosting with small limits and a fake Billing tab (`src/worker/dev-hosting.ts`); never set it in production.

## Account emails

Email verification and password reset use single-use tokens in `email_tokens` (stored as SHA-256 hashes; 24 hours for verification, 1 hour for reset; at most 5 emails per address per hour) and the instance's own mail: the `EMAIL` binding, or `MAIL_PROVIDER` with Resend or SMTP (the same Resend and SMTP code the automations use). A reset ends the account's other sessions.

## Performance

Measured through the load-test endpoints (`/api/_bench`) against the real engine: 50,000 rows, 15 fields (about 930 bytes per row as stored), 2,000 linked projects, a lookup, two rollups and a formula. Milliseconds per operation, timed in the Worker around the Durable Object call minus a no-op baseline.

| Action | Baseline from the 2026-10-12 prototype (production DO) | Rowflare engine, `wrangler dev` on a laptop (2026-10-13) |
| --- | --- | --- |
| Open a view: first page | 0.14 | 0.46 (first 300 ids + count; the full id list loads right after, 14) |
| Edit a cell + rollup update | 1.4 | 0.3 |
| Rename a record + lookup update | 2.3 | about 2 (23 linked rows rewritten) |
| Filter by any field | 74 | 58 |
| Sort by any field | 80 | 98 |
| Filter + sort | 155 | 85 |
| Kanban group counts | 125 | 81 |
| Group by a select field with count and sum (`aggregate`, used by MCP) | not measured | 328 (measured 2026-10-13 in a separate run where kanban group counts took 115) |
| Calendar month window: 6 weeks of a date field, 2,000 rows returned | not measured | 102 (2026-10-13; kanban group counts 81 in the same run) |
| Grid grouped by 2 fields with sum summaries (query plus two aggregates) | not measured | 743 (2026-10-13, same run) |
| Dashboard with 8 widgets (counts, sums, filters, month buckets, two-level groups, top 3 with Other, a year range), cache empty | not measured | 1,401 (2026-10-13; kanban group counts 65 in the same run) |
| The same dashboard, cached | not measured | 0.02 (2026-10-13, same run) |
| Full rollup recompute | 210 | 299 |
| Full formula column recompute | 575 | 306 |
| One 500-row recompute batch | not measured | 3 |
| Edit a cell + rollup update, with 3 record triggers on the table | not measured | 0.24 (2026-10-13; 0.20 without triggers in the same run) |
| Paste 1,000 rows and delete them | not measured | 24 (2026-10-13, same run) |
| The same paste with 3 record triggers (1,000 runs recorded) | not measured | 57 (2026-10-13, same run) |
| Execute 100 queued runs that read and update their record | not measured | 31 (2026-10-13, same run; kanban group counts 58) |

Local `wrangler dev` numbers are indicative only: clocks behave differently from production Durable Objects, where the in-object clock does not advance during synchronous SQL. Compare with the baseline column by running the same operations on a deployed Worker with the `BENCH_TOKEN` secret set.

Still to measure on production: cold start after eviction, queueing when many users edit one base at once, scroll frame rate of a 100,000-row grid, repeat runs across days and colos, and edit latency while a column recompute is running.

## Limits

- Designed for up to 50,000 rows per base (Airtable Team) with 125,000 rows supported (Airtable Business); ad hoc filters on 125,000 rows take roughly 0.4 to 0.8 s.
- A Durable Object holds up to 10 GB; attachments are stored in R2, not in the base.
- The Workers Paid plan is required: the free plan's 10 ms CPU per request and 5 million SQLite rows read per day are exhausted by about 100 filters a day on a 50,000-row base.
