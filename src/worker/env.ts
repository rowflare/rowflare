import type { BaseDO } from "./base-do";

export interface Env {
  DB: D1Database;
  BASE: DurableObjectNamespace<BaseDO>;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  MODE?: string;
  ALLOW_SIGNUP?: string;
  APP_URL?: string;
  BENCH_TOKEN?: string;
  /** Automation runs per base per month; "0" means no limit. Default 10000. */
  AUTOMATION_MONTHLY_RUNS?: string;
  /** "true" lets automation HTTP steps reach localhost and private addresses (self-hosting on a private network, local tests). */
  AUTOMATION_ALLOW_PRIVATE?: string;
  /** Encrypts mail credentials stored in D1; any long random string. */
  SECRET_KEY?: string;
  /** Cloudflare Email Service binding (`send_email`), for the "system" mail provider. */
  EMAIL?: SendEmail;
  /** Sender address for system mail; its domain must be onboarded to Email Service. */
  EMAIL_FROM?: string;
  /** Account emails (verification, password reset) when there is no EMAIL binding: "resend" or "smtp". */
  MAIL_PROVIDER?: string;
  /** "code" signs people in with their email and a 6-digit code sent to it, instead of passwords; needs account email. */
  AUTH_EMAIL?: string;
  /** Sender address for account emails sent through MAIL_PROVIDER. */
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  /** "starttls" (default), "tls" or "none". */
  SMTP_SECURITY?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  /** Workers AI binding (`"ai": { "binding": "AI" }` in wrangler.jsonc); offers the built-in "Workers AI" service. */
  AI?: import("./ai/providers").WorkersAi;
  /** Workers AI calls per workspace per month; unset means no limit. */
  AI_WORKERS_MONTHLY_CALLS?: string;
  /** Local development only: "true" installs a test hosting with small limits and a fake Billing tab (dev-hosting.ts). */
  DEV_TEST_HOSTING?: string;
  TEST_MIGRATIONS?: unknown;
}
