---
title: MCP server
description: Connect Claude, Cursor and other AI clients to your bases over the Model Context Protocol to read, write, build tables and get grouped totals.
order: 35
---

# MCP server

Every Rowflare instance serves a Model Context Protocol endpoint at `https://<your instance>/mcp`. It uses the Streamable HTTP transport and authenticates with personal access tokens, so any MCP client that can send a header can read and write your bases, create tables and fields, and ask for grouped totals without downloading every record.

## Create a token

Open **Settings, API tokens** and create a token. It acts as you: in workspaces where you are a viewer, only the read tools succeed; write and schema tools return a "read-only access" error. Delete the token to revoke access.

## Connect a client

Claude Code:

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

## Tools

Tables, fields, views and select options are addressed by name (case-insensitive) or id. Records come back in the same shape as the [REST API](api.md): `{ id, createdTime, fields }` keyed by field name.

| Tool | What it does | Destructive |
| --- | --- | --- |
| `list_bases` | Bases you can access, with workspace and permission | |
| `describe_base` | Tables, fields (type and options), primary field, row counts and views | |
| `query_records` | Filter (structured or Airtable formula), sort, view, field subset, paging | |
| `get_records` | Records by id | |
| `aggregate` | count, countUnique, countEmpty, countFilled, sum, avg, min, max, grouped by up to 2 fields (dates by day, week, month or year, in `timezone` when given) | |
| `create_records` | Create records; select options and linked records can be given by name | |
| `update_records` | Change fields of existing records | |
| `delete_records` | Delete records | yes |
| `create_table` | New table with any field types, including links, lookups, rollups and formulas in one call | |
| `update_table` | Rename, change the primary field | |
| `delete_table` | Delete a table and the links that point at it | yes |
| `create_field` | Add a field | |
| `update_field` | Rename, change type, options or description; rename a select option with `{ "name": "New", "renameFrom": "Old" }` | yes (options left out of a select list are cleared from cells) |
| `delete_field` | Delete a field and its values | yes |
| `create_view` | Grid, kanban, calendar, timeline, gallery or form view with filter, sort, hidden fields, grouping (up to 3 levels in grids), date fields, lanes and card cover | |
| `update_view` | Change a view's name, filter, sort, hidden fields or type-specific settings | |
| `list_dashboards` | Dashboards of a base with their widget counts | |
| `get_dashboard` | A dashboard's widgets with their settings (table and field names) and each widget's current numbers over all time | |
| `create_dashboard` | New dashboard, optionally with widgets | |
| `update_dashboard` | Rename a dashboard; add, change, move or remove widgets | yes (`remove` deletes widgets) |
| `list_automations` | Automations of a base with their trigger type, whether they are on, and their last run (editors and owners) | |
| `get_automation` | An automation's trigger and steps with table and field names, its webhook URL, and its last 20 runs | |
| `create_automation` | New automation from a trigger and steps; starts switched off unless `enabled` is true | |
| `update_automation` | Rename, switch on or off, or replace the trigger or the steps | yes (replaced steps are gone) |
| `list_ai_services` | The workspace's AI services (name, kind, model), for AI fields and AI automation steps | |
| `generate_ai_field` | Queue AI generation for some records, the records never generated (`missingOnly`), or the whole column of an AI field | |

### AI fields

`create_table`, `create_field` and `update_field` take an `ai` option on text, longText, singleSelect, multiSelect, number, date and checkbox fields: `{ "service": "DeepSeek", "prompt": "Summarize {Notes} in one sentence", "model"?, "imageFields"?: ["Photo"], "autoUpdate"?: true }`. The service is a name or id from `list_ai_services`; the prompt refers to fields by name in braces. `describe_base` shows the same shape. Values are generated in the background: new records and changed inputs queue automatically, and `generate_ai_field` fills existing records.

### Dashboard widgets

A widget in `create_dashboard` and `update_dashboard` has a `type` (`metric`, `bar`, `line`, `pie`, `pivot`, `text`) and these settings, all by name:

