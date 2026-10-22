// Sends automation emails through a workspace's provider: Cloudflare Email Service, Resend or SMTP.
import type { Env } from "../env";
import { LIMITS, type MailProvider } from "../../shared/automations";
import { decryptSecret } from "../secrets";
import { buildMime } from "./mime";
import { smtpSend, type SmtpConn, type SmtpSettings } from "./smtp";
import { StepError } from "./types";

export interface OutMail {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  format: "text" | "html";
}

export interface MailDeps {
  env: Env;
  fetchFn?: typeof fetch;
  openSmtp?: (s: SmtpSettings) => Promise<SmtpConn>;
}

interface MailRow {
  from_address: string;
  from_name: string | null;
  settings: string;
  secret_enc: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepError("The mail server did not answer in time", true)), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendResend(key: string, from: string, fromName: string | null, m: OutMail, fetchFn: typeof fetch = fetch): Promise<{ messageId?: string }> {
  let res: Response;
  try {
    res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromName ? `${fromName} <${from}>` : from, to: m.to, ...(m.cc.length ? { cc: m.cc } : {}), subject: m.subject, ...(m.format === "html" ? { html: m.body } : { text: m.body }) }),
    });
  } catch (e) {
    throw new StepError(`Could not reach Resend: ${message(e)}`, true);
  }
  const text = await res.text();
  if (!res.ok) throw new StepError(`Resend answered ${res.status}: ${text.slice(0, 300)}`, res.status >= 500 || res.status === 429);
  try {
    return { messageId: String(JSON.parse(text).id) };
  } catch {
    return {};
  }
}

export async function sendSystem(binding: SendEmail, from: string, m: OutMail): Promise<{ messageId?: string }> {
  const msg = { from, to: m.to, subject: m.subject, ...(m.cc.length ? { cc: m.cc } : {}), ...(m.format === "html" ? { html: m.body } : { text: m.body }) } as EmailMessageBuilder;
  try {
    return { messageId: (await binding.send(msg)).messageId };
  } catch (e) {
    throw new StepError(`Cloudflare Email could not send: ${message(e)}`);
  }
}

/** Sends one email for a workspace. Failures are StepErrors that say what to fix. */
export async function sendWorkspaceMail(d: MailDeps, workspaceId: string, provider: MailProvider, m: OutMail, timeoutMs: number): Promise<{ messageId?: string }> {
  const { env } = d;
  if (provider === "system") {
    if (!env.EMAIL || !env.EMAIL_FROM) throw new StepError("System email is not set up on this server");
    if (env.MODE === "cloud") {
      const day = new Date().toISOString().slice(0, 10);
      const r = await env.DB.prepare("INSERT INTO mail_usage (workspace_id, day, n) VALUES (?, ?, 1) ON CONFLICT(workspace_id, day) DO UPDATE SET n = n + 1 RETURNING n").bind(workspaceId, day).first<{ n: number }>();
      if ((r?.n ?? 0) > LIMITS.systemMailPerDay) throw new StepError(`This workspace sent its ${LIMITS.systemMailPerDay} system emails for today`);
    }
    return withTimeout(sendSystem(env.EMAIL, env.EMAIL_FROM, m), timeoutMs);
  }
  const row = await env.DB.prepare("SELECT from_address, from_name, settings, secret_enc FROM workspace_mail WHERE workspace_id = ? AND provider = ?").bind(workspaceId, provider).first<MailRow>();
  if (!row) throw new StepError("Email sending is not set up for this workspace");
  if (!env.SECRET_KEY) throw new StepError("SECRET_KEY is not set on this server");
  let secret: string;
  try {
    secret = await decryptSecret(env.SECRET_KEY, row.secret_enc);
  } catch {
    throw new StepError("The saved mail credentials cannot be read; save them again");
  }
  if (provider === "resend") return withTimeout(sendResend(secret, row.from_address, row.from_name, m, d.fetchFn), timeoutMs);
  const settings = JSON.parse(row.settings) as SmtpSettings;
  const open = d.openSmtp ?? (await import("./smtp-socket")).openSmtp;
  const messageId = `<${crypto.randomUUID()}@rowflare>`;
  const data = buildMime({ from: row.from_address, fromName: row.from_name ?? undefined, to: m.to, cc: m.cc, subject: m.subject, body: m.body, format: m.format, messageId, date: new Date() });
  try {
    await withTimeout(smtpSend(open, settings, secret, { from: row.from_address, to: [...m.to, ...m.cc] }, data), timeoutMs);
  } catch (e) {
    if (e instanceof StepError) throw e;
    throw new StepError(`Could not send through SMTP: ${message(e)}`, true);
  }
  return { messageId };
}
