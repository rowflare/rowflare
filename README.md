# Rowflare

An open-source, Airtable-style database that runs on your own Cloudflare account. One base is one SQLite-backed Durable Object. Pay Cloudflare $5/month for the whole team instead of $20 or more per seat.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rowflare/rowflare)

[Rowflare Cloud](https://app.rowflare.com) · [Website](https://rowflare.com) · [Docs](docs/) · [REST API](docs/api.md) · [MCP](docs/mcp.md)

## Features

- **Grid, kanban, calendar, timeline, gallery and form views.** Grids group by up to 3 fields with per-group summaries; calendars show month and week with drag to reschedule; timelines plan work in lanes by start and end date or duration. Canvas grid with virtual scrolling, keyboard navigation, copy and paste with Excel and Google Sheets, drag to fill, column and row drag, filters, sorts, search, hidden fields, row heights.
- **20 field types:** single line text, long text, number (number, currency, percent), single select, multiple select, date (with or without time), checkbox, attachment, link to another record, lookup, rollup, formula, user, email, URL, phone, created time, last modified time, autonumber, button.
- **Airtable formula language** with 89 functions, validated as you type.
- **Real-time collaboration:** edits, new records and schema changes appear in every open browser; collaborators' cursors show as colored outlines.
- **Undo and redo** for edits, pastes, fills, moves, creates and deletes.
- **Import** from CSV (types inferred) or directly from Airtable with a personal access token: tables, fields, records, links, lookups, rollups, formulas and attachments.
- **Public forms** with a shareable link, no account needed.
- **REST API** modeled on the Airtable Web API, with personal access tokens.
- **Dashboards**: number, bar, line, pie and summary-table widgets over any table, a shared date range, and click-through to the records behind each number.
- **Automations**: run steps when records are created, change or start to match conditions, on a schedule, when a date is reached, when an app calls a webhook, or when someone clicks a button. Steps create, update and find records, send HTTP requests and email (Cloudflare Email Service, Resend or SMTP), with an if/otherwise branch, a run log, retries and loop protection.
- **AI fields**: fill text, choices, numbers, dates or checkboxes from a prompt over other fields and images, with your own key for Anthropic or any OpenAI-compatible service (OpenAI, DeepSeek, Qwen, Kimi, Zhipu, OpenRouter, Gemini, a local Ollama) or Workers AI. Cells update when their inputs change, generate in the background with retries, and can be regenerated or edited by hand. Automations get an "AI generate" step with text or JSON answers.
- **MCP server** at `/mcp` for Claude, Cursor and other AI clients: read, write, build tables and get grouped totals with a personal access token. See [docs/mcp.md](docs/mcp.md).
- **Workspaces and roles** (owner, editor, viewer) with unlimited members.
- **Email verification and password reset** through Cloudflare Email Service, Resend or SMTP.
- **Templates:** project tracker, CRM, content calendar, bug tracker, inventory.

Not in scope: interfaces and app builders, an AI chat assistant inside the app, bases over 125,000 rows.

## Self-hosting

You need a Cloudflare account on the **Workers Paid plan ($5/month)**. The free plan allows 10 ms of CPU per request and 5 million SQLite rows read per day, which a 50,000-row base exhausts with about 100 filters a day.

**One click:** use the Deploy button above. Cloudflare forks this repository into your GitHub or GitLab account and creates the Worker, the Durable Object namespace, a D1 database, an R2 bucket and an hourly cron. Open the deployed URL and sign up: the first account becomes the owner, everyone else joins by invite.

**From the command line:**

```sh
git clone https://github.com/rowflare/rowflare.git
cd rowflare
npm install
npx wrangler login
npm run deploy
```

**With Docker, on any server:** no Cloudflare account needed. The image runs the same Worker code in workerd, Cloudflare's open-source Workers runtime, with Durable Objects, D1 and R2 stored as local files in `/data`.

```sh
docker run -d --name rowflare -p 8787:8787 -v rowflare-data:/data ghcr.io/rowflare/rowflare:latest
```

Or use the [`docker-compose.yml`](docker-compose.yml) in this repository: `docker compose up -d`.

Settings, updates, backups and costs: [docs/self-hosting.md](docs/self-hosting.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODE` | `selfhost` | `selfhost`: first user owns the instance, invite-only after that. `cloud`: open sign-up. |
| `ALLOW_SIGNUP` | `false` | Let anyone who can reach the instance create an account. |
| `APP_URL` | | Public URL of the instance, used to build absolute links. |
| `BENCH_TOKEN` | | Enables the load-test endpoints used by `npm run bench`. Leave unset in production. |

## How it works

Each base lives in its own Durable Object with a private SQLite database: one physical table per user table, rows stored as JSON documents so field changes are instant, links in indexed pair tables, and lookups, rollups and formulas materialized and updated incrementally. Large recomputes run in 500-row batches from the object's alarm so they never block other users. Details and benchmark numbers: [docs/architecture.md](docs/architecture.md).

## Development

```sh
npm install
npm run build:web        # build the web app into dist/client
npx wrangler dev         # Worker + Durable Objects + D1 + R2 locally on :8787
npm run dev:web          # optional: Vite dev server on :5173 with hot reload, proxying /api to :8787
npm test                 # unit tests (formula engine) and Worker integration tests in workerd
npm run typecheck
```

Copy `.dev.vars.example` to `.dev.vars` to enable sign-up and the bench locally. The marketing site and docs site live in a separate repository, `rowflare-web`.

Layout:

```
src/shared/      types, cell coercion, formula engine, rollups (used by Worker and browser)
src/worker/      Worker routes, auth, billing, REST API, Base Durable Object, storage engine, Airtable import
src/web/         React app: grid, kanban, form views, record view, field editor, imports, settings
migrations/      D1 schema (applied automatically on first request)
test/            unit tests and Worker integration tests
bench/           load-test runner reproducing the 50k / 125k row benchmark
docker/          Docker entry point: runs the built Worker in workerd via Miniflare
```

## License and promise

Rowflare is licensed under the [GNU Affero General Public License v3.0](LICENSE). You can run it for any purpose, including commercially, on your own infrastructure. If you offer a modified version to others as a network service, you must publish your changes under the same license.

**Our promise: features that are open source today will never be moved into a paid tier.** There is no per-seat pricing and no SSO tax. Rowflare Cloud (hosted, flat price per workspace, unlimited members) and commercial licenses for closed-source embedding or white-labeling fund the project.

Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md). A [Contributor License Agreement](CLA.md) is required so that contributed code can also be offered under the commercial license.

Cloudflare is a trademark of Cloudflare, Inc. Rowflare is not affiliated with or endorsed by Cloudflare. Airtable is a trademark of its owner; Rowflare is not affiliated with Airtable.
