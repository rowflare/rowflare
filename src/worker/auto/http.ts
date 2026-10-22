// Outbound HTTP for automation steps: URL checks, a timeout, a size limit and retryable errors.
import { LIMITS } from "../../shared/automations";
import { StepError, type HttpRequest, type HttpResult } from "./types";

/** Loopback, private, link-local and shared address ranges, and localhost names. Host names are not resolved. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

export function checkUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new StepError(`Invalid URL ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new StepError("Only http and https URLs are allowed");
  if (!allowPrivate && isPrivateHost(u.hostname)) throw new StepError("Requests to private network addresses are not allowed");
  return u;
}

export async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      size = max;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function httpRequest(req: HttpRequest, opts: { timeoutMs: number; allowPrivate: boolean; fetchFn?: typeof fetch }): Promise<HttpResult> {
  const url = checkUrl(req.url, opts.allowPrivate);
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    try {
      headers.append(k, v);
    } catch {
      throw new StepError(`Invalid header ${k}`);
    }
  }
  const body = req.method === "GET" ? undefined : req.body;
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", /^\s*[[{]/.test(body) ? "application/json" : "text/plain; charset=utf-8");
  if (!headers.has("user-agent")) headers.set("user-agent", "Rowflare-Automations/1.0");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const failed = (e: unknown) => new StepError(ctrl.signal.aborted ? "The server did not answer in time" : `Could not connect: ${e instanceof Error ? e.message : String(e)}`, true);
  try {
    let res: Response;
    try {
      // Redirects are not followed, so a redirect cannot lead into a private network.
      res = await (opts.fetchFn ?? fetch)(url.toString(), { method: req.method, headers, body, redirect: "manual", signal: ctrl.signal });
    } catch (e) {
      throw failed(e);
    }
    // The Docker server resolves host names and refuses private addresses (docker/server.mjs).
    if (res.headers.get("x-rowflare-blocked") === "private") throw new StepError("Requests to private network addresses are not allowed");
    let text: string;
    try {
      text = await readLimited(res, LIMITS.httpReadBytes);
    } catch (e) {
      throw failed(e);
    }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text };
  } finally {
    clearTimeout(timer);
  }
}
