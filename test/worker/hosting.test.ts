import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, { extendApp } from "../../src/worker/index";
import { DEFAULT_HOSTING, planFor, setHosting, type Hosting } from "../../src/worker/hosting";
import { HttpError } from "../../src/worker/access";

const created: string[] = [];
const ran: number[] = [];
const testHosting: Hosting = {
  async plan() {
    return { name: "Test", paid: false, limits: { bases: 1 } };
  },
  routes(app) {
    app.get("/api/test-hosting/ping", c => c.json({ pong: true, user: c.get("user")?.email ?? null }));
  },
  async onWorkspaceCreated(_env, ws) {
    created.push(ws);
  },
  async billing() {
    return { plan: "Test", paid: false, usage: [], actions: [] };
  },
  async scheduled(_env, now) {
    ran.push(now);
  },
};
extendApp(testHosting);

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://app.test" + path, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("hosting extension", () => {
  afterEach(() => setHosting(DEFAULT_HOSTING));

  it("config lists the hosting's sign-in options", async () => {
    const option = { id: "example", label: "Continue with Example", url: "/api/auth/example/start" };
    setHosting({ ...testHosting, signInOptions: () => [option] });
    expect((await (await call("/api/config")).json<{ signInOptions: unknown }>()).signInOptions).toEqual([option]);
    setHosting(DEFAULT_HOSTING);
    expect((await (await call("/api/config")).json<{ signInOptions: unknown }>()).signInOptions).toEqual([]);
  });

  it("the default is self-hosted with today's automation limit", async () => {
    setHosting(DEFAULT_HOSTING);
    expect(await planFor(env, "ws-none")).toEqual({ name: "Self-hosted", paid: true, limits: { automationRuns: { per: "base", n: 10000 } } });
    expect((await (await call("/api/config")).json<any>()).billing).toBe(false);
  });

  it("a registered hosting adds routes, billing, workspace and cron hooks", async () => {
    setHosting(testHosting);
    expect((await (await call("/api/config")).json<any>()).billing).toBe(true);
    expect(await (await call("/api/test-hosting/ping")).json()).toEqual({ pong: true, user: null });
    const signup = await call("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json", "x-rf": "1" }, body: JSON.stringify({ email: "hosting-1@example.com", password: "correct horse" }) });
    expect(signup.status).toBe(200);
    expect(created.length).toBe(1);
    const ctx = createExecutionContext();
    await worker.scheduled!({ scheduledTime: 1, cron: "17 * * * *", noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(ran.length).toBe(1);
  });

  it("a hosting can refuse to delete a workspace", async () => {
    setHosting({ ...DEFAULT_HOSTING, beforeWorkspaceDeleted: async () => { throw new HttpError(409, "Cancel the subscription first"); } });
    const signup = await call("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json", "x-rf": "1" }, body: JSON.stringify({ email: "hosting-del@example.com", password: "correct horse" }) });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0];
    const ws = (await (await call("/api/workspaces", { headers: { cookie } })).json<any[]>())[0].id;
    const r = await call(`/api/workspaces/${ws}`, { method: "DELETE", headers: { cookie, "x-rf": "1" } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "Cancel the subscription first" });
    expect(await env.DB.prepare("SELECT 1 x FROM workspaces WHERE id = ?").bind(ws).first()).not.toBeNull();
  });

  it("unknown API paths still answer 404 JSON", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

describe("billing is not part of the app", () => {
  it("the old billing columns stay this release, unused, so the previous version keeps working during a rollout", async () => {
    await call("/api/config");
    const cols = (await env.DB.prepare("PRAGMA table_info(workspaces)").all<{ name: string }>()).results.map(r => r.name);
    expect(cols).toEqual(["id", "name", "created_at", "trial_ends_at", "stripe_customer_id", "stripe_subscription_id", "subscription_status"]);
  });
  it("workspace lists carry no billing state and old billing routes are gone", async () => {
    const signup = await call("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json", "x-rf": "1" }, body: JSON.stringify({ email: "hosting-2@example.com", password: "correct horse" }) });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0];
    const list = await (await call("/api/workspaces", { headers: { cookie } })).json<any[]>();
    expect(Object.keys(list[0]).sort()).toEqual(["id", "name", "role"]);
    expect((await call(`/api/workspaces/${list[0].id}/billing/checkout`, { method: "POST", headers: { cookie, "x-rf": "1" } })).status).toBe(404);
  });
});
