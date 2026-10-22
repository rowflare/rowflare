# Views design: calendar, timeline, gallery, grid grouping

Date: 2026-10-13. Status: approved in conversation, awaiting written review.

Part 2 of 5 in the feature expansion (MCP, views, dashboards, automations, AI fields).

## Goal

Bring Rowflare's views to the level of Feishu Bitable and Airtable for planning work: a calendar, a timeline (Gantt without dependencies), a card gallery, and grouping with summaries in the grid.

## Scope

In scope:

- Calendar view: month and week modes, single date or start/end range, drag to reschedule and resize, click to create, unscheduled sidebar.
- Timeline view: bars from start/end dates or start plus duration, lanes, day/week/month scale, drag to move and resize, unscheduled row.
- Gallery view: card grid with cover image and chosen fields.
- Grid grouping: up to 3 levels, collapsible group header rows, per-group record counts and summaries.
- Engine support: date window queries, multi-level group queries, aggregate without fan-out.
- MCP `create_view` / `update_view` accept the new view types and settings.

Out of scope (later): task dependencies and critical path (the config key is reserved), drag between groups in grouped grid beyond setting the group value, recurring events, time zones other than the browser's.

## Approach

Calendar and timeline are built in-house with React and CSS grid, sharing one date-window data layer and one set of pure date helpers. No calendar or Gantt library: FullCalendar's resource timeline and the full-featured Gantt libraries are commercial, frappe-gantt has no lanes, and two foreign styling systems would not match the app.

## Data model

`src/shared/types.ts`:

- `ViewType` adds `"calendar" | "timeline" | "gallery"`.
- `ViewConfig` adds:
  - `dateFieldId?: string`: start date (calendar and timeline).
  - `endDateFieldId?: string`: optional end date.
  - `durationFieldId?: string`: timeline only, a number field holding days; used when there is no end date field.
  - `laneFieldId?: string`: timeline lanes; single select, user or link field.
  - `calendarMode?: "month" | "week"` (default month).
  - `timelineScale?: "day" | "week" | "month"` (default week).
  - `dependencyFieldId?: string`: reserved, unused in this part.
  - `groups?: { fieldId: string; dir: "asc" | "desc" }[]`: grid grouping, at most 3.
  - `summaries?: Record<string, AggFn>`: grid group summaries per field id.
  - Gallery reuses `coverFieldId` and `hidden` (fields shown on cards), like kanban.
- Date-like fields for `dateFieldId` / `endDateFieldId`: `date`, `createdTime`, `modifiedTime`, and formula or rollup fields with `resultType: "date"`. Computed ones are read-only in the view.

`BaseStore.createView` picks defaults: calendar and timeline take the first date field as `dateFieldId`; timeline takes the first single select as `laneFieldId` if any. `BaseStore.deleteField` already removes `groupFieldId` and `coverFieldId` from view configs when the field is deleted; it must do the same for every new field reference (`dateFieldId`, `endDateFieldId`, `durationFieldId`, `laneFieldId`, entries in `groups`, keys in `summaries`).

## Engine

### Date window query

`QueryInput.range?: { startFieldId: string; endFieldId?: string; durationFieldId?: string; from: string; to: string }` with `from` and `to` as `YYYY-MM-DD` (inclusive). Generated SQL keeps records whose span overlaps the window:

- start is the date part of the start field (for created/modified time, the UTC date of the timestamp);
- end is the date part of the end field; in duration mode it is start plus (duration - 1) days computed in SQL with `date()`; when empty or earlier than the start, the end is the start;
- overlap: `start <= to AND end >= from`.
- Records with an empty start are excluded (they are "unscheduled", queried with the existing `empty` filter).

`range` is ANDed with the view's filters, `extraFilters` and search.

### Multi-level group query

`QueryInput.groupFieldIds?: string[]` (at most 3). Rows are ordered by each group field (using `sortExpr`, direction from `ViewConfig.groups`), then by the view's sorts. The result carries `groupKeys?: (string | null)[][]`, one array per id, the stored value of each group field as JSON text (so multi-value cells group by their whole combination, like Airtable). The existing single `groupFieldId` / `groups` output for kanban is unchanged.

When the grid view has `config.groups`, `query` with `viewId` applies them automatically, as kanban does with `groupFieldId`.

### Aggregate without fan-out

`AggregateInput.fanOut?: boolean` (default true, current behavior). With `false`, a multi-value cell forms one group keyed by its whole value, matching the grid's grouping. Group keys in this mode are the same JSON text as `groupKeys`, so the client can join summaries to header rows. The grid requests summaries with `fanOut: false`, its `groups` as `groupBy`, and one metric per entry in `summaries`.

## Client

### Shared

