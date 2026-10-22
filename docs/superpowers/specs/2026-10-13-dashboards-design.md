# Dashboards design

Date: 2026-10-13. Status: approved in conversation, awaiting written review.

Part 3 of 5 in the feature expansion (MCP, views, dashboards, automations, AI fields).

## Goal

Give each base dashboards like Feishu Bitable's: pages next to the tables that sum up data from any table in the base with metric cards, charts and summary tables, filtered by a shared date range, with click-through to the records behind each number.

## Scope

In scope:

- Base-level dashboards (a tab next to the tables), each with widgets from any table of the base.
- Widget types: metric card (with optional comparison to the previous period), bar (stacked, horizontal), line (area), pie and donut, pivot table (1 or 2 group fields), text block (Markdown).
- Per-widget source: table, optional view (its filters apply), extra filters, optional date field for the global date range.
- Global date range per viewer: all time, this week, this month, this quarter, this year, last 7 days, last 30 days, custom.
- Drill-down from any chart element, pivot cell or metric card to the list of records, which open in the record modal.
- 12-column layout with drag and resize in edit mode; one column below 768 px.
- Live refresh when data in a widget's table changes.
- MCP tools for dashboards.

Out of scope (later): public share links, PNG/PDF/CSV export, global filters on fields other than dates, cross-filtering between widgets, scatter, funnel, gauge and dual-axis charts, dashboard-as-view.

## Approach

Charts are drawn with ECharts 6.1.0, imported modularly (`echarts/core` plus bar, line and pie charts, tooltip, legend, grid and dataset components, and the canvas renderer) and loaded lazily with the dashboard page, so table pages do not load it. Layout uses react-grid-layout 2.2.4 (2.3.0 is less than two weeks old). All numbers are computed in the base's Durable Object by the existing aggregate engine; only results reach the browser.

Rejected: Recharts (SVG gets slow at a year of daily points times several series, and theming is manual), hand-written SVG (two to three times the work for axes, time scales, stacking, tooltips and legends).

## Data model

`src/shared/types.ts`:

- `Schema` adds `dashboards: Dashboard[]`.
- `Dashboard { id: string; name: string; ord: string; widgets: Widget[] }`.
- `WidgetType = "metric" | "bar" | "line" | "pie" | "pivot" | "text"`.
- `Widget` common keys: `id`, `type`, `title`, `x`, `y`, `w`, `h` (grid units, `w` 1 to 12, `h` 1 to 12, `x + w <= 12`), `tableId?`, `viewId?`, `filters?: FilterSpec`, `dateFieldId?`.
- Type-specific keys:
  - metric: `metric: { fn: AggFn; fieldId?: string }`, `compare?: boolean`.
  - bar and line: `xFieldId`, `bucket?: DateBucket` (date x fields), `seriesFieldId?`, `metric`, `stacked?`, `horizontal?` (bar), `area?` (line), `sort?: "value" | "key"`, `limit?`.
  - pie: `groupFieldId`, `metric`, `donut?`, `limit?` (the rest merged into "Other").
  - pivot: `rowFieldId`, `colFieldId?`, `rowBucket?`, `colBucket?`, `metric`.
  - text: `text` (Markdown, at most 20 KB).
- Storage: `_dashboards (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord TEXT NOT NULL, config TEXT NOT NULL)` in the base's Durable Object; `config` holds `{ widgets }`.

Schema ops (viewers cannot run them): `createDashboard`, `updateDashboard` (name, ord), `deleteDashboard`, `addWidget`, `updateWidget` (merges a patch into one widget), `removeWidget`, `setLayout` (positions of several widgets). Because edits are per widget and merged in the Durable Object, two editors changing different widgets do not overwrite each other.

Validation (400 on failure): unknown widget type, positions out of range, more than 30 widgets on a dashboard, text over 20 KB, unknown table or field ids at write time, metric functions that do not fit the field (the same rules as `validateAggregate`).

Deleting a table or field does not delete widgets; a widget whose table or field is gone, or whose field no longer fits its metric, renders a "data source changed" state.

## Engine

`AggregateInput` gains:

- `range?: { fieldId: string; from: string; to: string }`, days `YYYY-MM-DD` inclusive, on a date-like field, using the same SQL as the view date window (start only). Invalid windows return 400 as for views.
- `sort?: "value" | "key"`: `value` (current behavior) orders by the first metric descending; `key` orders by group key ascending, chronological for date buckets.
- `limit?: number` (1 to 1000) and `other?: boolean`: keep the first `limit` groups; with `other`, the remaining groups are folded into one group keyed `"__other__"` (counts and sums add; avg is recomputed from sum and count; min and max combine; countUnique is not foldable and returns null for "Other").

Comparison to the previous period needs no engine change: the client shifts the range back by one period and asks again.

Drill-down: `POST /api/bases/:base/aggregate/records` takes the aggregate input plus `key: GroupKey[]` and returns `{ ids: number[]; truncated: boolean }`, at most 500 ids in the table's row order. Membership uses the same `groupKeys` function as the aggregate, so drilled records always match the number shown. The "Other" key returns records of every group outside the top `limit`.

Result cache: the Durable Object keeps an in-memory LRU (200 entries) of aggregate results keyed by the table id and the canonical JSON of the input. Any row write or schema change in the base clears the whole cache: lookups, rollups and link titles make one table's results depend on others, and a base-wide reset is the simple rule that is always right. The cache lives in memory only, so a restart just empties it. Member renames are not tracked; their effect on user-field labels lasts until the next write.

