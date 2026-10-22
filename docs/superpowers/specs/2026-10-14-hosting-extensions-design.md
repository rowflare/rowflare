# Hosting extensions, usage limits and account emails design

Date: 2026-10-14. Status: approved in conversation, awaiting written review.

## Goal

Let a hosted edition of Rowflare (a separate, private project) add billing and plans without any billing code in this open-source repository, while self-hosted instances behave as today. The open-source side provides: a registration point for hosting extensions, usage limits that it counts and enforces with numbers the extension supplies, email verification and password reset, and a generic billing screen that shows whatever the extension reports. Stripe and the subscription columns leave this repository.

## Scope

In scope:

- `src/worker/hosting.ts`: the extension interface and its self-hosted default.
- Usage limits: bases per workspace, records per base, attachment storage per workspace, automation runs per month, Workers AI calls per month. Counting and enforcement live here; the numbers come from the extension (self-hosted: today's environment variables, everything else unlimited).
- Removing Stripe: `src/worker/billing.ts`, the Stripe routes, the `STRIPE_*` settings, and the `trial_ends_at`, `stripe_customer_id`, `stripe_subscription_id` and `subscription_status` columns of `workspaces` (a D1 migration drops them; they are empty on self-hosted instances).
- Email verification and password reset, for every edition.
- A generic Billing tab in Settings and generic plan notices, driven by the extension.

Out of scope (here): plan prices, payment providers, the admin page. They belong to the hosted project.

## Extension interface

```ts
export interface PlanLimits {
  bases?: number;              // per workspace
  recordsPerBase?: number;
  attachmentBytes?: number;    // per workspace
  automationRuns?: { per: "workspace" | "base"; n: number };  // per month
  workersAiCalls?: number;     // per workspace per month
}

export interface PlanInfo {
  name: string;                // shown in Settings, Billing
  paid: boolean;
  limits: PlanLimits;
  /** Shown when a limit is reached: where owners upgrade. */
  upgradeUrl?: string;
}

export interface Hosting {
  /** Plan of a workspace; cached by callers for 60 seconds. */
  plan(env: Env, workspaceId: string): Promise<PlanInfo>;
  /** Adds routes to the app (billing, webhooks, admin); they run after the auth middleware. */
  routes?(app: Hono<{ Bindings: Env; Variables: Vars }>): void;
  /** Called after a workspace is created (signup or "New workspace"). */
  onWorkspaceCreated?(env: Env, workspaceId: string, ownerId: string): Promise<void>;
  /** Billing tab: present only when the hosting provides one. Returns JSON the generic tab renders. */
  billing?(env: Env, workspaceId: string, userId: string): Promise<BillingView>;
  /** Hourly maintenance next to the app's own cron work. */
  scheduled?(env: Env, now: number): Promise<void>;
}

export function setHosting(h: Hosting): void;
export function hosting(): Hosting;
```

- The self-hosted default returns plan `{ name: "Self-hosted", paid: true, limits: { automationRuns: per base from AUTOMATION_MONTHLY_RUNS, workersAiCalls: AI_WORKERS_MONTHLY_CALLS } }` and has no routes, no billing and no hooks.
- The hosted project's Worker entry calls `extendApp(...)` (which registers the hosting and lets it add routes) at module load, then re-exports the app's default handler and `BaseDO`. The app and every Durable Object run in the same bundle, so both see the registration.
- `BillingView`: `{ plan: string; paid: boolean; usage: { key: string; label: string; used: number; limit: number | null }[]; notice?: string; actions: { label: string; url?: string; post?: string; style?: "primary" | "default" }[]; sections?: { title: string; text: string }[] }`. The generic tab renders the plan, usage bars and buttons; a button either opens `url` or POSTs to `post` and follows the `url` in the answer. No provider names are hard-coded here.

## Usage limits

Counting and enforcement:

- Bases per workspace: counted in D1 when a base is created (also from a template or an Airtable import); over the limit the request fails with 402 and a message naming the limit.
- Records per base: the base's Durable Object knows its row counts. `createRows` (one record, a paste, a CSV or Airtable import, an automation step, a public form, the REST API, MCP) fails as a whole when the total after the write would exceed the limit, with "This plan allows N records per base; M more can be added". Deleting records frees room at once.
- Attachment storage: D1 table `workspace_storage (workspace_id PRIMARY KEY, bytes, counted_at)`. An upload checks `bytes + size` against the limit and adds `size`. The hourly cron recounts each workspace from the attachment cells that still exist (each base's Durable Object sums its attachment sizes), so deleted files free space within an hour.
- Automation runs: `per: "base"` keeps today's per-base monthly counter. `per: "workspace"` counts in D1 table `workspace_usage (workspace_id, kind, month, n)`, written in batches by each Durable Object's alarm; runs over the limit are recorded as skipped with "This month's automation runs are used up". Batching allows a small overshoot (one alarm's runs).
- Workers AI calls: the existing `ai_usage` and quota code reads the limit from the plan instead of only `AI_WORKERS_MONTHLY_CALLS`.
- Durable Objects cache the plan for 60 seconds; a webhook that upgrades a workspace takes effect within a minute (the hosted project may also call a new `BaseDO.planChanged()` RPC to drop the cache at once).
- Limits never delete or hide data. Over a lowered limit (a downgrade), existing records stay readable and editable; only adding is refused.
- Owners see "Upgrade" with `upgradeUrl` next to limit messages; other members see "Ask a workspace owner to upgrade".
- At 80% of a limit the Home page and the Billing tab show a notice.

## Removing Stripe

- Delete `src/worker/billing.ts`, the `/api/workspaces/:ws/billing*` and `/api/stripe/webhook` routes, `STRIPE_*` from `Env`, docs and `.dev.vars.example`.
- `canWrite` and the trial checks in `access.ts`, `base-do.ts` (`canRun`), the workspace list and Home's trial banner are removed. Read-only after a trial no longer exists; the hosted project limits by plan instead.
- `MODE` keeps its meaning for sign-up only (`cloud`: open sign-up; `selfhost`: first user owns the instance, invite-only after).
- The four columns are no longer used. Migration `0004_hosting.sql` keeps them for this release, so the previous version keeps working during a rollout or a rollback; a later migration drops them (changed after the final review).

## Email verification and password reset

- D1 table `email_tokens (token_hash PRIMARY KEY, user_id, kind, expires_at, used_at)`, kinds `verify` (24 hours) and `reset` (1 hour); tokens are 32 random characters, stored hashed.
- `users.email_verified_at` (new column). Accounts that existed before the migration count as verified.
- Sign-up sends a verification email when email sending is available; the app shows a banner "Check your inbox to confirm your email" with "Send again" until verified. Unverified accounts work normally; the hosted project may require verification before checkout.
- "Forgot password" on the login page sends a reset link; the reset page sets a new password and signs out other sessions. The answer is the same whether or not the address has an account.
- Email goes through the instance's system email (Cloudflare Email Service, `EMAIL` + `EMAIL_FROM`), or a new instance-level setting `MAIL_PROVIDER` with `RESEND_API_KEY` or SMTP settings in environment variables. Without any, the features are hidden and the login page says to ask the instance owner.
- Rate limits: 5 emails per address per hour.

## Generic billing UI

- Settings gets a Billing tab only when `/api/config` reports `billing: true` (the extension has `billing`). It renders `BillingView`.
- Limit errors from the API carry `{ error, limit: { key, limit, upgradeUrl? } }`; the client shows them with the Upgrade button for owners.

## Testing

- Unit and worker tests: the default hosting (no limits beyond today's), a test hosting with small limits (bases, records including a paste and an import, attachments including the hourly recount, workspace automation runs, Workers AI), limit messages and 402 status, plan cache, downgrade keeps data editable, email tokens (expiry, single use, rate limit, same answer for unknown emails), the migration on a database with the old columns.
- The whole existing suite stays green.
- Records go to `docs/verification/` like other features.
