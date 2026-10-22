import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import { createNet } from "../../src/worker/auto/net";
import { NO_QUOTA } from "../../src/worker/auto/repo";
import { addViewer, HttpClient, ownerWithBase } from "./helpers";
import { fakeSmtp } from "../fakes/smtp";

const actor = { userId: "u1", name: "Tester" };

describe("automation network", () => {
  it("the real net refuses private addresses", async () => {
    const stub = env.BASE.get(env.BASE.idFromName("net-private"));
    await runInDurableObject(stub, async (i: BaseDO) => {
      i.store.init("net-private");
      const id = i.automations.apply(actor, { op: "create", name: "Inner", enabled: true, config: { trigger: { type: "webhook", token: "" }, steps: [{ id: "s1", type: "http", method: "GET", url: "http://192.168.1.10/admin", headers: [] }] } }, Date.now()).id!;
      const runId = i.automations.enqueue(i.automations.get(id), { type: "webhook", at: Date.now() }, [id], Date.now(), NO_QUOTA);
      expect(await i.engine.execute(runId)).toMatchObject({ status: "failed", error: "Requests to private network addresses are not allowed" });
    });
  });
});

describe("workspace mail settings", () => {
  it("owners save credentials; secrets are never returned", async () => {
    const x = await ownerWithBase("mail-owner");
    const url = `/api/workspaces/${x.wsId}/mail`;
    expect((await x.c.req("PUT", url, { provider: "resend", fromAddress: "bot@example.com" })).json.error).toBe("Enter the Resend API key");
    expect((await x.c.req("PUT", url, { provider: "resend", fromAddress: "bot@example.com", fromName: "Rowflare bot", secret: "re_test_secret_1234" })).status).toBe(200);
    const smtp = { provider: "smtp", fromAddress: "ops@example.com", settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }, secret: "hunter2-pass" };
    expect((await x.c.req("PUT", url, smtp)).status).toBe(200);
    const got = await x.c.req("GET", url);
    expect(got.json.secretKey).toBe(true);
    expect(got.json.system).toEqual({ available: false, from: null });
    expect(got.json.providers).toEqual([
      { provider: "resend", fromAddress: "bot@example.com", fromName: "Rowflare bot", settings: {}, last4: "1234", updatedAt: expect.any(Number) },
      { provider: "smtp", fromAddress: "ops@example.com", fromName: null, settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }, last4: "pass", updatedAt: expect.any(Number) },
    ]);
    expect(JSON.stringify(got.json)).not.toContain("hunter2");
    expect((await x.c.req("PUT", url, { provider: "resend", fromAddress: "team@example.com" })).status).toBe(200);
    expect((await x.c.req("GET", url)).json.providers[0]).toMatchObject({ fromAddress: "team@example.com", last4: "1234" });
    expect((await x.c.req("PUT", url, { provider: "smtp", remove: true })).status).toBe(200);
    expect((await x.c.req("GET", url)).json.providers).toHaveLength(1);
  });

  it("only owners can see or change mail settings", async () => {
    const x = await ownerWithBase("mail-roles");
    const viewer = new HttpClient(await addViewer(x.c, x.wsId, "mail-roles-v@example.com"));
    expect((await viewer.req("GET", `/api/workspaces/${x.wsId}/mail`)).status).toBe(403);
    expect((await viewer.req("PUT", `/api/workspaces/${x.wsId}/mail`, { provider: "resend", fromAddress: "a@b.co", secret: "x" })).status).toBe(403);
  });

  it("validates SMTP settings", async () => {
    const x = await ownerWithBase("mail-valid");
    const url = `/api/workspaces/${x.wsId}/mail`;
    const put = (patch: object) => x.c.req("PUT", url, { provider: "smtp", fromAddress: "ops@example.com", settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }, secret: "p", ...patch });
    expect((await put({ settings: { host: "smtp.example.com", port: 70000, security: "starttls" } })).json.error).toBe("Enter the SMTP port");
    expect((await put({ settings: { host: "smtp.example.com", port: 465, security: "ssl" } })).json.error).toBe("Choose TLS, STARTTLS or none");
    expect((await put({ fromAddress: "nope" })).json.error).toBe("Enter the address emails are sent from");
  });
});

describe("email from automations", () => {
  const mail = { to: ["a@x.co"], cc: [], subject: "Hi", body: "<b>x</b>", format: "html" as const };

  it("sends through Resend with the workspace's key", async () => {
    const x = await ownerWithBase("mail-resend");
    await x.c.req("PUT", `/api/workspaces/${x.wsId}/mail`, { provider: "resend", fromAddress: "bot@example.com", fromName: "Bot", secret: "re_live_9876" });
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response('{"id":"em_1"}'))) as unknown as typeof fetch;
    const net = createNet(env, async () => x.wsId, { fetchFn });
    expect(await net.email({ provider: "resend", ...mail }, 5000)).toEqual({ messageId: "em_1" });
    expect(seen[0].url).toBe("https://api.resend.com/emails");
    expect(new Headers(seen[0].init.headers).get("authorization")).toBe("Bearer re_live_9876");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ from: "Bot <bot@example.com>", to: ["a@x.co"], subject: "Hi", html: "<b>x</b>" });
    await expect(net.email({ provider: "smtp", ...mail }, 5000)).rejects.toThrow("Email sending is not set up for this workspace");
  });

  it("sends through SMTP with the saved settings", async () => {
    const x = await ownerWithBase("mail-smtp");
    await x.c.req("PUT", `/api/workspaces/${x.wsId}/mail`, { provider: "smtp", fromAddress: "ops@example.com", settings: { host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }, secret: "hunter2" });
    const f = fakeSmtp();
    const r = await createNet(env, async () => x.wsId, { openSmtp: f.open }).email({ provider: "smtp", ...mail, cc: ["c@x.co"] }, 5000);
    expect(r.messageId).toMatch(/^<.+@rowflare>$/);
    expect(f.opened).toEqual([{ host: "smtp.example.com", port: 587, security: "starttls", username: "ops" }]);
    expect(f.written).toContain("RCPT TO:<c@x.co>");
    expect(f.written).toContain("AUTH PLAIN " + btoa("\0ops\0hunter2"));
  });

  it("system email uses the binding, with a daily quota in cloud mode", async () => {
    const x = await ownerWithBase("mail-system");
    const sent: unknown[] = [];
    const EMAIL = { send: async (m: unknown) => (sent.push(m), { messageId: "cf_1" }) } as unknown as SendEmail;
    const cloud = createNet({ ...env, EMAIL, EMAIL_FROM: "noreply@rowflare.test", MODE: "cloud" }, async () => x.wsId);
    const sys = { provider: "system" as const, ...mail, format: "text" as const, body: "B" };
    expect(await cloud.email(sys, 5000)).toEqual({ messageId: "cf_1" });
    expect(sent[0]).toEqual({ from: "noreply@rowflare.test", to: ["a@x.co"], subject: "Hi", text: "B" });
    await env.DB.prepare("UPDATE mail_usage SET n = 100 WHERE workspace_id = ?").bind(x.wsId).run();
    await expect(cloud.email(sys, 5000)).rejects.toThrow("This workspace sent its 100 system emails for today");
    await expect(createNet(env, async () => x.wsId).email(sys, 5000)).rejects.toThrow("System email is not set up on this server");
  });
});
