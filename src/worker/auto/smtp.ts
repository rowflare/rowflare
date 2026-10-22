// A minimal SMTP client (RFC 5321) for automation emails: EHLO, STARTTLS, AUTH PLAIN or LOGIN, one message.
import { StepError } from "./types";

export interface SmtpReply {
  code: number;
  lines: string[];
}

/** A line connection: read() returns one complete reply, write() sends one line (CRLF is added). */
export interface SmtpConn {
  read(): Promise<SmtpReply>;
  write(line: string): Promise<void>;
  startTls(): Promise<SmtpConn>;
  close(): Promise<void>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string;
}

function b64(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function expectReply(c: SmtpConn, what: string, codes: number[]): Promise<SmtpReply> {
  const r = await c.read();
  if (!codes.includes(r.code)) throw new StepError(`SMTP ${what} failed: ${r.code} ${r.lines.join(" ")}`.slice(0, 300), r.code >= 400 && r.code < 500);
  return r;
}

/** Sends a command; errors name the command only, never its arguments (AUTH carries the password). */
async function command(c: SmtpConn, line: string, codes: number[], what = line.split(" ")[0]): Promise<SmtpReply> {
  await c.write(line);
  return expectReply(c, what, codes);
}

/** Sends one message; `data` is the whole MIME text. Returns the server's final reply. */
export async function smtpSend(open: (s: SmtpSettings) => Promise<SmtpConn>, s: SmtpSettings, password: string, envelope: { from: string; to: string[] }, data: string): Promise<string> {
  let c = await open(s);
  try {
    await expectReply(c, "greeting", [220]);
    let ehlo = await command(c, "EHLO rowflare", [250]);
    if (s.security === "starttls") {
      if (!ehlo.lines.some(l => /^STARTTLS\b/i.test(l))) throw new StepError("The SMTP server does not offer STARTTLS");
      await command(c, "STARTTLS", [220]);
      c = await c.startTls();
      ehlo = await command(c, "EHLO rowflare", [250]);
    }
    if (s.username) {
      const auth = ehlo.lines.find(l => /^AUTH\b/i.test(l)) ?? "";
      if (/\bPLAIN\b/i.test(auth)) await command(c, "AUTH PLAIN " + b64(`\0${s.username}\0${password}`), [235], "AUTH");
      else {
        await command(c, "AUTH LOGIN", [334], "AUTH");
        await command(c, b64(s.username), [334], "AUTH");
        await command(c, b64(password), [235], "AUTH");
      }
    }
    await command(c, `MAIL FROM:<${envelope.from}>`, [250], "MAIL FROM");
    for (const r of envelope.to) await command(c, `RCPT TO:<${r}>`, [250, 251], "RCPT TO");
    await command(c, "DATA", [354]);
    // Lines starting with a dot are doubled (RFC 5321 4.5.2); a lone dot ends the message.
    await c.write(data.split("\r\n").map(l => (l.startsWith(".") ? "." + l : l)).join("\r\n") + "\r\n.");
    const done = await expectReply(c, "DATA", [250]);
    await c.write("QUIT").catch(() => undefined);
    return done.lines.join(" ");
  } finally {
    await c.close().catch(() => undefined);
  }
}