- `src/web/base/dates.ts` (pure, unit tested): month grid (6 weeks, week start Monday), week days, `overlaps`, span clipping to a window, greedy lane packing for bars (each bar goes in the first row where it does not overlap), scale math for the timeline (date to pixel and back), adding days and months across year boundaries.
- `BaseClient.setViewRange(viewId, from, to)`: stores the window and runs the view query with `range`. Realtime row messages trigger the same debounced requery kanban already uses (250 ms), so a moved or newly dated record lands in the right place without client-side date bookkeeping.
- `BaseClient.queryUnscheduled(viewId)`: paged list of records with an empty start date.
- `ViewSettings` popover per view type: date field, end field or duration field, lane field, scale or mode. A view without a valid `dateFieldId` renders a setup screen (like kanban's `GroupSetup`).
- `BasePage`: new views in the create menu with icons; toolbar (filter, sort, search, hide fields) shown for all new types.
- Card rendering is extracted from `KanbanView.tsx` into `src/web/base/cards.tsx` (`RecordCard`, `CardSettings`) and used by kanban, gallery and calendar.

### Calendar (`CalendarView.tsx`)

- Month mode: 6x7 grid; multi-day records as bars spanning cells, packed per week row; overflow shows "+N more" opening a day popover with the full list.
- Week mode: an all-day and multi-day strip on top, then hourly slots for records whose start field includes time; records without time go in the all-day strip.
- Navigation: previous, next, today; the visible window is the query window.
- Drag a record to another day (keeps its length); drag a bar edge to change start or end; click the "+" of a day (month) or double-click a slot (week) to create a record with that date; a ranged record is made by creating it and dragging its end.
- Unscheduled sidebar (toggle): records with no start date, draggable onto a day.
- Read-only cases (viewer role, trial ended, computed date fields): no drag, no create.

### Timeline (`TimelineView.tsx`)

- Left pane: one header per lane with its name and record count (collapsible), synced vertical scroll with the right pane. Record names are drawn on the bars (inside when they fit, to the right otherwise), because packed bars share rows.
- Right pane: horizontal time axis at the chosen scale with a today line; bars packed per lane.
- Drag a bar to move both dates; drag the left edge to change start, the right edge to change end (or duration in duration mode).
- Lanes: single select (one lane per option plus "No value"), user (one lane per member), link (one lane per linked record title); a record with several values appears in each lane.
- Dragging a bar to another lane sets the lane field (single select and user only; link lanes do not reassign).
- An "Unscheduled" row per lane lists records without dates; dragging one onto the axis sets its start (and end as start, or duration 1).
- Window loading: a sliding window around a center date (90 days at day scale, 364 at week scale, 1,095 at month scale); scrolling within 15% of either edge moves the center by a third of the window, reloads, and keeps the visible position steady.

### Gallery (`GalleryView.tsx`)

- Responsive card grid with windowed rendering by row; cover image from `coverFieldId`; fields per `hidden`; click opens the record modal; "New record" button.

### Grid grouping

- `src/web/base/gridGroups.ts` (pure, unit tested): builds the display row list from `ids` and `groupKeys` (header rows at each level plus record rows), applies collapsed state, maps display row index to record or header and back, and attaches summaries to headers.
- `GridView` renders headers as a custom Glide cell spanning the row (indent by level, chevron, group value rendered like the field's cell, record count, summaries for configured fields). Header rows are not editable, selectable, copyable or fillable; copy, paste and fill skip them.
- Manual row drag is limited to within a group; adding a record from a group header pre-fills that group's values.
- Toolbar "Group" button: up to 3 levels, field and direction each; header context menu sets the summary per field (sum, avg, min, max, count filled, count unique).
- Collapsed groups are per viewer (local storage), not saved in the view.

## Error handling

- A config referencing a deleted field or a field whose type no longer fits: the view shows its setup screen with "The date field was removed or changed; pick another", never a blank page.
- Optimistic drag updates roll back on write failure with a toast, like grid edits.
- End before start in stored data: shown as a single day; drag handles cannot make end earlier than start.
- Range queries with an invalid window (bad date, `from` after `to`, window over 3 years) return a 400 with a clear message.

## MCP

`create_view` and `update_view` accept types `calendar`, `timeline`, `gallery` and the settings `dateField`, `endDateField`, `durationField`, `laneField`, `calendarMode`, `timelineScale`, `coverField`, plus `groupBy` as a list of up to 3 `{ field, direction }` for grid views (a single string stays valid for kanban). Names resolve to ids as for other settings.

## Testing

- Unit (node): `dates.ts` (month grid across years, leap years, week start, overlap at window edges, clipping, lane packing, timeline pixel math round trip); `gridGroups.ts` (1 to 3 levels, collapse at each level, index mapping both ways, empty groups, summaries joined by key).
- Worker integration: `range` (single date, start/end, open end, end before start, window edges, combined with filter and search, created time as start, invalid windows); `groupFieldIds` (ordering, keys for select, multi select combination, link, empty values, direction); `aggregate` with `fanOut: false`; `createView` defaults for the new types; `deleteField` cleanup of every new config reference; MCP view tools with the new types.
- UI, manually with the Playwright MCP against `wrangler dev`, for each view: data loaded and specific records visible in the right place (not just the empty shell), drag to reschedule and resize, create by click, unscheduled sidebar drag-in, settings changes, viewer read-only behavior; grid grouping with 3 levels, collapse, summaries, add-in-group, copy that skips headers. Screenshots checked for each.

## Success criteria

- A project tracker with start and end dates can be planned on a timeline by owner and status, and on a calendar, with all edits done by drag.
- A 50,000-row table opens a calendar month in under 300 ms of query time on the bench machine (window query, not a full scan of rows into the client).
- Grouping a 50,000-row grid by 2 fields with a sum summary stays responsive (query plus summaries under 1 s locally).
- All existing tests pass.
