# AI fields design

Date: 2026-10-14. Status: approved in conversation, awaiting written review.

Part 5 of 5 in the feature expansion (MCP, views, dashboards, automations, AI fields).

## Goal

Let a table have AI fields like Feishu Bitable's AI field shortcuts and Airtable's AI fields: a prompt that refers to other fields of the same record, run by a model, with the answer stored in the cell as text, a choice, a number, a date or a checkbox. Users bring their own model keys (Anthropic, or any OpenAI-compatible service such as OpenAI, DeepSeek, Qwen, Kimi, Zhipu, OpenRouter, Gemini or a local Ollama); deployments on Cloudflare can also offer Workers AI without a key. Automations get an "AI generate" step. It must behave the same on Cloudflare and in the Docker image, except that Workers AI exists only on Cloudflare.

## Scope

In scope:

- Workspace AI services (owner only), keys encrypted with `SECRET_KEY`, a test call, monthly call counts.
- AI field type with templates, prompt editor with field references, output types text, long text, single select, multiple select, number, date and checkbox, optional image attachments for vision models, automatic update on change, preview.
- Background generation inside the base's Durable Object: queueing, debouncing, skipping unchanged inputs, retries, pausing on rejected keys, stopping, Workers AI monthly quota, trial-ended pause.
- Cell states in the grid and record view, regenerate a cell, selected rows or a whole column, generate missing rows, progress and stop in the field header.
- Automation step "AI generate".
- MCP and REST support.
- README: replace "AI features" in "Not in scope" with a description of AI fields.

Out of scope (later): a chat assistant inside the app, fetching web pages behind URL fields, sending PDFs or other non-image files, batching several records into one model call, streaming answers into cells, per-field spending caps for own keys, base-level AI services.

## Approach

Everything runs inside the base's Durable Object, the same way as automations: cells to generate go into a queue table in the base's SQLite, and the existing alarm loop works through it. At most 6 model calls run at once per base (the Workers limit on simultaneous outgoing connections), so a base fills about 10,000 rows in 30 to 60 minutes at 1 to 2 seconds per call. Different bases do not slow each other down.