## Client

### Navigation

- The table tab bar shows dashboards after the tables, with a chart icon; the "+" menu adds "New dashboard". Route: `/base/:id/dash/:dashId`.
- The view sidebar is hidden on dashboards. An empty dashboard shows an "Add widget" button in the middle.

### Layout

- react-grid-layout with 12 columns and vertical compaction. "Edit layout" (editors and owners only) turns on drag and resize; "Done" leaves edit mode. `setLayout` is sent once per drag or resize stop.
- Below 768 px wide, widgets stack in one column in `y, x` order, read only.

### Widget editing

- Each widget has a "..." menu: Edit, Duplicate, Delete. Edit opens a side panel with a live preview; Save commits `updateWidget`.
- Panel sections: source (table, optional view), filters (the toolbar filter editor), date field for the global range, then type settings. Field pickers only offer fields that fit (sum and avg number fields, date buckets for date fields, and so on).

### Global date range

- Presets: all time, this week (Monday start), this month, this quarter, this year, last 7 days, last 30 days, custom from and to. Stored per viewer per dashboard in localStorage, not in the dashboard.
- Days are computed in the browser's time zone and sent as they are, without the calendar's one-day padding: a padded window would add a day of records to every count and total, and the client cannot remove them from an aggregate. Date-only values have no time zone, so they match exactly; values with a time (date and time fields, created and modified time) are filtered and bucketed by their UTC day, the same rule the aggregate uses for buckets.
- Widgets without a `dateFieldId` ignore the range. A metric card with `compare` shows the change against the previous period: the previous calendar week, month, quarter or year for those presets, and the same number of days just before the range for last 7 days, last 30 days and custom. The comparison is hidden when the range is all time.

### Rendering

- Colors come from the app's `COLORS` palette; single select groups use their option's color. The app has no dark theme yet, so charts use the light tokens from `styles.css` (text, lines, muted) read at render time, and follow a dark theme once one exists.
- Time axes fill missing buckets with zero within the range (or within the data's own first and last bucket when the range is all time), so lines do not join distant points.
- Empty results show "No data". Errors show the message and a Retry button inside the widget only.
- Group labels: select option names, user names, linked record titles, "(empty)" for null, "Other" for the folded group.

### Drill-down

- Clicking a bar, line point, pie slice, pivot cell or metric card opens a list of the records in that group (primary field plus the first few fields), with "Showing the first 500" when truncated. Clicking a record opens the existing record modal.

### Refresh

- When the client receives row changes for a table, widgets of the open dashboard that use that table re-query after a 1 second debounce. Dashboards that are not open send no requests.

## MCP

- `list_dashboards`: id, name, widget count.
- `get_dashboard`: widgets with their settings (names instead of ids) and the current data of each widget.
- `create_dashboard`: name and optional widgets.
- `update_dashboard`: rename, and add, update, remove widgets or move them, using table and field names.

## Error handling

- Widgets with a missing or unfit source show "The data source changed; pick another" with a Settings button for editors; other widgets are unaffected.
- Over-limit group counts show "Showing the top N groups".
- Drill-down reflects the data at click time; a record deleted since then is simply absent.

## Testing

- Unit (node): date presets (year and quarter boundaries, leap years, previous period), time series zero fill, conversion of aggregate results to ECharts options for each widget type, one-column layout ordering.
- Worker integration: dashboard ops, per-widget merge with concurrent edits, validation errors, widgets after field and table deletion, aggregate `range`, `sort`, `limit`, `other` (including avg and countUnique in "Other"), drill-down ids matching aggregate counts (multi select fan-out, week buckets, empty group, "Other"), cache invalidation on writes (including a write to a linked table feeding a rollup) and distinct entries for distinct filters, viewer cannot edit, the four MCP tools.
- UI, manually with the Playwright MCP against `wrangler dev`: each widget type showing real data with numbers checked against the API, layout drag and resize surviving a reload, the global range changing numbers, drill-down opening a record, a change in another tab refreshing the dashboard, viewer read-only, one column at phone width. Screenshots checked for each.

## Verification record

Every feature keeps a record of how it was tested and what came out, for use in the website's marketing pages. This applies from this part on, and is backfilled for part 1 (MCP) and part 2 (views).

- `docs/verification/<feature>.md` per feature (`mcp.md`, `views.md`, `dashboards.md`): what was tested, how (unit, worker integration, UI with Playwright, bench), the test count and pass result, bench numbers with the machine and environment, the UI scenarios walked through with what was checked, and the date. Numbers from `wrangler dev` are labeled as local and kept apart from live Durable Object numbers, as the site's performance note requires.
- `docs/verification/img/<feature>-<scenario>.png`: the screenshots from the UI checks, taken at 1440x900 with the demo data (plus one phone width shot per feature).
- `docs/verification/results.json`: the machine-readable summary the site can import (`{ feature, date, tests: { files, total, passed }, bench: [{ action, ms, rows, env }], scenarios: [{ name, result, image }] }[]`).
- `npm run verify`: runs vitest with the JSON reporter, maps test files to features (a table in `scripts/verify.mjs`) and rewrites the `tests` part of `results.json`. Bench and UI entries are written when those checks run.

## Success criteria

- On the bench machine, an 8-widget dashboard over a 50,000-row table shows all widgets within 3 s on first open and within 500 ms when cached.
- Opening a table page does not load ECharts.
- All existing tests pass.
- `docs/verification/` holds the records for MCP, views and dashboards, and `npm run verify` refreshes the test counts.
