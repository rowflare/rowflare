// Extension point for a hosted edition: plans and their limits, extra routes, billing and hooks.
// Self-hosted instances use DEFAULT_HOSTING; a hosted edition calls extendApp (index.ts) at module load.
import type { Hono } from "hono";
import type { Env } from "./env";
import { HttpError, type Vars } from "./access";
import { LIMITS } from "../shared/automations";

export type LimitKey = "bases" | "records" | "attachments" | "automationRuns" | "workersAiCalls";

export interface PlanLimits {
  bases?: number;
  recordsPerBase?: number;
  attachmentBytes?: number;
  /** Runs per month; n 0 means no limit. */
  automationRuns?: { per: "workspace" | "base"; n: number };
  workersAiCalls?: number;
}

export interface PlanInfo {
  name: string;
  paid: boolean;
  limits: PlanLimits;
  /** Where owners upgrade when a limit is reached. */
  upgradeUrl?: string;
}

/** What the generic Billing tab renders; the hosting decides its content. */
export interface BillingView {
  plan: string;
  paid: boolean;
  usage: { key: string; label: string; used: number; limit: number | null }[];
  notice?: string;
  /** A button opens `url`, or POSTs to `post` and opens the `url` in the answer. */
  actions: { label: string; url?: string; post?: string; style?: "primary" | "default" }[];
  sections?: { title: string; text: string }[];
}

/** A way to sign in that the hosting provides; the sign-in pages show it as a button above the email form. */
export interface SignInOption {
  id: string;
  label: string;
  url: string;
}

export interface Hosting {
  plan(env: Env, workspaceId: string): Promise<PlanInfo>;
  /** Path prefixes under /api/ that take cookie-less POSTs from other sites (payment webhooks); they skip the x-rf check. */
  exemptPaths?: string[];
  /** Adds routes to the app (billing, webhooks, admin); they run after the auth middleware, so c.get("user") works. */
  routes?(app: Hono<{ Bindings: Env; Variables: Vars }>): void;
  /** Extra ways to sign in; the app adds `invite` and `next` to the url when the page has them. */
  signInOptions?(env: Env): SignInOption[];
  onWorkspaceCreated?(env: Env, workspaceId: string, ownerId: string): Promise<void>;
  /** Before an owner deletes a workspace; throwing an HttpError refuses it with that status and message (a live subscription, say). */
  beforeWorkspaceDeleted?(env: Env, workspaceId: string): Promise<void>;
  billing?(env: Env, workspaceId: string, userId: string): Promise<BillingView>;
  /** Hourly, next to the app's own cron work. */
  scheduled?(env: Env, now: number): Promise<void>;
}

const num = (v: string | undefined, fallback?: number) => (v === undefined || v === "" ? fallback : Math.max(0, Number(v) || 0));

export const DEFAULT_HOSTING: Hosting = {
  async plan(env) {
    const ai = num(env.AI_WORKERS_MONTHLY_CALLS);
    return { name: "Self-hosted", paid: true, limits: { automationRuns: { per: "base", n: num(env.AUTOMATION_MONTHLY_RUNS, LIMITS.monthlyRuns)! }, ...(ai ? { workersAiCalls: ai } : {}) } };
  },
};

let current: Hosting = DEFAULT_HOSTING;
const cache = new Map<string, { at: number; plan: PlanInfo }>();

export function setHosting(h: Hosting) {
  current = h;
  cache.clear();
}

export const hosting = (): Hosting => current;

export const hostingExempt = (path: string) => !!current.exemptPaths?.some(p => path.startsWith(p));

export function clearPlanCache(workspaceId?: string) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/** The workspace's plan, cached for a minute in this isolate. */
export async function planFor(env: Env, workspaceId: string): Promise<PlanInfo> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.plan;
  const plan = await current.plan(env, workspaceId);
  cache.set(workspaceId, { at: Date.now(), plan });
  return plan;
}

export interface LimitInfo {
  key: LimitKey;
  limit: number;
  upgradeUrl?: string;
}

/** Turns a failed Durable Object result into an error: a LimitError when a plan limit was reached, otherwise an HttpError. */
export function failure(r: { error: string; status?: number; limit?: LimitInfo }, status: number): HttpError {
  return r.limit ? new LimitError(r.error, r.limit) : new HttpError(r.status ?? status, r.error);
}

/** A plan limit was reached: answered with 402 and the limit, so the app can offer an upgrade. */
export class LimitError extends HttpError {
  constructor(message: string, readonly limit: { key: LimitKey; limit: number; upgradeUrl?: string }) {
    super(402, message);
  }
}
