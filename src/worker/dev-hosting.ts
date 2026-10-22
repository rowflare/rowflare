// A test hosting for local development only: small limits and a fake Billing tab, to check the app's limit messages and
// the generic billing screen. It is installed only when DEV_TEST_HOSTING=true (in .dev.vars); never set that in production.
import type { Hono } from "hono";
import type { Env } from "./env";
import { requireUser, type Vars } from "./access";
import { DEFAULT_HOSTING, clearPlanCache, hosting, setHosting, type Hosting, type PlanLimits } from "./hosting";
import { workspaceUsage } from "./limits";

const FREE: PlanLimits = { bases: 3, recordsPerBase: 50, attachmentBytes: 1_000_000, automationRuns: { per: "workspace", n: 10 }, workersAiCalls: 5 };
const PAID: PlanLimits = { bases: 100, recordsPerBase: 5000, attachmentBytes: 100_000_000, automationRuns: { per: "workspace", n: 1000 }, workersAiCalls: 100 };

/** Workspaces "upgraded" in this isolate; a restart of wrangler dev resets them. */
const paid = new Set<string>();

export const DEV_HOSTING: Hosting = {
  async plan(_env, ws) {
    return paid.has(ws) ? { name: "Dev paid", paid: true, limits: PAID } : { name: "Dev free", paid: false, limits: FREE };
  },
  async billing(env, ws) {
    const { usage } = await workspaceUsage(env, ws);
    const isPaid = paid.has(ws);
    return {
      plan: isPaid ? "Dev paid" : "Dev free",
      paid: isPaid,
      usage,
      notice: isPaid ? undefined : "A test plan from DEV_TEST_HOSTING with small limits.",
      actions: isPaid ? [{ label: "Back to free (test)", post: "/api/dev-hosting/plan?to=free" }] : [{ label: "Upgrade (test)", post: "/api/dev-hosting/plan?to=paid", style: "primary" }],
      sections: [{ title: "About this tab", text: "A hosted edition shows its plans, prices and invoices here.\nThis test view only switches between two plans in memory." }],
    };
  },
};

/** Installs the test hosting on the first request or object when DEV_TEST_HOSTING is "true". */
export function useDevHosting(env: Env) {
  if (env.DEV_TEST_HOSTING === "true" && hosting() === DEFAULT_HOSTING) setHosting(DEV_HOSTING);
}

export function devHostingRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>) {
  app.post("/api/dev-hosting/plan", async c => {
    if (c.env.DEV_TEST_HOSTING !== "true") return c.json({ error: "Not found" }, 404);
    requireUser(c);
    const ws = String(((await c.req.json().catch(() => ({}))) as { workspaceId?: string }).workspaceId ?? "");
    if (c.req.query("to") === "paid") paid.add(ws);
    else paid.delete(ws);
    clearPlanCache(ws);
    const { results } = await c.env.DB.prepare("SELECT id FROM bases WHERE workspace_id = ?").bind(ws).all<{ id: string }>();
    await Promise.all(results.map(b => c.env.BASE.get(c.env.BASE.idFromName(b.id)).planChanged()));
    return c.json({ url: `/settings/billing?ws=${ws}` });
  });
}
