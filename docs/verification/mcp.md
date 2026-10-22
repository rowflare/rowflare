# MCP server: verification record

Date: 2026-10-13 (tests re-run with `npm run verify`). Feature: part 1 of the feature expansion; usage in [docs/mcp.md](../mcp.md).

## What was tested

- A stateless Streamable HTTP endpoint at `/mcp`, authenticated with personal access tokens only (session cookies and unknown tokens rejected).
- 20 tools: bases, records (query with structured filters or Airtable formulas, get, create, update, delete), tables, fields, views, grouped totals (`aggregate`) and dashboards.
- Tables, fields, select options and linked records addressed by name; filters checked against each field's type.
- Read-only access for workspace viewers; destructive tools marked as such.

## How

- Worker integration tests (Vitest in workerd with real Durable Objects) through the official MCP SDK client: tool listing and annotations, each read and write tool, a CRM built in one call with link, lookup, rollup and formula fields, filter validation, select-option renames, viewer refusals, bad tokens, and the engine's aggregate (grouping, multi-value fan-out, date buckets, rollups, filters, group cap).
- A manual JSON-RPC run with `curl` against `wrangler dev`.

## Results

Tests: 35 of 35 passed in 2 files (`npm run verify`, 2026-10-14).

Bench (local `wrangler dev`, Apple M5 Pro, Node v24.18.1, 50,000 rows; local numbers, not production):

| Action | ms |
| --- | --- |
| Group by a select field with count and sum (`aggregate`) | 205.63 |

Manual run against `http://127.0.0.1:8787/mcp` with `Authorization: Bearer <token>`:

| Scenario | What was checked | Result |
| --- | --- | --- |
| `tools/list` | 20 tools listed (16 from part 1 plus 4 dashboard tools) | Pass |
| `aggregate` | Deals by Stage with count and sum, keys as option names: Negotiation 8 / 192,500 ... Lost 2 / 72,500, total 30 | Pass |
| `get_dashboard` | Six widgets with table and field names and their current numbers | Pass |
| Worker size | `wrangler deploy --dry-run`: 1,813.52 KiB, 336.15 KiB gzip, under the 3 MiB Workers Free limit | Pass |

No screenshots: the MCP server has no UI.

## Known limits

- OAuth sign-in, which the claude.ai and ChatGPT web connectors need, is not supported yet; clients must send the token header.
- Results have no overall size cap (long lookup arrays, `fullText`).
- `create_table` does not de-duplicate field names, and without fields it adds 3 empty records.
- Select options that differ only in letter case map to the same option.
- Date buckets are computed in UTC; `bucket` on a non-date field is ignored.
