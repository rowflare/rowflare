---
title: REST API
description: Read and write records over HTTP with personal access tokens. Modeled on the Airtable Web API so existing scripts port with small changes.
order: 30
---

# REST API

The REST API lives under `/api/v1` on your Rowflare instance. It is modeled on the Airtable Web API: the same record shape (`id`, `createdTime`, `fields`), field names as keys, `typecast`, `filterByFormula`, `sort`, `view`, `pageSize` and `offset`.

An OpenAPI 3.1 description of these routes is at [rowflare.com/openapi.json](https://rowflare.com/openapi.json) (also `docs/openapi.json` in the repository).

## Authentication

Create a personal access token in **Settings, API tokens**. Send it as a bearer token:

```sh
curl -H "Authorization: Bearer $ROWFLARE_TOKEN" https://rowflare.example.com/api/v1/bases
```

A token acts as the user who created it, with that user's role in each workspace (viewer tokens can read but not write). Tokens are stored hashed; you see the value once. Delete a token to revoke it.

## Bases and schema

`GET /api/v1/bases`

```json
{ "bases": [{ "id": "appXXXXXXXXXXXXXXXX", "name": "Project tracker", "permissionLevel": "edit" }] }
```

`GET /api/v1/bases/{baseId}/tables` returns every table with its fields (`id`, `name`, `type`, `options`) and views.

## Records

Tables can be addressed by id (`tbl...`) or by name (URL-encoded). Record ids are integers.

### List records

`GET /api/v1/{baseId}/{table}`

| Parameter | Meaning |
| --- | --- |
| `pageSize` | 1 to 100, default 100 |
| `offset` | Value of `offset` from the previous page |
| `maxRecords` | Stop after this many records |
| `view` | View id or name: applies its filters and sorts |
| `sort[0][field]`, `sort[0][direction]` | Sort by field name or id, `asc` or `desc`; add `sort[1]...` for more |
| `filterByFormula` | A formula; records where it is truthy are returned |
| `fields[]` | Only return these fields (repeatable) |
| `returnFieldsByFieldId` | `true` to key fields by id instead of name |

```sh
curl -G -H "Authorization: Bearer $ROWFLARE_TOKEN" \
  "https://rowflare.example.com/api/v1/$BASE/Tasks" \
  --data-urlencode 'filterByFormula=AND({Status} = "Done", {Estimate} > 5)' \
  --data-urlencode 'sort[0][field]=Due' --data-urlencode 'pageSize=50'
```

```json
{
  "records": [
    { "id": 17, "createdTime": "2026-10-13T01:57:43.000Z", "fields": { "Name": "Ship landing page", "Status": "Done", "Estimate": 8 } }
  ],
  "offset": "50"
}
```

### Get one record

`GET /api/v1/{baseId}/{table}/{recordId}`

### Create records

`POST /api/v1/{baseId}/{table}` with up to 1,000 records:

```json
{ "records": [{ "fields": { "Name": "From the API", "Status": "Review", "Project": ["Website relaunch"] } }], "typecast": true }
```

A body of `{ "fields": {...} }` creates one record and returns it directly.

### Update records

`PATCH /api/v1/{baseId}/{table}` with `{ "records": [{ "id": 17, "fields": {...} }] }`, or `PATCH /api/v1/{baseId}/{table}/{recordId}` with `{ "fields": {...} }`. Fields you leave out are unchanged. `PUT` works the same but clears every writable field you leave out.

### Delete records

`DELETE /api/v1/{baseId}/{table}?records[]=17&records[]=18` or `DELETE /api/v1/{baseId}/{table}/{recordId}`.

## Cell values

| Field type | Read | Write |
| --- | --- | --- |
| Single line text, long text, email, URL, phone | string | string |
| Number | number | number, or a numeric string with `typecast` |
| Checkbox | `true` or absent | boolean |
| Date | `"2026-10-13"` or an ISO datetime when the field includes time | ISO string; with `typecast`, common formats like `10/13/2026` |
| Single select | option name | option name; with `typecast`, unknown names create the option |
| Multiple select | array of option names | array of names (or a comma-separated string with `typecast`) |
| Link to another record | array of record ids | array of record ids; with `typecast`, primary field values, and unknown values create linked records |
| Attachment | array of `{ id, filename, size, type, url }` | upload in the app; the API does not accept files yet |
| User | `{ id, email, name }` (array when multiple) | user id or email of a workspace member |
| Lookup, rollup, formula, created time, last modified time, autonumber | computed value | read-only: writing returns 422 |

Empty cells are omitted from `fields`, as in Airtable.

## Automations

These routes use the session of a signed-in editor or owner (the same requests the automations page makes), not a personal access token. Definitions are stored with table and field ids; see [the MCP tools](mcp.md#automations) to create them by name.

| Route | What it does |
| --- | --- |
| `GET /api/bases/:base/automations` | The automations, each with its last run, and `usage: { used, limit }` for this month |
| `POST /api/bases/:base/automations` | One operation: `{ "op": "create", "name", "config", "enabled"? }`, `{ "op": "update", "id", "name"?, "config"? }`, `{ "op": "delete", "id" }`, `{ "op": "setEnabled", "id", "enabled" }` or `{ "op": "regenerateWebhook", "id" }` |
| `GET /api/bases/:base/automations/:id/runs` | Runs, newest first, 50 per page; `?status=failed` filters, `?before=<run id>` pages |
| `POST /api/bases/:base/automations/:id/test` | Runs the automation once with `{ "recordId" }` or a sample `{ "body" }`; writes are real, other automations are not triggered, the run does not count toward the monthly limit |
| `POST /api/bases/:base/automations/:id/run` | Runs a button automation for `{ "recordId" }` and answers with `{ id, status, error }`; viewers may call it when the automation allows them |
| `POST /api/bases/:base/runs/:runId/retry` | Queues a failed run again with the automation as it is now (so a fixed step applies); it resumes at the step that failed |

### Webhooks

An automation with the trigger "When a webhook is called" gets a URL with a secret token: `POST /api/hooks/:baseId/:token`. The token is the credential, so no session or API token is needed, and regenerating it from the automation's menu stops the old URL.

- The body may be JSON or a form (`application/x-www-form-urlencoded`), up to 256 KB. Steps read it as `{{trigger.body.<path>}}`.
- The answer is `202 { "runId": 42 }` right away; the run happens in the background and shows in the run log. Once a run has succeeded, the log keeps the first 8 KB of a larger body.
- 400 for a body that is not valid JSON, 404 for an unknown token or a switched off automation, 413 for a body over 256 KB, 429 after 60 calls in a minute for one base.

```sh
curl -X POST https://rowflare.example.com/api/hooks/appXXXXXXXX/TOKEN \
  -H "Content-Type: application/json" \
  -d '{"name": "Ada Lovelace", "email": "ada@example.com"}'
```

## AI fields

An AI field is a text, long text, single select, multiple select, number, date or checkbox field with `options.ai` (`serviceId`, `model`, `prompt` with field ids in braces such as `{fldXXXX}`, `imageFieldIds`, `autoUpdate`). Records return its values like any other field of that type. These routes take a session or a personal access token:

| Route | What it does |
| --- | --- |
| `GET /api/bases/:base/ai-services` | The workspace's AI services: `{ id, name, kind, model, keyRejected, calls }`, never keys |
| `GET /api/bases/:base/tables/:table/ai/:field` | Progress and problems: `{ queued, done, total, missing, broken, errors: [{ rowId, error }] }` (first 100 errors) |
| `POST /api/bases/:base/tables/:table/ai/:field/generate` | `{ "rowIds": [...] }` (at most 5,000), `{ "missingOnly": true }` (records never generated and still empty), or `{}` for the whole column; answers `{ queued }` right away and generates in the background |
| `POST /api/bases/:base/tables/:table/ai/:field/stop` | Removes the field's queued cells; answers of calls already running are dropped |
| `POST /api/bases/:base/ai/preview` | `{ tableId, rowId, field: { type, options } }`: runs a field as it would be saved on one record and returns `{ answer, value, error?, prompt, cut }` without writing; counts as one call |

Services themselves are managed in the web app (`/api/workspaces/:ws/ai-services`, owners only).

## Errors

Errors return JSON `{ "error": "message" }` with status 400 (bad request), 401 (missing or bad token), 403 (no permission), 404 (unknown base, table or record), 402 (a plan limit was reached, with a `limit` object; see below) or 422 (invalid field or value).

## Plan limits

Self-hosted instances have no plan limits apart from `AUTOMATION_MONTHLY_RUNS` and `AI_WORKERS_MONTHLY_CALLS`. A hosted edition can set limits per workspace (bases, records per base, attachment storage, automation runs and Workers AI calls per month). A write that would go over one fails as a whole with status 402:

```json
{ "error": "This plan allows 1,000 records per base; 12 more can be added", "limit": { "key": "records", "limit": 1000, "upgradeUrl": "https://..." } }
```

`key` is one of `bases`, `records`, `attachments`, `automationRuns`, `workersAiCalls`. New linked records created by `typecast` count as records. Limits never delete or hide data: over a lowered limit, records stay readable and editable, and deleting records frees room at once. Automation runs over the limit do not fail a request; they are recorded as skipped.

The app's own API (session cookie) has `GET /api/workspaces/{workspaceId}/usage`, which returns the plan and the usage against each limit (`limit` is null when there is none):

```json
{ "plan": { "name": "Self-hosted", "paid": true }, "usage": [{ "key": "bases", "label": "Bases", "used": 4, "limit": null }, { "key": "automationRuns", "label": "Automation runs this month in the busiest base", "used": 120, "limit": 10000 }] }
```

## Account routes

Used by the app's login pages (JSON bodies; they need no token):

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/auth/forgot` | `{ "email" }` | Always `{ "ok": true }`; mails a reset link when the account exists. 400 "Email is not set up on this instance" without account emails. |
| `POST /api/auth/reset` | `{ "token", "password" }` | Sets the password (8 characters or more), ends the account's other sessions and signs this browser in. 400 for an unknown, used or expired link. |
| `POST /api/auth/verify` | `{ "token" }` | Confirms the email address. |
| `POST /api/auth/verify/resend` | none (signed in) | Mails a new confirmation link; 429 after 5 emails to the address in an hour. |

`GET /api/auth/me` returns `user.emailVerified`, and `GET /api/config` returns `accountMail` (whether the instance can send these emails).

## Limits

- Up to 1,000 records per write request, 100 per page when listing.
- `filterByFormula` is evaluated over the whole table (or view), so it reads every row: fine for tens of thousands of rows, but prefer a view with filters for frequent queries on large tables.
- Every request is handled by the base's Durable Object, which processes requests one at a time; a single base comfortably handles hundreds of requests per second for small writes.
