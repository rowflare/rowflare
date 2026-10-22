// Thin fetch wrapper for the Rowflare Worker API.
import type { Member, Role, Schema } from "../shared/types";

/** A plan limit the request ran into (answered with 402). */
export interface LimitInfo {
  key: string;
  limit: number;
  upgradeUrl?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public limit?: LimitInfo) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "x-rf": "1", ...(init.headers as Record<string, string> | undefined) };
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer) payload = body as BodyInit;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { ...init, method, headers, body: payload, credentials: "same-origin" });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText || "Request failed", data?.limit);
  return data as T;
}

export const get = <T = any>(path: string) => api<T>("GET", path);
export const post = <T = any>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const patch = <T = any>(path: string, body?: unknown) => api<T>("PATCH", path, body ?? {});
export const del = <T = any>(path: string) => api<T>("DELETE", path);

export interface Me {
  user: { id: string; email: string; name: string; emailVerified?: boolean } | null;
  workspaces: WorkspaceInfo[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  role: Role;
}

export interface AppConfig {
  mode: "selfhost" | "cloud";
  signupOpen: boolean;
  /** A hosting extension provides a Billing tab. */
  billing: boolean;
  /** The instance can send account emails (verification, password reset). */
  accountMail: boolean;
  /** "code": people sign in with their email and a code sent to it; there are no passwords. */
  emailAuth: "password" | "code";
  /** Ways to sign in from the hosting, shown as buttons above the email form. */
  signInOptions: { id: string; label: string; url: string }[];
  templates: { slug: string; name: string; description: string }[];
}

export interface BaseInfo {
  base: { id: string; workspace_id: string; name: string; color: string };
  role: Role;
  writable: boolean;
  schema: Schema;
  members: Member[];
  me: { id: string; email: string; name: string };
}

let configPromise: Promise<AppConfig> | null = null;
export function getConfig(): Promise<AppConfig> {
  if (!configPromise) configPromise = get<AppConfig>("/api/config");
  return configPromise;
}

export function fileUrl(key: string): string {
  return "/api/files/" + key.split("/").map(encodeURIComponent).join("/");
}

export async function uploadFile(path: string, file: File): Promise<{ id: string; name: string; size: number; type: string; key: string }> {
  return api("POST", `${path}?name=${encodeURIComponent(file.name)}`, file, { headers: { "Content-Type": file.type || "application/octet-stream" } });
}
