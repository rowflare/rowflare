import { describe, expect, it } from "vitest";
import { AiError, callModel, type ModelService } from "../../src/worker/ai/providers";

function fake(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const deps = (fetchFn: typeof fetch) => ({ fetchFn, allowPrivate: false, timeoutMs: 5000 });
const openai: ModelService = { id: "ais1", kind: "openai", baseUrl: "https://api.deepseek.com/", model: "deepseek-flash", key: "sk-test" };
const anthropic: ModelService = { id: "ais2", kind: "anthropic", model: "claude-sonnet-5-5", key: "sk-ant" };
const req = { system: "Answer with yes or no only.", prompt: "Is water wet?", images: [] };

describe("OpenAI-compatible", () => {
  it("sends chat completions and reads the answer, ignoring reasoning", async () => {
    const f = fake(200, { choices: [{ message: { content: "Yes", reasoning_content: "thinking" }, finish_reason: "stop" }] });
    expect(await callModel(openai, req, deps(f.fetchFn))).toBe("Yes");
    expect(f.calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body).toMatchObject({ model: "deepseek-flash", max_tokens: 8000, messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }] });
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });
  it("uses max_completion_tokens for OpenAI itself, whose reasoning models refuse max_tokens", async () => {
    const f = fake(200, { choices: [{ message: { content: "Yes" } }] });
    await callModel({ ...openai, baseUrl: "https://api.openai.com/v1" }, req, deps(f.fetchFn));
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.max_completion_tokens).toBe(8000);
    expect(body.max_tokens).toBeUndefined();
  });
  it("sends images as data URLs", async () => {
    const f = fake(200, { choices: [{ message: { content: "Red" } }] });
    await callModel(openai, { ...req, images: [{ type: "image/png", data: "AAAA" }] }, deps(f.fetchFn));
    const content = JSON.parse(String(f.calls[0].init.body)).messages[1].content;
    expect(content).toEqual([{ type: "text", text: req.prompt }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
  });
  it("empty content with finish_reason length is cut off", async () => {
    const f = fake(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] });
    await expect(callModel(openai, req, deps(f.fetchFn))).rejects.toMatchObject({ kind: "fail", message: "The answer was cut off" });
  });
  it("maps status codes to error kinds", async () => {
    await expect(callModel(openai, req, deps(fake(401, { error: { message: "bad key" } }).fetchFn))).rejects.toMatchObject({ kind: "auth" });
    await expect(callModel(openai, req, deps(fake(429, "slow down", { "retry-after": "20" }).fetchFn))).rejects.toMatchObject({ kind: "retry", retryAfter: 20_000 });
    await expect(callModel(openai, req, deps(fake(503, "down").fetchFn))).rejects.toMatchObject({ kind: "retry" });
    await expect(callModel(openai, req, deps(fake(400, { error: { message: "Model not found" } }).fetchFn))).rejects.toMatchObject({ kind: "fail", message: "The service answered 400: Model not found" });
  });
  it("refuses private addresses", async () => {
    const f = fake(200, {});
    await expect(callModel({ ...openai, baseUrl: "http://127.0.0.1:11434/v1" }, req, deps(f.fetchFn))).rejects.toMatchObject({ kind: "fail" });
    expect(f.calls.length).toBe(0);
  });
  it("a network error is retried", async () => {
    const fetchFn = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    await expect(callModel(openai, req, deps(fetchFn))).rejects.toMatchObject({ kind: "retry" });
  });
});

describe("Anthropic", () => {
  it("sends messages with the system prompt and base64 images", async () => {
    const f = fake(200, { content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "No" }], stop_reason: "end_turn" });
    expect(await callModel(anthropic, { ...req, images: [{ type: "image/jpeg", data: "BBBB" }] }, deps(f.fetchFn))).toBe("No");
    expect(f.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-ant");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.system).toBe(req.system);
    expect(body.messages[0].content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }, { type: "text", text: req.prompt }]);
  });
  it("max_tokens without text is cut off", async () => {
    const f = fake(200, { content: [], stop_reason: "max_tokens" });
    await expect(callModel(anthropic, req, deps(f.fetchFn))).rejects.toMatchObject({ message: "The answer was cut off" });
  });
});

describe("Workers AI", () => {
  it("runs the binding and uses the image model with an image", async () => {
    const runs: [string, any][] = [];
    const ai = { run: async (m: string, input: unknown) => (runs.push([m, input]), { response: "Blue" }) };
    const s: ModelService = { id: "workers", kind: "workers", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" };
    expect(await callModel(s, req, { ai, allowPrivate: false, timeoutMs: 5000 })).toBe("Blue");
    expect(runs[0][0]).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    await callModel(s, { ...req, images: [{ type: "image/png", data: btoa("ab") }] }, { ai, allowPrivate: false, timeoutMs: 5000 });
    expect(runs[1][0]).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
    expect(runs[1][1].image).toEqual([97, 98]);
  });
  it("an empty answer says the model may have run out of tokens", async () => {
    const ai = { run: async () => ({ response: "" }) };
    await expect(callModel({ id: "workers", kind: "workers", model: "m" }, req, { ai, allowPrivate: false, timeoutMs: 1000 })).rejects.toMatchObject({ kind: "fail", message: "The answer was cut off or empty" });
  });
  it("without the binding fails", async () => {
    await expect(callModel({ id: "workers", kind: "workers", model: "m" }, req, { allowPrivate: false, timeoutMs: 1000 })).rejects.toBeInstanceOf(AiError);
  });
});
