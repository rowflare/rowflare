// Accounts and their first workspace, shared by every way of signing in (password, email code, a hosting's own sign-in).
import type { Env } from "./env";
import { HttpError, workspaceMembers } from "./access";
import { createSession, randomToken, sessionCookie } from "./auth";
import { hosting } from "./hosting";
import type { Role } from "../shared/types";

export const newId = (prefix: string) => prefix + randomToken(12).replace(/[-_]/g, "x");

export const normalEmail = (email: string) => email.trim().toLowerCase();

export async function signupOpen(env: Env): Promise<boolean> {
  if (env.MODE === "cloud" || env.ALLOW_SIGNUP === "true") return true;
  const any = await env.DB.prepare("SELECT 1 x FROM users LIMIT 1").first();
  return !any;
}

export async function createWorkspace(env: Env, userId: string, name: string): Promise<string> {
  const wsId = newId("ws");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").bind(wsId, name, Date.now()),
    env.DB.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(wsId, userId, Date.now()),
  ]);
  await hosting().onWorkspaceCreated?.(env, wsId, userId);
  return wsId;
}

/** Pushes the member list into each base so user fields can show names. */
export async function syncMembers(env: Env, wsId: string) {
  const members = await workspaceMembers(env, wsId);
  const { results } = await env.DB.prepare("SELECT id FROM bases WHERE workspace_id = ?").bind(wsId).all<{ id: string }>();
  await Promise.all(results.map(b => env.BASE.get(env.BASE.idFromName(b.id)).setMembers(members)));
}

/** Refuses an invite that does not exist or has expired, before anything is written. */
export async function checkInvite(env: Env, inviteId: string): Promise<void> {
  const inv = await env.DB.prepare("SELECT expires_at FROM invites WHERE id = ?").bind(inviteId).first<{ expires_at: number }>();
  if (!inv || inv.expires_at < Date.now()) throw new HttpError(400, "This invite link is invalid or expired");
}

export async function acceptInvite(env: Env, inviteId: string, userId: string): Promise<string> {
  const inv = await env.DB.prepare("SELECT * FROM invites WHERE id = ?").bind(inviteId).first<{ workspace_id: string; role: Role; expires_at: number }>();
  if (!inv || inv.expires_at < Date.now()) throw new HttpError(400, "This invite link is invalid or expired");
  await env.DB.prepare("INSERT OR IGNORE INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(inv.workspace_id, userId, inv.role, Date.now()).run();
  await syncMembers(env, inv.workspace_id);
  return inv.workspace_id;
}

/** Creates a user with the invite's workspace or a first workspace of their own; the email is normalised and free. */
export async function createAccount(env: Env, a: { email: string; name?: string; passwordHash?: string | null; verified: boolean; invite?: string }): Promise<string> {
  if (a.invite) await checkInvite(env, a.invite);
  const userId = newId("usr");
  const name = a.name?.trim() || a.email.split("@")[0];
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(userId, a.email, name, a.passwordHash ?? null, a.verified ? now : null, now)
    .run();
  if (a.invite) await acceptInvite(env, a.invite, userId);
  else await createWorkspace(env, userId, `${name}'s workspace`);
  return userId;
}

/** Signs in the owner of an email that was just proven (a code, or a sign-in provider), creating the account when sign-up allows it. */
export async function signInProvenEmail(env: Env, a: { email: string; name?: string; invite?: string }): Promise<{ userId: string; created: boolean }> {
  const email = normalEmail(a.email);
  const row = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (row) {
    await env.DB.prepare("UPDATE users SET email_verified_at = coalesce(email_verified_at, ?) WHERE id = ?").bind(Date.now(), row.id).run();
    if (a.invite) await acceptInvite(env, a.invite, row.id);
    return { userId: row.id, created: false };
  }
  if (!a.invite && !(await signupOpen(env))) throw new HttpError(403, "Sign up is invite-only on this instance");
  return { userId: await createAccount(env, { email, name: a.name, verified: true, invite: a.invite }), created: true };
}

/** A new session for the user, as the Set-Cookie value. */
export async function sessionHeader(env: Env, userId: string, secure: boolean): Promise<string> {
  const s = await createSession(env, userId);
  return sessionCookie(s.token, s.expires, secure);
}
