# Automations design

Date: 2026-10-13. Status: approved in conversation, awaiting written review.

Part 4 of 5 in the feature expansion (MCP, views, dashboards, automations, AI fields).

## Goal

Let each base run automations like Feishu Bitable's: a trigger (record created, updated or newly matching, a schedule, a date reached, a webhook, or a button) followed by steps that create, update or find records, send HTTP requests or send email, with one level of if/else, a run history, retries and loop protection. It must behave the same on Cloudflare and in the Docker image.

## Scope

In scope:

- Triggers: record created; record updated (optionally only when given fields change, optionally only when conditions hold after the change); record matches conditions (false to true); schedule (every N hours, daily, weekly, monthly at a time in a time zone); date field reached (with an offset); incoming webhook; button field.
- Steps: create record, update records (the trigger record or records found by an earlier step), find records, HTTP request, send email, and one level of if/else branch.
- Templates such as `{{trigger.record.Name}}` in step values, picked through a variable picker.
- Email via the instance's Cloudflare Email Service binding ("system"), or per-workspace Resend or SMTP credentials.
- Run history with per-step input and output, retries of network steps, auto-disable after repeated failures, chain depth limit and duplicate protection, monthly run quota.
- Full-page editor with a flow view, test runs, the run log, the button field type, workspace mail settings.
- MCP tools for automations.

Out of scope (later): loops over records, delay steps, scripts, Slack, Feishu and WeCom bot steps, encrypted base-level secrets, triggers from indirect changes (rollups and lookups changed by writes to another table), form submission triggers.

## Approach

Everything runs inside the base's Durable Object. Trigger detection happens in the same transaction as the row write, runs are queued in the base's SQLite, and the existing alarm job loop executes them. The single alarm is set to the earliest of pending jobs, queued runs, retry times, schedule times and date-reached due times.

