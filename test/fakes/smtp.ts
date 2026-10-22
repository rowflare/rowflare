// A scripted SMTP server for tests: answers each command and records what the client wrote.
import type { SmtpConn, SmtpReply, SmtpSettings } from "../../src/worker/auto/smtp";

export function fakeSmtp(opts: { ehlo?: string[]; reject?: { command: string; reply: SmtpReply } } = {}) {
  const written: string[] = [];
  const opened: SmtpSettings[] = [];
  const pending: SmtpReply[] = [{ code: 220, lines: ["smtp.test ready"] }];
  let login = 0;
  const conn: SmtpConn = {
    async read() {
      const r = pending.shift();
      if (!r) throw new Error("nothing to read");
      return r;
    },
    async write(line) {
      written.push(line);
      if (login === 1) return void ((login = 2), pending.push({ code: 334, lines: ["UGFzc3dvcmQ6"] }));
      if (login === 2) return void ((login = 0), pending.push({ code: 235, lines: ["ok"] }));
      if (line.endsWith("\r\n.")) return void pending.push({ code: 250, lines: ["2.0.0 queued as 42"] });
      const cmd = line.startsWith("MAIL FROM") ? "MAIL FROM" : line.startsWith("RCPT TO") ? "RCPT TO" : line.split(" ")[0].toUpperCase();
      if (opts.reject?.command === cmd) return void pending.push(opts.reject.reply);
      if (cmd === "EHLO") pending.push({ code: 250, lines: ["smtp.test", ...(opts.ehlo ?? ["STARTTLS", "AUTH PLAIN LOGIN"])] });
      else if (cmd === "STARTTLS") pending.push({ code: 220, lines: ["go ahead"] });
      else if (cmd === "AUTH" && line.startsWith("AUTH PLAIN")) pending.push({ code: 235, lines: ["ok"] });
      else if (cmd === "AUTH") {
        login = 1;
        pending.push({ code: 334, lines: ["VXNlcm5hbWU6"] });
      } else if (cmd === "DATA") pending.push({ code: 354, lines: ["end with ."] });
      else if (cmd === "QUIT") pending.push({ code: 221, lines: ["bye"] });
      else pending.push({ code: 250, lines: ["ok"] });
    },
    async startTls() {
      written.push("<tls>");
      return conn;
    },
    async close() {},
  };
  return { open: async (s: SmtpSettings) => (opened.push(s), conn), written, opened };
}
