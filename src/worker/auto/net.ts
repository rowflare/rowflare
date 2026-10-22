// The real network side of automation steps for a base's Durable Object.
import type { Env } from "../env";
import { httpRequest } from "./http";
import { sendWorkspaceMail } from "./mail";
import type { SmtpConn, SmtpSettings } from "./smtp";
import { StepError, type Net } from "./types";

export interface NetOptions {
  fetchFn?: typeof fetch;
  openSmtp?: (s: SmtpSettings) => Promise<SmtpConn>;
  /** AI calls through the base's services, usage and quota (the Durable Object provides it). */
  ai?: Net["ai"];
}

export function createNet(env: Env, workspaceId: () => Promise<string | null>, opts: NetOptions = {}): Net {
  return {
    http: (req, timeoutMs) => httpRequest(req, { timeoutMs, allowPrivate: env.AUTOMATION_ALLOW_PRIVATE === "true", fetchFn: opts.fetchFn }),
    async email(req, timeoutMs) {
      const ws = await workspaceId();
      if (!ws) throw new StepError("This base belongs to no workspace");
      return sendWorkspaceMail({ env, fetchFn: opts.fetchFn, openSmtp: opts.openSmtp }, ws, req.provider, req, timeoutMs);
    },
    ai: (req, timeoutMs) => (opts.ai ? opts.ai(req, timeoutMs) : Promise.reject(new StepError("AI services are not available"))),
  };
}
