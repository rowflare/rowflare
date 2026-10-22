// Account emails: the verification link after sign-up, password reset links and sign-in codes.
// They go through the instance's own mail: Cloudflare Email Service (EMAIL + EMAIL_FROM), or MAIL_PROVIDER resend or smtp.
import type { Env } from "./env";
import { randomToken, sha256 } from "./auth";
import { sendResend, sendSystem } from "./auto/mail";
import { buildMime } from "./auto/mime";
import { smtpSend, type SmtpSettings } from "./auto/smtp";

export interface AccountMail {
  to: string;
  subject: string;
  body: string;
}

export type Mailer = (m: AccountMail) => Promise<void>;

export type TokenKind = "verify" | "reset";

const HOUR = 3_600_000;
const TTL: Record<TokenKind, number> = { verify: 24 * HOUR, reset: HOUR };
/** Emails per address per hour, counting both kinds. */
export const MAILS_PER_HOUR = 5;

let testMailer: Mailer | null | undefined;

/** Tests capture mail here; null means "no mail on this instance", undefined restores the real mailer. */
export function setMailerForTests(m: Mailer | null | undefined) {
  testMailer = m;
}

const out = (m: AccountMail) => ({ to: [m.to], cc: [], subject: m.subject, body: m.body, format: "text" as const });

/** How this instance sends account emails, or null when it has no mail set up. */
export function instanceMailer(env: Env): Mailer | null {
  if (testMailer !== undefined) return testMailer;
  if (env.EMAIL && env.EMAIL_FROM) {
    const binding = env.EMAIL;
    const from = env.EMAIL_FROM;
    return async m => void (await sendSystem(binding, from, out(m)));
  }
  const from = env.MAIL_FROM;
  if (!from) return null;
  if (env.MAIL_PROVIDER === "resend" && env.RESEND_API_KEY) {
    const key = env.RESEND_API_KEY;
    return async m => void (await sendResend(key, from, "Rowflare", out(m)));
  }
  if (env.MAIL_PROVIDER === "smtp" && env.SMTP_HOST) {
    const security = env.SMTP_SECURITY === "tls" || env.SMTP_SECURITY === "none" ? env.SMTP_SECURITY : "starttls";
    const settings: SmtpSettings = { host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || (security === "tls" ? 465 : 587), security, username: env.SMTP_USERNAME ?? "" };
    const password = env.SMTP_PASSWORD ?? "";
    return async m => {
      const { openSmtp } = await import("./auto/smtp-socket");
      const data = buildMime({ from, fromName: "Rowflare", to: [m.to], cc: [], subject: m.subject, body: m.body, format: "text", messageId: `<${crypto.randomUUID()}@rowflare>`, date: new Date() });
      await smtpSend(openSmtp, settings, password, { from, to: [m.to] }, data);
    };
  }
  return null;
}

/** Whether the address may get another email this hour. */
export async function underMailLimit(env: Env, userId: string, now = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare("SELECT count(*) n FROM email_tokens WHERE user_id = ? AND created_at > ?").bind(userId, now - HOUR).first<{ n: number }>();
  return (r?.n ?? 0) < MAILS_PER_HOUR;
}

/** A new single-use link token; only its hash is stored. */
export async function issueToken(env: Env, userId: string, kind: TokenKind, now = Date.now()): Promise<string> {
  const token = randomToken(24);
  await env.DB.prepare("INSERT INTO email_tokens (token_hash, user_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256(token), userId, kind, now + TTL[kind], now).run();
  return token;
}

/** Uses a token once; the user id, or null when it is unknown, used, expired or of another kind. */
export async function useToken(env: Env, token: string, kind: TokenKind, now = Date.now()): Promise<string | null> {
  if (!token) return null;
  const row = await env.DB.prepare("UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
    .bind(now, await sha256(token), kind, now)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export function verifyMail(to: string, link: string): AccountMail {
  return {
    to,
    subject: "Confirm your email for Rowflare",
    body: `Confirm your email address by opening this link:\n\n${link}\n\nThe link works for 24 hours. If you did not sign up for Rowflare, you can ignore this email.\n`,
  };
}

export function resetMail(to: string, link: string): AccountMail {
  return {
    to,
    subject: "Reset your Rowflare password",
    body: `Someone asked to reset the password of your Rowflare account. To choose a new password, open this link:\n\n${link}\n\nThe link works for one hour. If you did not ask for this, you can ignore this email; your password stays the same.\n`,
  };
}

export function codeMail(to: string, code: string): AccountMail {
  return {
    to,
    subject: "Your Rowflare sign-in code",
    body: `Your Rowflare sign-in code is:\n\n${code}\n\nIt works for 10 minutes. If you did not try to sign in to Rowflare, you can ignore this email.\n`,
  };
}
