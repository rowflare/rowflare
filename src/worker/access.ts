// Request context helpers shared by the app routes and the public API.
import type { Context } from "hono";
import type { Env } from "./env";
import type { User } from "./auth";
import type { Actor } from "./base/store";
import type { BaseDO } from "./base-do";
import type { Member, Role } from "../shared/types";

/** RPC view of the Base Durable Object (workers-types maps `unknown` payloads to never, so type it directly). */
export type BaseStub = {
  [K in "init" | "destroy" | "setMembers" | "schema" | "query" | "rows" | "aggregate" | "aggregateRecords" | "exportCsv" | "findTable" | "rowOp" | "schemaOp" | "startAirtableImport" | "automationList" | "automationOp" | "automationRuns" | "webhook" | "runButton" | "testRun" | "retryRun" | "aiWake" | "aiGenerate" | "aiStop" | "aiStatus" | "aiPreview" | "checkRoom" | "noteFile" | "storageScan" | "filesSwept" | "usageSummary" | "planChanged"]: BaseDO[K] extends (...a: infer A) => infer R
    ? (...a: A) => Promise<Awaited<R>>
    : never;
} & { fetch(req: Request): Promise<Response> };

export type Vars = { user: User | null; via: "session" | "token" | null };
export type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

export const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function requireUser(c: AppContext): User {
  const u = c.get("user");
  if (!u) throw new HttpError(401, "Sign in required");
  return u;
}

export async function workspaceMembers(env: Env, wsId: string): Promise<Member[]> {
  const { results } = await env.DB.prepare("SELECT u.id, u.name, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at")
    .bind(wsId)
    .all<Member>();
  return results;
}

export const stubFor = (env: Env, baseId: string) => env.BASE.get(env.BASE.idFromName(baseId)) as unknown as BaseStub;

export interface BaseAccess {
  user: User;
  role: Role;
  base: { id: string; workspace_id: string; name: string; color: string };
  writable: boolean;
  stub: BaseStub;
  actor: Actor;
}

export async function baseAccess(c: AppContext, baseId: string, need: "read" | "write" | "admin"): Promise<BaseAccess> {
  const user = requireUser(c);
  const row = await c.env.DB.prepare(
    "SELECT b.id, b.workspace_id, b.name, b.color, m.role FROM bases b JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = ? WHERE b.id = ?",
  )
    .bind(user.id, baseId)
    .first<{ id: string; workspace_id: string; name: string; color: string; role: Role }>();
  if (!row) throw new HttpError(404, "Base not found");
  const writable = ROLE_RANK[row.role] >= ROLE_RANK.editor;
  if (need === "write" && !writable) throw new HttpError(403, "You have read-only access to this base");
  if (need === "admin" && row.role !== "owner") throw new HttpError(403, "Only workspace owners can do that");
  return {
    user,
    role: row.role,
    base: { id: row.id, workspace_id: row.workspace_id, name: row.name, color: row.color },
    writable,
    stub: stubFor(c.env, baseId),
    actor: { userId: user.id, name: user.name },
  };
}

