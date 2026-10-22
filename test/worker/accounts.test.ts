import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sessionHeader, signInProvenEmail } from "../../src/worker/accounts";
import { HttpClient, signup } from "./helpers";

const userRow = (email: string) =>
  env.DB.prepare("SELECT id, name, password_hash, email_verified_at FROM users WHERE email = ?").bind(email).first<{ id: string; name: string; password_hash: string | null; email_verified_at: number | null }>();
const ownedWorkspaces = (userId: string) =>
  env.DB.prepare("SELECT w.name FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.role = 'owner'").bind(userId).all<{ name: string }>();

describe("account helpers", () => {
  it("signInProvenEmail creates a verified account with a workspace", async () => {
    const r = await signInProvenEmail(env, { email: "proven-1@example.com" });
    expect(r.created).toBe(true);
    const row = await userRow("proven-1@example.com");
    expect(row).toMatchObject({ id: r.userId, name: "proven-1", password_hash: null });
    expect(row!.email_verified_at).not.toBeNull();
    expect((await ownedWorkspaces(r.userId)).results.map(w => w.name)).toEqual(["proven-1's workspace"]);
  });

  it("signInProvenEmail finds the existing account case-insensitively", async () => {
    const first = await signInProvenEmail(env, { email: "proven-2@example.com" });
    const again = await signInProvenEmail(env, { email: " Proven-2@Example.COM " });
    expect(again).toEqual({ userId: first.userId, created: false });
  });

  it("signInProvenEmail marks an existing unverified account verified", async () => {
    await signup("proven-3@example.com");
    expect((await userRow("proven-3@example.com"))!.email_verified_at).toBeNull();
    await signInProvenEmail(env, { email: "proven-3@example.com" });
    expect((await userRow("proven-3@example.com"))!.email_verified_at).not.toBeNull();
  });

  it("an invite is accepted for a new and an existing account", async () => {
    const owner = await signup("proven-owner@example.com");
    const ws = (await owner.req("GET", "/api/auth/me")).json.workspaces[0].id as string;
    const invite = async () => (await owner.req("POST", `/api/workspaces/${ws}/invites`, { role: "editor" })).json.id as string;
    const fresh = await signInProvenEmail(env, { email: "proven-new@example.com", invite: await invite() });
    expect((await ownedWorkspaces(fresh.userId)).results).toEqual([]);
    const existing = await signInProvenEmail(env, { email: "proven-1@example.com", invite: await invite() });
    for (const userId of [fresh.userId, existing.userId]) {
      const m = await env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(ws, userId).first<{ role: string }>();
      expect(m?.role).toBe("editor");
    }
  });

  it("closed sign-up refuses a new email without an invite", async () => {
    const closed = { ...env, MODE: "selfhost", ALLOW_SIGNUP: "false" };
    await expect(signInProvenEmail(closed, { email: "proven-closed@example.com" })).rejects.toMatchObject({ status: 403, message: "Sign up is invite-only on this instance" });
    expect(await userRow("proven-closed@example.com")).toBeNull();
    expect((await signInProvenEmail(closed, { email: "proven-1@example.com" })).created).toBe(false);
  });

  it("sessionHeader returns a cookie that authenticates", async () => {
    const { userId } = await signInProvenEmail(env, { email: "proven-4@example.com" });
    const c = new HttpClient();
    c.cookie = (await sessionHeader(env, userId, true)).split(";")[0];
    expect((await c.req("GET", "/api/auth/me")).json.user.email).toBe("proven-4@example.com");
  });

  it("an invalid invite creates no account", async () => {
    await expect(signInProvenEmail(env, { email: "proven-badinvite@example.com", invite: "no-such-invite" })).rejects.toMatchObject({ status: 400 });
    expect(await userRow("proven-badinvite@example.com")).toBeNull();
  });
});
