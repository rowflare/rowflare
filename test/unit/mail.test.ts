import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../src/worker/secrets";
import { buildMime } from "../../src/worker/auto/mime";
import { smtpSend } from "../../src/worker/auto/smtp";
import { sendResend } from "../../src/worker/auto/mail";
import { fakeSmtp } from "../fakes/smtp";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("stored secrets", () => {
  it("round-trips, uses a fresh IV each time and needs the same key", async () => {
    const a = await encryptSecret("server-key", "re_123");
    const b = await encryptSecret("server-key", "re_123");
    expect(a).toMatch(/^v1:/);
    expect(a).not.toBe(b);
    expect(await decryptSecret("server-key", a)).toBe("re_123");
    await expect(decryptSecret("other-key", a)).rejects.toThrow();
  });
});

describe("MIME", () => {
  it("encodes non-ASCII headers, strips line breaks and base64-encodes the body", () => {
    const m = buildMime({ from: "ops@example.com", fromName: "Ops Team", to: ["a@x.co", "b@x.co"], cc: ["c@x.co"], subject: "Bericht über\r\nBcc: evil@x.co", body: "Hallo Welt", format: "html", messageId: "<1@rowflare>", date: new Date(Date.UTC(2026, 9, 13, 9, 30)) });
    const [head, body] = m.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      'From: "Ops Team" <ops@example.com>',
      "To: a@x.co, b@x.co",
      "Cc: c@x.co",
      `Subject: =?UTF-8?B?${b64("Bericht über Bcc: evil@x.co")}?=`,
      "Date: Tue, 13 Oct 2026 09:30:00 +0000",
      "Message-ID: <1@rowflare>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString()).toBe("Hallo Welt");
  });
});

describe("SMTP", () => {
  const settings = { host: "smtp.test", port: 587, security: "starttls" as const, username: "ops" };

  it("upgrades with STARTTLS, authenticates and sends one message", async () => {
    const f = fakeSmtp();
    const reply = await smtpSend(f.open, settings, "hunter2", { from: "ops@example.com", to: ["a@x.co", "b@x.co"] }, "Subject: hi\r\n\r\n.hidden line");
    expect(f.opened).toEqual([settings]);
    expect(f.written).toEqual(["EHLO rowflare", "STARTTLS", "<tls>", "EHLO rowflare", "AUTH PLAIN " + b64("\0ops\0hunter2"), "MAIL FROM:<ops@example.com>", "RCPT TO:<a@x.co>", "RCPT TO:<b@x.co>", "DATA", "Subject: hi\r\n\r\n..hidden line\r\n.", "QUIT"]);
    expect(reply).toBe("2.0.0 queued as 42");
  });

  it("falls back to AUTH LOGIN", async () => {
    const f = fakeSmtp({ ehlo: ["AUTH LOGIN"] });
    await smtpSend(f.open, { ...settings, security: "none" }, "hunter2", { from: "ops@example.com", to: ["a@x.co"] }, "x");
    expect(f.written.slice(0, 4)).toEqual(["EHLO rowflare", "AUTH LOGIN", b64("ops"), b64("hunter2")]);
  });

  it("fails without STARTTLS when it is required", async () => {
    await expect(smtpSend(fakeSmtp({ ehlo: ["AUTH PLAIN"] }).open, settings, "p", { from: "ops@example.com", to: ["a@x.co"] }, "x")).rejects.toThrow("The SMTP server does not offer STARTTLS");
  });

  it("treats 5xx replies as final and 4xx replies as retryable", async () => {
    const send = (code: number) => smtpSend(fakeSmtp({ reject: { command: "RCPT TO", reply: { code, lines: ["mailbox busy"] } } }).open, settings, "p", { from: "ops@example.com", to: ["a@x.co"] }, "x");
    await expect(send(550)).rejects.toMatchObject({ message: "SMTP RCPT TO failed: 550 mailbox busy", retry: false });
    await expect(send(451)).rejects.toMatchObject({ retry: true });
  });
});

describe("Resend", () => {
  it("posts the message and reads the id; 4xx is final, 5xx retryable", async () => {
    let seen: RequestInit | undefined;
    const ok = (async (_: string, init: RequestInit) => ((seen = init), new Response('{"id":"em_1"}'))) as unknown as typeof fetch;
    expect(await sendResend("re_k", "bot@example.com", "Bot", { to: ["a@x.co"], cc: ["b@x.co"], subject: "S", body: "T", format: "text" }, ok)).toEqual({ messageId: "em_1" });
    expect(new Headers(seen!.headers).get("authorization")).toBe("Bearer re_k");
    expect(JSON.parse(String(seen!.body))).toEqual({ from: "Bot <bot@example.com>", to: ["a@x.co"], cc: ["b@x.co"], subject: "S", text: "T" });
    const status = (n: number) => (async () => new Response("bad", { status: n })) as unknown as typeof fetch;
    await expect(sendResend("re_k", "bot@example.com", null, { to: ["a@x.co"], cc: [], subject: "S", body: "T", format: "text" }, status(422))).rejects.toMatchObject({ message: "Resend answered 422: bad", retry: false });
    await expect(sendResend("re_k", "bot@example.com", null, { to: ["a@x.co"], cc: [], subject: "S", body: "T", format: "text" }, status(503))).rejects.toMatchObject({ retry: true });
  });
});