- Source: `table`, `view` (its filter applies), `filter` (same shape as `query_records`), `dateField` (the field the dashboard's date range applies to).
- `metric`: `{ fn, field }` with `fn` one of count, countUnique, countEmpty, countFilled, sum, avg, min, max; `count` needs no field. `compare` on a metric card shows the change against the previous period.
- Bar and line: `x` (category or date field), `bucket` (day, week, month or year for a date `x`; month by default), `series`, `stacked`, `horizontal` (bar), `area` (line), `sort` (`value` or `key`), `limit`.
- Pie: `group`, `bucket`, `donut`, `limit` (default 10; the rest is shown as "Other").
- Pivot: `rows`, `columns`, `rowBucket`, `columnBucket`.
- Text: `text` (Markdown, at most 20 KB).
- `title`, and `position` `{ x, y, w, h }` on a 12-column grid (`w` and `h` 1 to 12). Without a position a widget goes below the others.

`update` items carry the widget `id` from `get_dashboard` and change only the settings they name. `get_dashboard` returns each widget's numbers (at most 100 groups per widget) and a `problem` when a widget's table, view or field was deleted or is not set up yet.

### Automations

Triggers and steps name tables and fields, the same as the other tools:

- Triggers: `recordCreated`, `recordUpdated` (`watch` limits it to some fields), `recordMatches` (fires when a record starts to match `filter`), `schedule` (`every` hour, day, week or month, `at`, `weekday`, `monthday`, `timezone`), `dateReached` (`dateField`, `offsetMinutes`, `at`, `timezone`), `webhook` and `button` (`viewerCanRun`).
- Steps run in order: `createRecord`, `updateRecords` (`target` is `trigger` or the id of an earlier find or create step), `findRecords` (`filter`, `sort`, `limit`), `http` (`method`, `url`, `headers`, `body`), `email` (`provider` system, resend or smtp, `to`, `cc`, `subject`, `body`, `format`), `ai` (`service` id from `list_ai_services`, `model`, `prompt`, `output` text or json; the answer is `{{steps.<id>.text}}` or `{{steps.<id>.json.<key>}}`) and `branch` (`match`, `conditions`, `then`, `else`, one level).
- Templates use field names: `{{trigger.record.Name}}`, `{{trigger.record}}` (the record itself, for link fields), `{{trigger.body.email}}` (webhooks), `{{steps.s1.records[0].Name}}`, `{{steps.s1.count}}`, `{{steps.s2.body.id}}`, `{{now}}`, `{{record.url}}`. They are stored with field ids, so renaming a field does not break them.
- Steps get ids `s1`, `s2`, ... in order unless you give them one.
- New automations start switched off unless `enabled` is true. No tool runs an automation; buttons keep their own permission.

```json
{
  "baseId": "app...",
  "name": "Won deals",
  "trigger": { "type": "recordMatches", "table": "Deals", "filter": { "conditions": [{ "field": "Stage", "op": "eq", "value": "Won" }] } },
  "steps": [
    { "type": "http", "method": "POST", "url": "https://example.com/won?deal={{trigger.record.Name}}", "headers": { "X-Source": "rowflare" } },
    { "type": "createRecord", "table": "Companies", "values": { "Name": "From {{trigger.record.Name}}" } }
  ]
}
```

Writes use `typecast` by default: unknown select options are created and linked records are matched by their primary field (and created if missing), the same as the REST API with `typecast: true`.

## Limits

- `query_records`: 50 records per call by default, at most 200; use `nextOffset` to page.
- `get_records`: 1 to 100 ids.
- `create_records`, `update_records`, `delete_records`: 1 to 200 records per call.
- Filters: each operator is checked against the field type (for example `contains` is rejected on a single select; use `anyOf`), value lists hold at most 50 items, and link fields filter by record id or by name with `contains`.
- `aggregate`: up to 2 group fields, 1 to 10 metrics, at most 1,000 groups (the result says `truncated` when there were more).
- Dashboards: at most 30 widgets each.
- Automations: at most 50 per base and 25 steps each.
- Long text values are cut at 2,000 characters in results; `get_records` with `fullText: true` returns them whole.
- Lists in one cell (lookups, links, multiple selects) are cut at 100 items, and one answer holds about 150,000 characters of records: `query_records` then returns fewer records with `nextOffset`, and `get_records` lists the ids that did not fit in `omitted`.

## Not yet supported

Signing in with OAuth, which the claude.ai and ChatGPT web connectors require, is planned. Until then, use a client that lets you set the `Authorization` header.
