# Verification records

How each Rowflare feature was tested and what came out, kept so the numbers and screenshots on the website can be traced to a run.

- `<feature>.md`: what was tested, how, the results and the known limits, one page per feature ([automations](automations.md), [dashboards](dashboards.md), [views](views.md), [MCP server](mcp.md), [AI fields](ai-fields.md), [plan limits and account emails](hosting.md), [email code sign-in](passwordless.md)).
- `results.json`: the same results in a form the website can import: `{ feature, title, date, tests: { files, total, passed, failed }, bench: [{ action, ms, rows, env }], scenarios: [{ name, checked, result, image }] }[]`. Tests that belong to no feature page are counted under `core`.
- `img/`: screenshots from the UI checks, 1440x900 with sample data, plus one phone-width shot per feature.

## Refreshing

- Tests: `npm run verify` runs the whole suite and rewrites the `date` and `tests` of every feature in `results.json`. `npm run verify -- --list` prints which tests count toward each feature (the mapping is in `scripts/verify.mjs`).
- Bench: `npm run dev`, then `BENCH_TOKEN=... npm run bench` (the token is in `.dev.vars`), and copy the rows into `results.json` and the feature pages.
- UI scenarios: by hand with Playwright against `wrangler dev`, checking the numbers shown against the API, then replacing the screenshots.

## Local numbers are not production numbers

Bench numbers recorded here come from `wrangler dev` on a laptop and say so in their `env`. Clocks behave differently in production Durable Objects (the in-object clock does not advance during synchronous SQL), so publish them as local measurements only, apart from any production run.
