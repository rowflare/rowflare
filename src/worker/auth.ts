// Password hashing, sessions and API tokens. Everything is stored hashed in D1.
import type { Env } from "./env";

export interface User {
  id: string;
  email: string;
  name: string;
}

export const SESSION_COOKIE = "rf_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // Workers caps PBKDF2 at 100,000 iterations.

const enc = new TextEncoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string): Promise<string> {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const actual = await pbkdf2(password, unb64(salt), Number(iter));
  const expected = unb64(hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export async function createSession(env: Env, userId: string): Promise<{ token: string; expires: number }> {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 86400000;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), userId, expires).run();
  return { token, expires };
}

export function sessionCookie(token: string, expires: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expires).toUTCString()}${secure ? "; Secure" : ""}`;
}

export function clearCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

/** Resolves the caller from the session cookie or a `Bearer` personal access token. */
export async function authenticate(env: Env, req: Request): Promise<{ user: User; via: "session" | "token"; sessionId?: string } | null> {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const hash = await sha256(auth.slice(7).trim());
    const row = await env.DB.prepare("SELECT u.id, u.email, u.name, t.id tid FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?")
      .bind(hash)
      .first<{ id: string; email: string; name: string; tid: string }>();
    if (!row) return null;
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.tid).run();
    return { user: { id: row.id, email: row.email, name: row.name }, via: "token" };
  }
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const sid = await sha256(token);
  const row = await env.DB.prepare("SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?")
    .bind(sid)
    .first<{ id: string; email: string; name: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { user: { id: row.id, email: row.email, name: row.name }, via: "session", sessionId: sid };
}
