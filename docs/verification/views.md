# Calendar, timeline, gallery and grid grouping: verification record

Date: 2026-10-13 (tests re-run with `npm run verify`). Feature: part 2 of the feature expansion ([spec](../superpowers/specs/2026-10-13-views-design.md)).

## What was tested

- Calendar views by month and week, with multi-day bars, drag to reschedule and unscheduled records.
- Timeline (Gantt) views by start and end date or duration, in lanes, at day, week and month scale.
- Gallery views with chosen fields and cover images.
- Grids grouped by up to 3 fields with collapsible headers, counts and per-group summaries.
- Date windows in the engine, so calendars and timelines load only what is visible.
- Views over MCP (`create_view`, `update_view`).

## How

- Unit tests (Vitest, Node): day arithmetic across years and leap days, month grids, spans and row packing, timeline scales, stored values in any time zone, the one-day query padding near midnight, grouped rows and collapsing, group labels and summaries, timeline lanes.
- Worker integration tests (workerd, real Durable Objects): date-window queries (overlap, end before start, combined with filters and created time, invalid windows), group levels and group keys, summaries without fan-out at 3 levels, consecutive grouped rows, cleanup of view references when fields are deleted, search applied to summaries, and the HTTP routes.
- UI checks with Playwright against `wrangler dev` in the "Views QA" base (8 projects, 246 tasks), comparing what is shown with the API.
- Bench: `npm run bench`, 50,000 rows.

## Results

Tests: 41 of 41 passed in 6 files (`npm run verify`, 2026-10-14).

Bench (local `wrangler dev`, Apple M5 Pro, Node v24.18.1, 50,000 rows; local numbers, not production):

| Action | ms |
| --- | --- |
| Calendar month window (6 weeks, 2,000 rows inline) | 75.4 |
| Grid grouped by 2 fields with sum summaries (query plus two aggregates) | 579.33 |
| Kanban group counts | 64.95 |

UI scenarios:

| Scenario | What was checked | Result | Screenshot |
| --- | --- | --- | --- |
| Calendar month | Records on their days, multi-day bars, "+N more"; the month window holds 156 records, equal to the API | Pass | [month](img/views-calendar-month.png) |
| Calendar week | Week view | Pass | [week](img/views-calendar-week.png) |
| Timeline | Projects by start and duration in Status lanes, today line | Pass | [timeline](img/views-timeline.png) |
| Gallery | Cards with the chosen fields | Pass | [gallery](img/views-gallery.png) |
| Grid grouped by 3 levels | Status, Priority, Assignee headers with counts; Todo: 89 records, Estimate sum 735.4, equal to the API | Pass | [grid](img/views-grid-groups.png) |
| Phone | Calendar at 390 px | Pass | [phone](img/views-phone.png) |

## Known limits

- Group summaries are requested one level at a time, and refresh every open view.
- Timeline drags do not handle cancel or Esc; bars and group headers are not keyboard operable.
- Dragging a timed record in the week view ignores where it was grabbed.
- Grouping by created time puts each record in its own group.
- No task dependencies, recurring events or time zones other than the browser's (out of scope for this part).