Rejected: Cloudflare Queues with a consumer Worker (the Docker image would need Miniflare's emulation, and stop, retry and quota state would be split between two places); several records per model call (one bad answer spoils the batch, models follow multi-record JSON unevenly, images do not batch well; may come later as an optimization).

## AI services

D1 table `workspace_ai (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT, model TEXT NOT NULL, secret_enc TEXT, last4 TEXT, key_rejected_at INTEGER, updated_at INTEGER NOT NULL)`, ids with the prefix `ais`. At most 10 services per workspace.

- `kind` is `anthropic`, `openai` (OpenAI-compatible, with `base_url`, for example `https://api.deepseek.com`) or `workers` (Workers AI).
- The key is encrypted with the existing AES-GCM helper under `SECRET_KEY`; the UI and API only ever show `last4`. Without `SECRET_KEY`, saving a key fails with a message that says how to set it.
- Workers AI needs no key and no row: it is listed as a built-in service with the id `workers` when the `AI` binding exists, which is only on Cloudflare. The binding is not in the default `wrangler.jsonc` (local development and tests would need a Cloudflare login); self-hosting docs explain how to add `"ai": { "binding": "AI" }`, and the hosted cloud adds it. Its default text model is `@cf/meta/llama-3.3-70b-instruct-fp8-fast` and its image model `@cf/meta/llama-3.2-11b-vision-instruct`.
- `base_url` must be `https://`, or `http://` when `AUTOMATION_ALLOW_PRIVATE=true`. Calls go through the automations' network check, so private and local addresses are refused unless `AUTOMATION_ALLOW_PRIVATE=true` (which self-hosters set to reach a local Ollama). Redirects are not followed.
- Only the workspace owner can add, edit, test and delete services. Editors and viewers see names, kinds and models.
- "Test" sends "Reply with the word OK." with the given settings and shows the answer or the service's error.
- `key_rejected_at` is set when the service answers 401 or 403, and cleared when the owner saves the service again.

Usage: D1 table `ai_usage (workspace_id TEXT NOT NULL, service_id TEXT NOT NULL, month TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (workspace_id, service_id, month))`, incremented by each model call (fields, previews, tests and automation steps), batched per alarm run. The settings page shows this month's count per service.

Workers AI quota: environment variable `AI_WORKERS_MONTHLY_CALLS`. Unset means no limit (self-hosted deployments on one's own Cloudflare account); the hosted cloud sets it. Own-key services have no call limit.

## AI field

An AI field is an ordinary field of its output's type (single line text, long text, single select, multiple select, number, date or checkbox) with an `ai` block in its options. Filters, sorts, grouping, dashboards, forms, CSV export, the REST API and MCP therefore treat its values like any other field of that type, and changing the output type is a normal field type change (values are converted). The field type list in the dialog shows "AI" as an entry that leads to these settings, and the grid header shows an AI icon. Removing the `ai` block turns it back into a plain field that keeps its values.

```
options.ai = {
  serviceId: string,            // a workspace_ai id or "workers"
  model?: string,               // empty means the service's default model
  prompt: string,               // up to 8,000 characters, field references as {fld...}
  imageFieldIds?: string[],     // attachment fields whose images are sent, at most 2 fields
  autoUpdate: boolean,          // default true
  template?: string             // the template it started from, for the UI only
}
```

Choices (for selects), precision (for numbers) and includeTime (for dates) stay in the field's usual options. The primary field can be an AI field when its type allows it. Field types other than the seven above drop the `ai` block.

- The prompt stores field ids (`{fldXXXX}`) and the editor shows names (`{Name}`), like automation templates. Any field of the same table can be referenced, including links, lookups, rollups, formulas and other AI fields; values are inserted as display text (select names, user names, linked record titles, ISO dates, multiple values joined with ", ").
- The expanded prompt is cut at 32,000 characters; a cut is noted in the cell state.
- Images: from the referenced attachment fields, the first 4 images (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) of at most 5 MB each are read from storage and sent inline. Other files are ignored. A model that does not take images returns the service's error in the cell.
- AI fields may refer to other AI fields. Cycles are refused when the field is saved, with the same check as formula fields. A cell waits until the AI cells it refers to are generated.
- Templates in the field dialog: summarize, translate, extract information, classify (single select), tag (multiple select), sentiment (single select with Positive, Neutral, Negative), write copy. A template fills the prompt and output type, and the user can change both.

The model gets a fixed system instruction per output type, then the expanded prompt:

- text and long text: "Answer with the result only, without preamble." The text answer is cut to one line.
- single select: "Answer with exactly one of these options and nothing else: A | B | C".
- multiple select: "Answer with zero or more of these options, separated by commas, and nothing else: A | B | C".
- number: "Answer with a single number only." date: "Answer with a single date in the form YYYY-MM-DD only." checkbox: "Answer with yes or no only."

Output tokens: every call allows up to 8,000 output tokens, because reasoning models (such as DeepSeek-V4.1-Flash) spend part of that budget on thinking before they answer. Thinking text (`reasoning_content` and Anthropic thinking blocks) is ignored. A call that stops on the token limit without an answer makes the cell an error "The answer was cut off".

Parsing: answers are trimmed and stripped of surrounding quotes, Markdown emphasis and a final period. Choices match case-insensitively; an answer that is not one of the field's choices makes the cell an error showing the raw answer (no option is added). Numbers take the first number in the answer (commas as thousands separators allowed). Dates accept `YYYY-MM-DD` or any form `Date.parse` reads. Checkbox accepts yes, no, true, false, 1, 0. Anything else is an error showing the raw answer.

### Cell state

DO table `_ai_cells (table_id TEXT NOT NULL, row_id INTEGER NOT NULL, field_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT, input_hash TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (table_id, field_id, row_id))`.

- `state`: `queued`, `running`, `done`, `error`, `edited`. A cell with no row is "not generated".
- The value itself lives in the row data like any other field, so filters, sorts, grouping, dashboards, CSV export and the REST API see only values.
- A user may type over an AI cell. The cell becomes `edited` and is not regenerated automatically until someone chooses "Regenerate" on it.
- Rows deleted: their `_ai_cells` and queue entries go with them. Field deleted: all its state and queue entries go.

### Broken configuration

A field is broken when its service no longer exists, its prompt refers to a deleted field, or a referenced image field is no longer an attachment field. A broken field shows a warning in its header, queues nothing and its queued cells wait. Fixing the field resumes them.

## Generation

### Queue

DO table `_ai_queue (table_id TEXT NOT NULL, field_id TEXT NOT NULL, row_id INTEGER NOT NULL, due_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (table_id, field_id, row_id))`, indexed on `due_at`. `seq` is a counter that changes whenever the entry is replaced, so a result for an older entry can be recognised.

Queued, in the same transaction as the write:

- When a row is created in a table with auto-updating AI fields, for each such field.
- When a write changes a field that an auto-updating AI field's prompt or image fields refer to, for that row (not for cells in state `edited`).
- When an AI cell's value is written by generation, for the AI fields that refer to that field.

Not queued: CSV import, Airtable import, base templates and background jobs. The field header shows "N not generated" with "Generate missing".

Debounce: a new entry is due 2 seconds after the write; another change to the same cell before then moves `due_at` and `seq` instead of adding a second entry.

Manual actions (editors only): regenerate a cell, regenerate selected rows, regenerate the whole column, generate missing rows, stop. Regenerate clears `edited`. Whole-column and missing-rows requests are queued in chunks of 5,000 rows by the alarm loop, so the request returns at once. After a field is created or its prompt, output or service is changed in a table with rows, the dialog asks "Generate for N existing records?"; yes queues the whole column.

### Running

The alarm takes due entries in `due_at` order, skipping entries whose field is broken or whose referenced AI cells are still queued or running, and runs up to 6 calls at once for at most 25 seconds per alarm. Each call times out after 60 seconds.

Before a call, the input (expanded prompt, model, output type, choices and image ids) is hashed. If the hash equals the cell's `input_hash` and the cell is `done`, the entry is dropped without a call (for example after an edit and an undo). Manual regenerate always calls.

When the answer comes back, it is written only if the queue entry still has the same `seq`, the row still exists and the field still exists; otherwise it is dropped. The write goes through the normal write path with the author "AI", is broadcast to everyone online, and fires automation `recordUpdated` and `recordMatches` triggers (the automations' loop protection applies).

### Errors and retries

- 429, 5xx, timeouts and connection errors: retried after 10 seconds, 1 minute and 5 minutes, then the cell becomes `error`. A `Retry-After` up to 5 minutes is respected.
- 401 or 403: the cell becomes `error`, the service gets `key_rejected_at`, and all queued entries using that service wait. The settings page and the field header say "The key was rejected". Saving the service again lets them run.
- Other 4xx (wrong model name, bad request): the cell becomes `error` with the service's message.
- An answer that cannot be parsed for the output type: `error` with the raw answer.
- An eviction during a call counts as a try, like automation runs.

### Stop, quota and trial

- Stop removes the field's queued entries. Calls already running finish but their answers are dropped (their `seq` no longer matches).
- Workers AI monthly quota reached: entries using Workers AI become `error` with "This month's Workers AI quota is used up" and are not retried next month by themselves.
- Hosted cloud trial ended: generation pauses with the same check as automations; entries wait and a banner explains why. Paying resumes them.

## Automation step

New step type `ai { serviceId, model?, prompt: Template, output: "text" | "json" }`.

- The prompt uses the automation templates (`{{trigger.record.Name}}`, `{{steps.s1.records[0].Name}}`...).
- Output `text` is available as `{{steps.<id>.text}}`; output `json` asks the model for one JSON object and makes it available as `{{steps.<id>.json.<path>}}`, failing the step if the answer is not a JSON object.
- Failures follow the automations' retry rules (network steps). Calls count toward `ai_usage` and the Workers AI quota.
- An AI step may take up to 60 seconds, so a run that contains an AI step has a 150 second limit instead of 30 seconds.
- The step input in the run log shows the expanded prompt; the output shows the answer, cut at 8 KB like other outputs.

## UI

- Workspace settings: "AI services" next to "Email sending". List with name, kind, model, key ending, this month's calls and a "key rejected" mark; add, edit, test, delete for the owner, read-only for others.
- Field dialog: type "AI" with template picker, service and model, prompt editor with `{` field picker (reusing the automations template input), output type with a choice editor for selects, image fields, auto update switch, and "Preview" that runs the prompt on the first record of the current view and shows the answer without writing it. Without any service, the dialog says an owner needs to add one, and owners get a link to the settings page.
- Grid cells: a small spinner for `queued` and `running`, a red mark with the message on hover or open for `error`, a small mark for `edited`. The cell's context menu and the record view have "Regenerate"; with several rows selected the context menu has "Regenerate selected rows". The field header menu has "Regenerate all", "Generate missing" and "Stop", and while the field has queued entries the header shows progress (done of total).
- Viewers see values and states but cannot trigger generation.
- Cell states travel with the rows: a row of a table with AI fields carries `ai: { [fieldId]: { s: state, e?: error } }` for cells that are not plain `done`, so query results, record fetches and realtime "rows" messages all include them, and a state change is broadcast as a "rows" message. Field header progress comes in a new message `{ type: "aiProgress"; progress: { tableId; fieldId; queued; done; total }[] }`, sent after each alarm batch and when a batch starts or stops.

## MCP and REST

- `create_field` and `update_field` accept an `ai` option (service by name or id, prompt using field names like `{Name}`, converted to ids like the UI) on the seven output types.
- New tool `generate_ai_field { baseId, tableId, field, recordIds?, missingOnly? }`: queues the given records or the whole column, returns the number queued.
- New tool `list_ai_services { baseId }`: names, kinds and models, never keys.
- REST: `GET /api/bases/:baseId/tables/:tableId/ai/:fieldId` returns progress and the cells in `error`; `POST .../ai/:fieldId/generate { rowIds?, missingOnly? }`; `POST .../ai/:fieldId/stop`. Service management stays in the web app (`/api/workspaces/:ws/ai-services`, session only, not part of the public API).

## Limits

20 AI fields per table, 10 services per workspace, prompt 8,000 characters stored and 32,000 expanded, 4 images of 5 MB, 6 calls at once per base, 60 seconds per call.

## Testing and records

- Unit tests: prompt expansion (names to ids and back, display text, the 32,000 cut), answer parsing for each output type, request and response formats for Anthropic, OpenAI-compatible and Workers AI (including images), cycle check.
- Worker integration tests with a fake model service: queueing on create and update, debounce, unchanged-input skip, `edited` cells, dependency order between AI fields, retries and `Retry-After`, key rejected pause and resume, stop dropping late answers, Workers AI quota, trial pause, imports not queueing, generate missing in chunks, permissions (owner, editor, viewer), the automation step, the MCP tools, the REST endpoints.
- UI checks with Playwright against `wrangler dev`: a local fake OpenAI-compatible service and a real DeepSeek key with `deepseek-flash` (DeepSeek-V4.1-Flash, which takes images; the key is kept out of the repo). Scenarios: add a service and test it, summary field on a table with records, classification field, number extraction, image description with a vision-capable service, edit and auto update, edited cell, regenerate, error display, stop, automation step, phone width.
- Bench: editing a cell on a 50,000-row table with two AI fields (time added in the write), and generating 1,000 rows against a fake service with a fixed 1 second delay.
- Results go to `docs/verification/ai-fields.md` with screenshots, and `npm run verify` records the test counts.