Rejected: Cloudflare Workflows for execution (the Docker image would depend on Miniflare's emulation, it adds billing and limits, and run history would live in two places); Cloudflare Queues plus cron (cron-level schedule precision, no Queues in Docker, ordering and retries still needed).

## Data model

### Automations

`_automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord TEXT NOT NULL, enabled INTEGER NOT NULL, config TEXT NOT NULL, created_by TEXT, updated_by TEXT, updated_at INTEGER, fail_streak INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT, next_at INTEGER, watermark INTEGER)` in the base's Durable Object. Ids use the prefix `aut`.

`config` is `{ trigger: Trigger; steps: Step[] }`.

Triggers:

- `recordCreated { tableId, conditions?: FilterSpec }`
- `recordUpdated { tableId, fieldIds?: string[], conditions?: FilterSpec }`: without `fieldIds`, any field change counts.
- `recordMatches { tableId, conditions: FilterSpec }`: fires when the conditions go from false to true for a row.
- `schedule { every: "hour" | "day" | "week" | "month", interval?: number, at: "HH:MM", weekday?: 0-6, monthday?: 1-31, tz: string }`: `interval` applies to `hour` (1 to 24). A `monthday` past the month's end runs on the last day.
- `dateReached { tableId, fieldId, offsetMinutes: number, at?: "HH:MM", tz: string, conditions?: FilterSpec }`: `at` is used for date-only fields.
- `webhook { token }`
- `button { tableId, viewerCanRun: boolean }`

Steps (each has `id` and `type`):

- `createRecord { tableId, values: Record<fieldId, Template> }`
- `updateRecords { target: "trigger" | stepId, tableId, values }`
- `findRecords { tableId, conditions: FilterSpec, sort?: SortSpec[], limit: 1-100 }`: text condition values may contain templates, for example to find the record whose email equals `{{trigger.body.email}}`.
- `http { method, url, headers: [name, Template][], body?: Template }`
- `email { provider: "system" | "resend" | "smtp", to, cc?, subject, body, format: "text" | "html" }`
- `branch { conditions: BranchCondition[], match: "all" | "any", then: Step[], else: Step[] }`: only at the top level; branches cannot contain branches. Branch conditions compare a template value with an operator and a value, so they can test values from earlier steps.

Templates:

- `{{trigger.record}}` (the record itself, for link fields), `{{trigger.record.<fieldId>}}`, `{{trigger.body.<path>}}` (webhook), `{{steps.<id>.records}}` and `{{steps.<id>.record}}` (for link fields), `{{steps.<id>.records[<n>].<fieldId>}}`, `{{steps.<id>.count}}`, `{{steps.<id>.status}}`, `{{steps.<id>.body.<path>}}` (HTTP), `{{now}}`, `{{automation.name}}`, `{{base.url}}`, `{{record.url}}`.
- Definitions store field ids, so renames do not break them; the editor shows names.
- Values render as display text: select option names, user names, linked record titles, dates as ISO, multiple values joined with ", ". A missing value renders as empty text. In record step values, a template that is the whole value keeps its type (a number stays a number, a linked record stays a link).

Conditions reuse `FilterSpec` and the `FilterEditor` component.

Limits: 50 automations per base, 25 steps per automation (branch steps included), 100 KB per definition.

### Runs

`_auto_runs (id INTEGER PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL, trigger_info TEXT NOT NULL, chain TEXT NOT NULL, steps TEXT NOT NULL, error TEXT, attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`, indexed on `(status, next_at)` and `(automation_id, id)`.

- `status`: `queued`, `running`, `waiting_retry`, `succeeded`, `failed`, `skipped`.
- `snapshot` is the automation's config when the run was queued; editing an automation does not change queued runs.
- `steps` holds each step's input, output, duration and result. Outputs over 8 KB are truncated; HTTP response bodies keep the first 4 KB. Mail credentials are never written.
- `chain` is the list of automation ids that led to this run.
- Retention: when a run is inserted, runs older than 30 days and runs past the newest 1,000 of that automation are deleted.

The month's run count is kept in the Durable Object's key-value storage as `autoUsage:<YYYY-MM>`.

### Mail credentials

D1 table `workspace_mail (workspace_id TEXT NOT NULL, provider TEXT NOT NULL, from_address TEXT NOT NULL, from_name TEXT, settings TEXT NOT NULL, secret_enc TEXT NOT NULL, last4 TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, provider))`. `settings` holds non-secret SMTP values (host, port, security, username). The secret (Resend key or SMTP password) is encrypted with AES-GCM under a key derived from the `SECRET_KEY` environment variable. Without `SECRET_KEY`, saving credentials fails with a message that says how to set it.

The system provider uses the `send_email` binding `EMAIL` and the `EMAIL_FROM` environment variable; it is offered only when both exist.

### Webhook

`POST /api/hooks/<baseId>/<token>`, token of 32 random characters, regenerable. JSON or form bodies up to 256 KB, exposed as `trigger.body`. Responds `202 { runId }` without waiting for the run.

### Button field

New field type `button` with options `{ label, color, automationId }`. It stores no data and exports as empty in CSV.

### HTTP secrets

Header values such as `Authorization` are stored in plain text in the definition and are visible to the base's editors. The editor says so next to the headers.

## Engine

### Trigger detection

- Writes from the UI, the REST API, MCP and automations fire triggers. CSV import and Airtable import do not.
- `recordCreated` and `recordUpdated` check conditions on the row after the write, when formula fields of that row are already computed.
- `recordMatches` evaluates the conditions before and after the write and queues only on false to true.
- Value changes caused indirectly by writes to another table (rollups, lookups) do not fire `recordUpdated` or `recordMatches` in this version.
- A write that touches many rows queues one run per row.
- Only rows the write touched directly are checked: inverse link cells and rollups updated in other rows do not count.
- Automation writes use typecast, so select option names and linked record names are matched (and created when missing), like the REST API with `typecast: true`.
- Runs are inserted in the same transaction as the write.

### Execution

- The alarm runs queued runs in order, for at most about 2 s of work per alarm, then sets the next alarm.
- Record steps call the store directly. Network steps time out after 10 s; a run is limited to 30 s in total.
- Automation writes use the actor "Automation: <name>" (user id `auto:<id>`), broadcast to clients like any write, and pass `chain` plus the automation id to the runs they trigger. A run is not queued when the chain already has 5 entries or already contains that automation; that skip is not logged as a run.
- Network failures (timeout, connection error, 5xx, 429) put the run in `waiting_retry` with retries after 10 s, 1 min and 5 min, resuming at the failed step so earlier writes are not repeated. Other 4xx responses fail the run at once.
- A failed run adds 1 to `fail_streak`; a successful one resets it. At 20 the automation is disabled and clients get a schema update that shows it in red.

### Schedules and date triggers

- `schedule` computes the next time in its time zone with `Intl` and stores it in `next_at`. A missed time (for example during a deploy) runs once on wake, not once per missed slot.
- `dateReached` keeps a watermark: on wake it queues rows whose due time lies after the watermark and at or before now, moves the watermark to now, and asks SQL for the next due time to set `next_at`. A date changed to a time already past does not fire.

### Outbound safety

- HTTP steps allow `http` and `https` only. `localhost` and private, loopback and link-local IP literals are refused unless `AUTOMATION_ALLOW_PRIVATE=true` (Workers on Cloudflare cannot reach private networks anyway; the check matters for the Docker image). Host names that resolve to private addresses are not checked. Redirects are not followed; a 3xx response is returned as it is. Responses are read up to 1 MB. Header values named Authorization, Cookie or containing "key" or "token" are masked in the run log.
- Email allows up to 50 recipients per message.
- The Durable Object reads the workspace's mail row from D1 and decrypts it only when sending.
- SMTP connects with `cloudflare:sockets`, with STARTTLS or TLS on port 465.

### Quotas and rate limits

- Runs per base per month: 10,000 by default, `AUTOMATION_MONTHLY_RUNS` overrides it, `0` means no limit. Over the quota, new runs are stored as `skipped` with the reason, and the editor shows a banner.
- Webhooks: 60 requests per minute per base, then 429.
- System email in cloud mode: 100 messages per workspace per day.

### Test runs

Test runs use a chosen record or sample data and the same executor. They do not count against the quota, do not trigger other automations, return the step results to the editor and are stored as runs with `test = 1`. Their writes are real, and the editor says so before running.

## Client

- The base header gets an "Automations" button (bolt icon) with a red dot when an automation is disabled by failures. Route: `/base/:id/automations/:autoId?`.
- Left: the automation list with name, toggle, trigger icon, last run time and status, a "New" button and a few templates (email when status becomes Done, weekly webhook summary, and so on).
- Middle: the flow, with the trigger card on top, step cards below, "+" between cards, and branch cards split into "If" and "Otherwise" columns. At phone width, a read-only single column.
- Right: settings of the selected card. Every template input has "Insert variable", which lists fields grouped by trigger record and step. Inputs show references with names, such as `{{Trigger record.Stage}}`, and the editor converts them to ids when saving.
- "Test run" picks a record, runs, and shows each card's input, output and result.
- "Runs" tab: newest first, filter by status, step details, and "Run again" on failed runs, which resumes at the failed step.
- Workspace settings get a "Sending email" section for owners: system (when configured), Resend or SMTP, a "Send test email" button, saved secrets shown by their last 4 characters.
- Button field: type "Button" in the field menu, bound to an automation with a button trigger. Clicking shows a spinner, then success or the error.

## API

- Automation ops through `POST /api/bases/:base/automations` (editors and owners): `create`, `update`, `delete`, `setEnabled`, `regenerateWebhook`. `GET /api/bases/:base/automations` lists them with their last run and the month's usage. Validation errors return 400: unknown trigger or step type, unknown table or field ids, nested branches, over the limits, invalid time zone or time, `updateRecords` targeting a step that is not an earlier `findRecords` or `createRecord`.
- `POST /api/bases/:base/automations/:id/test` (write), `POST /api/bases/:base/automations/:id/run` (button: write, or read when `viewerCanRun`), `GET /api/bases/:base/automations/:id/runs` (write), `POST /api/bases/:base/runs/:runId/retry` (write).
- `POST /api/hooks/:baseId/:token`, no session.
- `GET` and `PUT /api/workspaces/:ws/mail`, `POST /api/workspaces/:ws/mail/test` (owner).
- Automation definitions are not part of the schema, because the schema is broadcast to every connected member. Editors fetch them with the endpoint above and refetch when the Durable Object sends an `automations` message. The schema carries only `buttons: { id, name, tableId, viewerCanRun, enabled }[]` for automations with a button trigger, which the button field needs. Webhook tokens go to editors and owners only.

## MCP

- `list_automations`: id, name, enabled, trigger type, last run.
- `get_automation`: the definition with names instead of ids, and the last 20 runs.
- `create_automation`, `update_automation`: described with table and field names. New automations are disabled unless `enabled: true` is passed.
- No tool runs automations, so the button permission cannot be bypassed.

## Error handling

- A step that refers to a deleted table or field fails with "The field X no longer exists" and the editor marks the card.
- A missing template value renders as empty text, and the run's step input shows it.
- Mail without a configured provider fails with "Email sending is not set up for this workspace".
- Quota, rate limit and loop skips have their own messages.

## Testing

- Unit (node): template rendering (missing values, multiple values, dates, typed whole-value templates), next schedule time (time zones, DST changes, the 31st, leap years), date watermark windows, before and after condition comparison, the SMTP dialogue against a fake socket, encryption round trip, private address detection.
- Worker integration (workerd): each trigger queues runs, imports do not, the chain stops at 5, A and B triggering each other stop, retries resume at the failed step, 4xx does not retry, auto-disable at 20 failures, edits do not change queued runs, run retention, the monthly quota, webhook auth, rate limit and body size, button permissions, viewers do not see definitions, test runs skip the quota, the three mail providers' requests (fake fetch and binding), the MCP tools.
- UI, manually with the Playwright MCP against `wrangler dev`: "when Stage becomes Won, send an HTTP request" to a local receiver, then checking what it received and the run log; a schedule with a short interval; a webhook creating a record with curl; the button field; a test run; a failure and retry; phone width. Screenshots for each.
- Bench: extra time of a single-row edit on a 50,000-row table with 3 record triggers; queueing for a 1,000-row paste; one alarm executing 100 runs.

## Verification record

`docs/verification/automations.md`, screenshots in `docs/verification/img/automations-*.png`, an `automations` entry in `results.json`, and an automations mapping in `scripts/verify.mjs`.

## Success criteria

- With 3 record triggers, a single-row edit takes at most 5 ms longer (local bench).
- The median time from a record edit to the HTTP request going out is under 2 s.
- All existing tests pass.
- Docker and `wrangler dev` behave the same, except system email, which exists only on Cloudflare.
