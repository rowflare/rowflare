# Hosting Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the open-source app a hosting extension point with plan-based usage limits, remove Stripe and trials, and add email verification and password reset, so a private hosted edition can add billing without billing code here.

**Architecture:** A module `src/worker/hosting.ts` holds the registered `Hosting` (default: self-hosted, no limits beyond today's environment variables). The Worker routes, the cron handler and each base's Durable Object ask it for the workspace's `PlanInfo` (cached 60 s) and enforce its limits where the data is: D1 for bases and attachment bytes, the Durable Object for records and automation runs, the existing AI usage code for Workers AI. The web app gets a generic Billing tab and limit messages driven by JSON the extension returns.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Durable Objects (SQLite), D1, R2, React, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-10-14-hosting-extensions-design.md`

## Global Constraints

- No billing provider names or payment code in this repository; `grep -ri "stripe" src test docs/*.md README.md` finds nothing when done.
- Self-hosted behavior unchanged apart from: trials gone, new email features. With the default hosting there are no base, record or attachment limits; automation runs per base per month come from `AUTOMATION_MONTHLY_RUNS` (default 10,000) and Workers AI from `AI_WORKERS_MONTHLY_CALLS` (default none).
- Limit errors answer HTTP 402 with `{ error, limit: { key, limit, upgradeUrl? } }`; keys `bases`, `records`, `attachments`, `automationRuns`, `workersAiCalls`.
- Plans are cached 60 s per isolate and per Durable Object.
- Email tokens: 32 random characters, stored as SHA-256; `verify` lives 24 h, `reset` 1 h; 5 emails per address per hour; the forgot-password answer never reveals whether an account exists.
- No Chinese in code or comments, no em dash anywhere. One commit per task on branch `hosting-extensions`, short message, no Co-Authored-By.

## Review Focus

1. A paste or CSV import that would cross the record limit: the whole write is refused with how many records can still be added, nothing is half-written. (Task 3 test "a paste over the limit writes nothing".)
2. A downgrade to a lower limit with more records than allowed: existing records stay editable, only new records are refused. (Task 3 test "over the limit existing records stay editable".)
3. Attachment space after deleting files: freed by the hourly recount, never below zero, uploads in between are counted. (Task 4 test "the recount frees deleted files and keeps later uploads".)
4. Workspace-wide automation runs across several bases: the total stops near the limit even when two bases run at once (bounded overshoot of one alarm batch). (Task 5 test "two bases share the workspace run limit".)
5. Password reset with an unknown email, a used token, an expired token: same answer for unknown emails, used and expired tokens refused, other sessions signed out after a reset. (Task 6 tests.)

---

## File Structure

Create:
- `src/worker/hosting.ts`: `PlanLimits`, `PlanInfo`, `BillingView`, `Hosting`, `setHosting`, `hosting`, `planFor(env, workspaceId)` (60 s cache), `LimitError`.
- `src/worker/limits.ts`: D1 helpers for `workspace_storage` and `workspace_usage`, the hourly storage recount.
- `src/worker/account-mail.ts`: instance mail sending (system binding, Resend or SMTP from environment), verification and reset emails, tokens.
- `migrations/0004_hosting.sql`: drop the four billing columns, `users.email_verified_at`, `email_tokens`, `workspace_storage`, `workspace_usage`.
- `src/web/pages/Billing.tsx` (generic tab), `src/web/pages/Reset.tsx` (forgot and reset pages), `src/web/limits.ts` (limit error display).
- Tests: `test/worker/hosting.test.ts`, `test/worker/limits.test.ts`, `test/worker/account-mail.test.ts`, `test/unit/hosting.test.ts`.

Modify:
- `src/worker/index.ts` (config, routes mount, createWorkspace hook, bases limit, uploads, cron, remove billing), `src/worker/access.ts`, `src/worker/base-do.ts`, `src/worker/base/store.ts` (record limit hook), `src/worker/auto/repo.ts` and `engine.ts` (run quota), `src/worker/ai/*` (Workers AI limit from plan), `src/worker/env.ts`, `src/worker/schema.ts`, `src/worker/auth.ts` (session revoke), web `api.ts`, `Home.tsx`, `Settings.tsx`, `Auth.tsx`, `App.tsx`, `toast` usage for limit errors, docs and `.dev.vars.example`.
- Delete: `src/worker/billing.ts`.

---

### Task 1: Hosting module and wiring

**Files:** Create `src/worker/hosting.ts`, `test/worker/hosting.test.ts`. Modify `src/worker/index.ts`.

**Interfaces:**
- Produces: `setHosting(h: Hosting)`, `hosting(): Hosting`, `planFor(env: Env, workspaceId: string): Promise<PlanInfo>`, `clearPlanCache(workspaceId?: string)`, `class LimitError extends HttpError { limit: { key: LimitKey; limit: number; upgradeUrl?: string } }`, `type LimitKey = "bases" | "records" | "attachments" | "automationRuns" | "workersAiCalls"`, `DEFAULT_HOSTING`.

- [ ] Step 1: Tests (`test/worker/hosting.test.ts`): with the default hosting, `planFor` returns `{ name: "Self-hosted", paid: true, limits: { automationRuns: { per: "base", n: 10000 } } }` and `/api/config` has `billing: false`; after `setHosting(testHosting)` (in a `beforeEach`, restored in `afterEach`) `/api/config` has `billing: true`, a route `GET /api/test-hosting/ping` from `testHosting.routes` answers, `onWorkspaceCreated` is called on sign-up with the new workspace id, and `scheduled` runs from the cron handler (call the default export's `scheduled` with a fake controller and `ctx.waitUntil` collecting promises). Run, expect failures (module missing).
- [ ] Step 2: Implement `hosting.ts`:

```ts
// Extension point for a hosted edition: plans, limits, extra routes and hooks. Self-hosted instances use the default.
import type { Hono } from "hono";
import type { Env } from "./env";
import { HttpError, type Vars } from "./access";

export type LimitKey = "bases" | "records" | "attachments" | "automationRuns" | "workersAiCalls";
export interface PlanLimits {
  bases?: number;
  recordsPerBase?: number;
  attachmentBytes?: number;
  automationRuns?: { per: "workspace" | "base"; n: number };
  workersAiCalls?: number;
}
export interface PlanInfo { name: string; paid: boolean; limits: PlanLimits; upgradeUrl?: string }
export interface BillingView {
  plan: string;
  paid: boolean;
  usage: { key: string; label: string; used: number; limit: number | null }[];
  notice?: string;
  actions: { label: string; url?: string; post?: string; style?: "primary" | "default" }[];
  sections?: { title: string; text: string }[];
}
export interface Hosting {
  plan(env: Env, workspaceId: string): Promise<PlanInfo>;
  /** Adds routes to the app (billing, webhooks, admin); they run after the auth middleware, so `c.get("user")` works. */
  routes?(app: Hono<{ Bindings: Env; Variables: Vars }>): void;
  onWorkspaceCreated?(env: Env, workspaceId: string, ownerId: string): Promise<void>;
  billing?(env: Env, workspaceId: string, userId: string): Promise<BillingView>;
  scheduled?(env: Env, now: number): Promise<void>;
}

const num = (v: string | undefined, d?: number) => (v === undefined || v === "" ? d : Math.max(0, Number(v) || 0));

export const DEFAULT_HOSTING: Hosting = {
  async plan(env) {
    const runs = num(env.AUTOMATION_MONTHLY_RUNS, 10_000)!;
    const ai = num(env.AI_WORKERS_MONTHLY_CALLS);
    return { name: "Self-hosted", paid: true, limits: { automationRuns: { per: "base", n: runs }, ...(ai ? { workersAiCalls: ai } : {}) } };
  },
};

let current: Hosting = DEFAULT_HOSTING;
const cache = new Map<string, { at: number; plan: PlanInfo }>();
export const setHosting = (h: Hosting) => { current = h; cache.clear(); };
export const hosting = () => current;
export function clearPlanCache(workspaceId?: string) { if (workspaceId) cache.delete(workspaceId); else cache.clear(); }
export async function planFor(env: Env, workspaceId: string): Promise<PlanInfo> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.plan;
  const plan = await current.plan(env, workspaceId);
  cache.set(workspaceId, { at: Date.now(), plan });
  return plan;
}

export class LimitError extends HttpError {
  constructor(message: string, readonly limit: { key: LimitKey; limit: number; upgradeUrl?: string }) { super(402, message); }
}
```

  `AUTOMATION_MONTHLY_RUNS` "0" means no limit today; keep that: `n: 0` means unlimited in the quota code (Task 5).
- [ ] Step 3: Wire `index.ts`:
  - `app.onError` answers `{ error, limit }` with status 402 for a `LimitError`.
  - `/api/config` adds `billing: !!hosting().billing` and drops `billingEnabled` and `trialDays`.
  - Replace the catch-all `app.all("/api/*", ...)` 404 with `app.notFound(...)`, so routes added later still match.
  - Export `extendApp(h: Hosting)`: calls `setHosting(h)` and then `h.routes?.(app)`. The hosted edition's entry does `import worker, { BaseDO, extendApp } from "<app>/src/worker/index"; extendApp(saasHosting); export default worker; export { BaseDO };`.
  - Call `hosting().onWorkspaceCreated` at the end of `createWorkspace`, and `hosting().scheduled` from `scheduled` next to `cleanup`.
  - The test calls `extendApp(testHosting)` once at module level of the test file (routes cannot be removed again, so the test hosting's routes live under `/api/test-hosting/`) and `setHosting(DEFAULT_HOSTING)` in `afterEach`.
- [ ] Step 4: Run `npx vitest run --project worker test/worker/hosting.test.ts`, expect pass; `npm run typecheck`.
- [ ] Step 5: Commit "Hosting extension point".

### Task 2: Remove Stripe and trials

**Files:** Delete `src/worker/billing.ts`. Create `migrations/0004_hosting.sql` (this task adds only the column drops; later tasks append their tables to the same file before it ships). Modify `index.ts`, `access.ts`, `base-do.ts`, `schema.ts`, `env.ts`, `web/api.ts`, `web/pages/Home.tsx`, `web/pages/Settings.tsx`, `routes-automations.ts`, tests that used trials, docs, `.dev.vars.example`, `README.md`.

- [ ] Step 1: Tests: migration test (worker) creates a database with the old `workspaces` columns via `TEST_MIGRATIONS` and checks `ensureSchema` leaves `workspaces` without them and keeps rows; `baseAccess` "write" no longer returns 402; `GET /api/workspaces` items have no `canWrite`. Rewrite the two trial tests (`automation-engine.test.ts` "runs are skipped while the workspace cannot write", `ai-engine.test.ts` "pauses while the trial has ended") to use the generic pause: `i.canRun = async () => false` with the message "Automations are paused for this workspace" and AI cells waiting.
- [ ] Step 2: Implement. `0004_hosting.sql` starts with:

```sql
-- Billing moved out of the open-source app; plans come from the hosting extension.
ALTER TABLE workspaces DROP COLUMN trial_ends_at;
ALTER TABLE workspaces DROP COLUMN stripe_customer_id;
ALTER TABLE workspaces DROP COLUMN stripe_subscription_id;
ALTER TABLE workspaces DROP COLUMN subscription_status;
```

  Add `[4, m0004]` to `schema.ts`. `BaseDO.canRun` stays as an overridable `async () => true` (tests replace it) and its D1 query goes. The automation route keeps "editors may switch off or delete with read access" (harmless). Home loses the trial banner and `canWrite` checks (use `canEdit` only); Settings' Billing tab is replaced in Task 7 (remove the old component now and hide the tab). README and `docs/self-hosting.md` drop the `STRIPE_*` rows and describe `MODE=cloud` as open sign-up only.
- [ ] Step 3: `npm test` (whole suite, log to the plan workspace), `npm run typecheck`, `grep -ri stripe src test docs README.md` empty.
- [ ] Step 4: Commit "Remove Stripe and trials".

### Task 3: Record and base limits

**Files:** Modify `src/worker/base/store.ts`, `src/worker/base-do.ts`, `src/worker/index.ts`. Test `test/worker/limits.test.ts`.

**Interfaces:** `BaseStore.recordLimit?: () => number | undefined`; `BaseStore.totalRows(): number`; `BaseDO.planChanged(): Promise<void>` (drops the cache); DO field `plan?: PlanInfo` refreshed by `refreshPlan()` (60 s) before row writes and in the alarm. `UserError` gains optional `limit` so `Result` can carry `{ ok: false, error, status: 402, limit }`; routes turn it into a `LimitError`.

- [ ] Step 1: Tests with a test hosting (`setHosting` in the test) giving `{ bases: 2, recordsPerBase: 10 }`:
  - creating a third base answers 402 with `limit.key "bases"`; the demo route is not limited (guest workspaces).
  - a paste over the limit writes nothing: base with 8 records, create 3 in one request answers 402 "This plan allows 10 records per base; 2 more can be added" and the count stays 8.
  - deleting records frees room; a public form submission and an automation createRecord step are refused the same way (the automation step fails with the message).
  - over the limit existing records stay editable: set the limit to 5 with 8 records, update one record succeeds, create fails.
  - the record limit counts all tables of the base.
- [ ] Step 2: Implement: in `createRows`, before inserting, `const max = this.recordLimit?.(); if (max !== undefined && this.totalRows() + inputs.length > max) throw new UserError(...)` with `status 402` and `limit { key: "records", limit: max }`. `totalRows()` sums `count(*)` of every table (cache the sum per transaction-free call; tables are few). The DO sets `this.store.recordLimit = () => this.plan?.limits.recordsPerBase` and awaits `refreshPlan()` at the start of `rowOp`, `schemaOp`, `webhook`, `runButton`, the alarm and form submissions. Base limit: in `POST /api/workspaces/:ws/bases` count `bases` of the workspace against `plan.limits.bases`. Errors carry `upgradeUrl` from the plan.
- [ ] Step 3: Run the tests, the whole suite, typecheck.
- [ ] Step 4: Commit "Plan limits for bases and records".

### Task 4: Attachment storage limit

**Files:** Create `src/worker/limits.ts`. Modify `index.ts` (`storeUpload`, cron), `base-do.ts` (`attachmentBytes()` RPC), `access.ts` (`BaseStub`), migration (append `workspace_storage`). Test `test/worker/limits.test.ts`.

- [ ] Step 1: Tests (test hosting with `attachmentBytes: 1000`): an upload of 600 bytes passes, a second of 600 answers 402 `attachments`; the form attachment route is limited the same way; "the recount frees deleted files and keeps later uploads": after clearing the cell and running `recountStorage(env, now)`, the stored bytes equal the files still in cells, and an upload made after the recount started is not lost (recount stores `max(0, counted)` plus bytes uploaded since `counted_at`, tracked by `uploaded_since`).
- [ ] Step 2: Implement `workspace_storage (workspace_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, uploaded_since INTEGER NOT NULL DEFAULT 0, counted_at INTEGER)`. `addUpload(env, ws, size)` adds to both `bytes` and `uploaded_since`. `recountStorage(env, now, limit = 100)` takes the 100 workspaces with the oldest `counted_at` that have bases, asks each base `attachmentBytes()` (sum of `size` of attachment cells in all its tables via `json_each`), and sets `bytes = sum + uploaded_since_at_start_delta`; implement the race-free form: read `uploaded_since` before counting, write `bytes = counted + (uploaded_since_now - uploaded_since_before)`, `uploaded_since = uploaded_since_now - uploaded_since_before`, `counted_at = now`. Only checked when the plan has `attachmentBytes`.
- [ ] Step 3: Tests, suite, typecheck. Commit "Attachment storage limit".

### Task 5: Automation runs and Workers AI from the plan

**Files:** Modify `src/worker/auto/repo.ts`, `auto/triggers.ts`, `auto/engine.ts`, `base-do.ts`, `ai/services.ts`, `limits.ts` (append `workspace_usage`), migration. Test `test/worker/limits.test.ts`, existing automation tests.

**Interfaces:** `interface RunQuota { check(now: number): string | null; take(now: number): void }` replaces the `monthlyLimit: number` parameter of `repo.enqueue` and `detectTriggers`. Base quota: today's meta counter. Workspace quota: DO keeps `{ used (from D1, cached 60 s), pending }`; `take` adds to pending; the alarm flushes pending to `workspace_usage (workspace_id, kind, month, n)` with `kind = 'automationRuns'`.

- [ ] Step 1: Tests: with the default hosting the per-base limit works as before (existing tests pass unchanged apart from the signature); with a test hosting `{ automationRuns: { per: "workspace", n: 3 } }`, the fourth run in a month is skipped with "This workspace used its 3 automation runs for this month"; "two bases share the workspace run limit": two bases each queue 3 runs before either alarm flushes, total queued is at most 3 + one batch, and after flushing the next run in either base is skipped. Workers AI: a test hosting with `workersAiCalls: 2` limits AI cells like the env variable did.
- [ ] Step 2: Implement; `AUTOMATION_MONTHLY_RUNS="0"` still means no limit; `automationList` returns `usage: { used, limit, per }`. `aiWorkersStored` reads the plan's `workersAiCalls` (falls back to `AI_WORKERS_MONTHLY_CALLS`).
- [ ] Step 3: Whole suite, typecheck. Commit "Automation runs and Workers AI follow the plan".

### Task 6: Email verification and password reset

**Files:** Create `src/worker/account-mail.ts`, `src/web/pages/Reset.tsx`. Modify `index.ts` (routes), `auth.ts` (revoke sessions), `env.ts` (`MAIL_PROVIDER`, `RESEND_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_FROM`), migration (`users.email_verified_at`, `email_tokens`), `web/pages/Auth.tsx`, `App.tsx`, a verify banner in `App` or `Home`. Test `test/worker/account-mail.test.ts`.

**Interfaces:** routes `POST /api/auth/forgot { email }` (always `{ ok: true }`), `POST /api/auth/reset { token, password }`, `POST /api/auth/verify { token }`, `POST /api/auth/verify/resend`; `/api/config` gains `accountMail: boolean`; `/api/auth/me` user gains `emailVerified: boolean`. `account-mail.ts`: `instanceMailer(env): ((m: OutMail) => Promise<void>) | null`, `issueToken(env, userId, kind)`, `useToken(env, token, kind): Promise<string | null>` (user id), a test seam `setMailerForTests`.

- [ ] Step 1: Tests with a captured mailer: sign-up sends one verify mail with a link containing the token; verify marks `email_verified_at`; a used token is refused; an expired token (move time by updating `expires_at`) is refused; forgot for an unknown email answers `{ ok: true }` and sends nothing; forgot for a real email sends a reset link; reset with it changes the password, deletes the user's other sessions and keeps the current request working; the 6th forgot in an hour for one address sends nothing; without any mailer `/api/config` has `accountMail: false` and `forgot` answers 400 "Email is not set up on this instance".
- [ ] Step 2: Implement. Migration rows: `ALTER TABLE users ADD COLUMN email_verified_at INTEGER; UPDATE users SET email_verified_at = created_at WHERE is_guest = 0;` and `CREATE TABLE IF NOT EXISTS email_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens (user_id, kind, created_at);`. Mail text: plain text with the link `${APP_URL or origin}/reset?token=...` and `/verify?token=...`. Mailer order: `EMAIL` binding with `EMAIL_FROM`; else `MAIL_PROVIDER=resend` with `RESEND_API_KEY` and `MAIL_FROM`; else `MAIL_PROVIDER=smtp` with the SMTP variables (reuse `sendResend`, `smtpSend` and the socket opener from `auto/`).
- [ ] Step 3: Web: "Forgot password?" on the login page (when `accountMail`), `/forgot` and `/reset` pages, `/verify` page that posts the token and shows the result, a dismissible banner "Check your inbox to confirm your email" with "Send again" for unverified users.
- [ ] Step 4: Tests, suite, typecheck, build; check the pages in the browser against `wrangler dev` with a captured SMTP sink (scratchpad `smtp-sink.mjs`, `MAIL_PROVIDER=smtp` in `.dev.vars`). Commit "Email verification and password reset".

### Task 7: Generic billing tab and limit messages in the web app

**Files:** Create `src/web/pages/Billing.tsx`, `src/web/limits.ts`. Modify `Settings.tsx`, `api.ts` (`ApiError` keeps `limit`), `toast` usage in `client.ts` and pages, `Home.tsx` (80% notices). Modify `index.ts`: `GET /api/workspaces/:ws/billing` returns `hosting().billing(...)` for members (404 when the hosting has none); `GET /api/workspaces/:ws/usage` returns `{ plan, usage }` computed here (bases, records per base max, attachment bytes, automation runs this month, Workers AI calls this month) for every edition.

- [ ] Step 1: Worker tests: `/billing` 404 by default, the test hosting's view with a test hosting; `/usage` numbers for a workspace with 2 bases and some records and an upload.
- [ ] Step 2: `ApiError` gets `limit?: { key; limit; upgradeUrl? }`; `limitMessage(e, isOwner)` returns the message plus an "Upgrade" link for owners (opens `upgradeUrl`) or "Ask a workspace owner to upgrade". Use it wherever `toastError` shows API errors (client writes, base creation, uploads).
- [ ] Step 3: Billing tab: shown when `config.billing`; renders plan name, usage bars from `usage`, notice, sections and action buttons (`url`: open; `post`: POST then follow `{ url }`). Home: when any usage is at 80% or more of its limit, a notice with a link to the Billing tab (or "Ask a workspace owner").
- [ ] Step 4: Typecheck, build, tests; check in the browser with a test hosting enabled through a dev-only module (`src/worker/dev-hosting.ts`, loaded only when `DEV_TEST_HOSTING=true` in `.dev.vars`, giving small limits and a fake Billing view) and screenshots. Commit "Generic billing tab and limit messages".

### Task 8: Docs and verification

- [ ] `docs/self-hosting.md`: email settings (system, Resend, SMTP variables), `MODE` meaning, no billing; `docs/architecture.md`: "Hosting extensions" section (interface, limits, where they are enforced); `docs/api.md`: limit errors (402 with `limit`), usage route, auth routes. README feature list: "Email verification and password reset".
- [ ] `docs/verification/hosting.md` record: what, how, results (test counts per area, scenarios with screenshots: limit message as owner and member, Billing tab with the dev hosting, forgot and reset flow through the SMTP sink), known limits (storage frees within an hour; workspace run counts may overshoot by one alarm batch).
- [ ] `scripts/verify.mjs`: feature `hosting` matching `hosting|limits|account-mail` test files. Run `npm run verify`, whole suite, typecheck, build. Commit "Hosting extensions: docs and verification record".
