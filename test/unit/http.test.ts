import { describe, expect, it } from "vitest";
import { checkUrl, httpRequest, isPrivateHost } from "../../src/worker/auto/http";
import { StepError } from "../../src/worker/auto/types";

const fake = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;

describe("private addresses", () => {
  it("knows private, loopback and link-local hosts", () => {
    for (const h of ["localhost", "api.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "fd00::1", "fe80::1", "[::ffff:7f00:1]"]) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "[2606:4700::1111]"]) expect(isPrivateHost(h), h).toBe(false);
  });

  it("checks URLs", () => {
    expect(() => checkUrl("ftp://example.com", false)).toThrow("Only http and https URLs are allowed");
    expect(() => checkUrl("http://2130706433/", false)).toThrow("Requests to private network addresses are not allowed");
    expect(() => checkUrl("not a url", false)).toThrow("Invalid URL not a url");
    expect(checkUrl("http://127.0.0.1:8787/x", true).host).toBe("127.0.0.1:8787");
  });
});

describe("HTTP requests", () => {
  it("sends the method, headers and body, and does not follow redirects", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = fake(async (url, init) => ((seen = { url, init }), new Response('{"a":1}', { status: 201, headers: { "x-id": "7" } })));
    const r = await httpRequest({ method: "POST", url: "https://example.com/h", headers: [["X-Kind", "a"]], body: '{"n":1}' }, { timeoutMs: 1000, allowPrivate: false, fetchFn });
    expect(r).toEqual({ status: 201, headers: expect.objectContaining({ "x-id": "7" }), body: '{"a":1}' });
    expect(seen!.url).toBe("https://example.com/h");
    expect(seen!.init.redirect).toBe("manual");
    const h = new Headers(seen!.init.headers);
    expect([h.get("x-kind"), h.get("content-type"), h.get("user-agent")]).toEqual(["a", "application/json", "Rowflare-Automations/1.0"]);
    expect(seen!.init.body).toBe('{"n":1}');
  });

  it("times out with a retryable error", async () => {
    const fetchFn = fake((_, init) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    const e = await httpRequest({ method: "GET", url: "https://example.com", headers: [] }, { timeoutMs: 20, allowPrivate: false, fetchFn }).catch(x => x);
    expect(e).toBeInstanceOf(StepError);
    expect(e).toMatchObject({ message: "The server did not answer in time", retry: true });
  });

  it("reports connection errors as retryable", async () => {
    const fetchFn = fake(async () => {
      throw new TypeError("connect ECONNREFUSED");
    });
    await expect(httpRequest({ method: "GET", url: "https://example.com", headers: [] }, { timeoutMs: 1000, allowPrivate: false, fetchFn })).rejects.toMatchObject({ message: "Could not connect: connect ECONNREFUSED", retry: true });
  });

  it("reads at most 1 MB of the answer", async () => {
    const fetchFn = fake(async () => new Response("x".repeat(1024 * 1024 + 10)));
    const r = await httpRequest({ method: "GET", url: "https://example.com", headers: [] }, { timeoutMs: 1000, allowPrivate: false, fetchFn });
    expect(r.body.length).toBe(1024 * 1024);
  });

  it("reports a request the server refused for a private address", async () => {
    const fetchFn = fake(async () => new Response("Requests to private network addresses are not allowed", { status: 403, headers: { "x-rowflare-blocked": "private" } }));
    await expect(httpRequest({ method: "GET", url: "http://127.0.0.1.nip.io/", headers: [] }, { timeoutMs: 1000, allowPrivate: false, fetchFn })).rejects.toMatchObject({ message: "Requests to private network addresses are not allowed", retry: false });
  });

  it("rejects invalid header names without retrying", async () => {
    await expect(httpRequest({ method: "GET", url: "https://example.com", headers: [["Bad Header", "x"]] }, { timeoutMs: 1000, allowPrivate: false, fetchFn: fake(async () => new Response("")) })).rejects.toMatchObject({ message: "Invalid header Bad Header", retry: false });
  });
});
