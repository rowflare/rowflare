// The network side of automation steps; the Durable Object provides the real one, tests a fake.
import type { MailProvider, StepOutput } from "../../shared/automations";

export interface HttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MailRequest {
  provider: MailProvider;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  format: "text" | "html";
}

export interface Net {
  http(req: HttpRequest, timeoutMs: number): Promise<HttpResult>;
  email(req: MailRequest, timeoutMs: number): Promise<{ messageId?: string }>;
  ai(req: AiStepRequest, timeoutMs: number): Promise<{ text: string }>;
}

export interface AiStepRequest {
  serviceId: string;
  model?: string;
  system: string;
  prompt: string;
}

/** A step failure. `retry` marks failures worth trying again: timeouts, connection errors, 5xx and 429. */
export class StepError extends Error {
  constructor(message: string, readonly retry = false, readonly output?: StepOutput) {
    super(message);
  }
}

export const NO_NET: Net = {
  http: async () => {
    throw new StepError("HTTP requests are not available");
  },
  email: async () => {
    throw new StepError("Email sending is not set up for this workspace");
  },
  ai: async () => {
    throw new StepError("AI services are not available");
  },
};
