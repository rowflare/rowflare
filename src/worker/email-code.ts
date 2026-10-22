// Sign-in with an email and a 6-digit code sent to it (AUTH_EMAIL=code). Codes are stored hashed and keyed by email,
// since the account is created only once the code proves the address.
import type { Env } from "./env";
import { sha256 } from "./auth";
import { instanceMailer, MAILS_PER_HOUR } from "./account-mail";
import { newId } from "./accounts";

const CODE_TTL = 10 * 60_000;
const MAX_TRIES = 5;
const HOUR = 3_600_000;

export function emailAuthMode(env: Env): "password" | "code" {
  return env.AUTH_EMAIL === "code" && instanceMailer(env) ? "code" : "password";
}

/** Codes one network address may request an hour, and codes the whole instance sends an hour. */
export const CODES_PER_IP_HOUR = 10;
export const CODES_PER_HOUR_TOTAL = 1000;

/**
 * A new code for the email, voiding earlier ones; null when the address, the network address (when known) or the
 * instance already had its codes for this hour. The limits are checked inside the insert, so a burst cannot pass them.
 */
export async function issueCode(env: Env, email: string, ip: string | null, now = Date.now()): Promise<string | null> {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const code = String(n).padStart(6, "0");
  const id = newId("ec");
  const since = now - HOUR;
  const row = await env.DB.prepare(
    `INSERT INTO email_codes (id, email, ip, code_hash, expires_at, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE (SELECT count(*) FROM email_codes WHERE email = ?2 AND created_at > ?7) < ?8
       AND (?3 IS NULL OR (SELECT count(*) FROM email_codes WHERE ip = ?3 AND created_at > ?7) < ?9)
       AND (SELECT count(*) FROM email_codes WHERE created_at > ?7) < ?10
     RETURNING id`,
  )
    .bind(id, email, ip, await sha256(`${email}:${code}`), now + CODE_TTL, now, since, MAILS_PER_HOUR, CODES_PER_IP_HOUR, CODES_PER_HOUR_TOTAL)
    .first();
  if (!row) return null;
  await env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE email = ? AND used_at IS NULL AND id != ?").bind(now, email, id).run();
  return code;
}

/** True once for the latest live code of the email. Every try is counted before the comparison, so parallel guesses share the limit. */
export async function checkCode(env: Env, email: string, code: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(
    `UPDATE email_codes SET tries = tries + 1
     WHERE id = (SELECT id FROM email_codes WHERE email = ?1 AND used_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1) AND tries < ?3
     RETURNING id, code_hash`,
  )
    .bind(email, now, MAX_TRIES)
    .first<{ id: string; code_hash: string }>();
  if (!row || row.code_hash !== (await sha256(`${email}:${code.trim()}`))) return false;
  const used = await env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL RETURNING id").bind(now, row.id).first();
  return !!used;
}
