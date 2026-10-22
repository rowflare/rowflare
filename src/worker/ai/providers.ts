// Calls a model: Anthropic Messages, OpenAI-compatible chat completions, or the Workers AI binding.
// Errors come back as AiError with a kind the engine acts on: retry later, key rejected, or fail the cell.
import { AI_LIMITS, WORKERS_IMAGE_MODEL, type AiServiceKind } from "../../shared/ai";
import { checkUrl, readLimited } from "../auto/http";

export interface ModelService {
  id: string;
  kind: AiServiceKind;
  baseUrl?: string | null;
  model: string;
  key?: string;
}

export interface ModelImage {
  type: string;
  /** Base64 without the data: prefix. */
  data: string;
}

export interface ModelRequest {
  system: string;
  prompt: string;
  images: ModelImage[];
  /** Overrides the service's default model. */
  model?: string;
}

export interface WorkersAi {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface AiDeps {
  fetchFn?: typeof fetch;
  ai?: WorkersAi;
  allowPrivate: boolean;
  timeoutMs: number;
}

export class AiError extends Error {
  constructor(message: string, readonly kind: "retry" | "auth" | "fail", readonly retryAfter?: number) {
    super(message);
  }
}

const CUT = "The answer was cut off";
const MAX_READ = 1024 * 1024;

function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, AI_LIMITS.maxRetryAfter) : undefined;
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === "string") return m.slice(0, 300);
  } catch {
    // Not JSON.
  }
  return body.slice(0, 300);
}

async function post(url: string, headers: Record<string, string>, body: unknown, d: AiDeps): Promise<unknown> {
  let u: URL;
  try {
    u = checkUrl(url, d.allowPrivate);
  } catch (e) {
    throw new AiError(e instanceof Error ? e.message : String(e), "fail");
  }
  if (u.protocol === "http:" && !d.allowPrivate) throw new AiError("The service address must start with https://", "fail");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), d.timeoutMs);
  try {
    let res: Response;
    try {
      res = await (d.fetchFn ?? fetch)(u.toString(), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual", signal: ctrl.signal });
    } catch (e) {
      throw new AiError(ctrl.signal.aborted ? "The service did not answer in time" : `Could not reach the service: ${e instanceof Error ? e.message : String(e)}`, "retry");
    }
    if (res.headers.get("x-rowflare-blocked") === "private") throw new AiError("Requests to private network addresses are not allowed", "fail");
    const text = await readLimited(res, MAX_READ).catch(e => {
      throw new AiError(`The service stopped answering: ${e instanceof Error ? e.message : String(e)}`, "retry");
    });
    if (res.status === 401 || res.status === 403) throw new AiError("The key was rejected", "auth");
    if (res.status === 429 || res.status >= 500) throw new AiError(`The service answered ${res.status}: ${errorText(text)}`, "retry", retryAfter(res.headers.get("retry-after")));
    if (res.status >= 300) throw new AiError(`The service answered ${res.status}: ${errorText(text)}`, "fail");
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError("The service sent an answer that is not JSON", "fail");
    }
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI's own reasoning models refuse max_tokens; other compatible services expect it. */
const limitKey = (base: string) => (/^https:\/\/api\.openai\.com(\/|$)/.test(base) ? "max_completion_tokens" : "max_tokens");

async function openai(s: ModelService, r: ModelRequest, d: AiDeps): Promise<string> {
  const base = (s.baseUrl ?? "").replace(/\/+$/, "");
  const content = r.images.length ? [{ type: "text", text: r.prompt }, ...r.images.map(i => ({ type: "image_url", image_url: { url: `data:${i.type};base64,${i.data}` } }))] : r.prompt;
  const j = (await post(`${base}/chat/completions`, s.key ? { Authorization: `Bearer ${s.key}` } : {}, { model: r.model || s.model, [limitKey(base)]: AI_LIMITS.outputTokens, messages: [{ role: "system", content: r.system }, { role: "user", content }] }, d)) as {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
  };
  const choice = j.choices?.[0];
  const c = choice?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map(p => (typeof p?.text === "string" ? p.text : "")).join("") : "";
  if (!text.trim()) throw new AiError(choice?.finish_reason === "length" ? CUT : "The service sent an empty answer", "fail");
  return text;
}

async function anthropic(s: ModelService, r: ModelRequest, d: AiDeps): Promise<string> {
  const content = [...r.images.map(i => ({ type: "image", source: { type: "base64", media_type: i.type, data: i.data } })), { type: "text", text: r.prompt }];
  const j = (await post("https://api.anthropic.com/v1/messages", { "x-api-key": s.key ?? "", "anthropic-version": "2023-06-01" }, { model: r.model || s.model, max_tokens: AI_LIMITS.outputTokens, system: r.system, messages: [{ role: "user", content }] }, d)) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
  };
  const text = (j.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("");
  if (!text.trim()) throw new AiError(j.stop_reason === "max_tokens" ? CUT : "The service sent an empty answer", "fail");
  return text;
}

async function workers(s: ModelService, r: ModelRequest, d: AiDeps): Promise<string> {
  if (!d.ai) throw new AiError("Workers AI is not available on this server", "fail");
  const image = r.images[0];
  const model = image ? WORKERS_IMAGE_MODEL : r.model || s.model;
  const input: Record<string, unknown> = { messages: [{ role: "system", content: r.system }, { role: "user", content: r.prompt }], max_tokens: AI_LIMITS.outputTokens };
  // The vision model takes one image as bytes.
  if (image) input.image = [...Uint8Array.from(atob(image.data), ch => ch.charCodeAt(0))];
  let out: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    out = await Promise.race([d.ai.run(model, input), new Promise((_, rej) => (timer = setTimeout(() => rej(new AiError("Workers AI did not answer in time", "retry")), d.timeoutMs)))]);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError(`Workers AI failed: ${e instanceof Error ? e.message : String(e)}`, "retry");
  } finally {
    clearTimeout(timer);
  }
  const text = typeof (out as { response?: unknown })?.response === "string" ? (out as { response: string }).response : "";
  // Workers AI does not say why an answer is empty; running out of tokens is the usual reason.
  if (!text.trim()) throw new AiError("The answer was cut off or empty", "fail");
  return text;
}

export function callModel(s: ModelService, r: ModelRequest, d: AiDeps): Promise<string> {
  if (s.kind === "anthropic") return anthropic(s, r, d);
  if (s.kind === "workers") return workers(s, r, d);
  return openai(s, r, d);
}
