// SMTP over Cloudflare TCP sockets (also available in workerd, so the Docker image can send mail).
import { connect } from "cloudflare:sockets";
import type { SmtpConn, SmtpSettings } from "./smtp";
import { StepError } from "./types";

function wrap(socket: Socket): SmtpConn {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const line = async (): Promise<string> => {
    for (;;) {
      const i = buf.indexOf("\r\n");
      if (i >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        return l;
      }
      const { done, value } = await reader.read();
      if (done) throw new StepError("The SMTP server closed the connection", true);
      buf += dec.decode(value, { stream: true });
    }
  };
  return {
    async read() {
      const lines: string[] = [];
      for (;;) {
        const l = await line();
        lines.push(l.slice(4));
        if (l[3] !== "-") return { code: Number(l.slice(0, 3)), lines };
      }
    },
    async write(l) {
      await writer.write(enc.encode(l + "\r\n"));
    },
    async startTls() {
      reader.releaseLock();
      writer.releaseLock();
      return wrap(socket.startTls());
    },
    async close() {
      await socket.close();
    },
  };
}

export async function openSmtp(s: SmtpSettings): Promise<SmtpConn> {
  try {
    const socket = connect({ hostname: s.host, port: s.port }, { secureTransport: s.security === "tls" ? "on" : s.security === "starttls" ? "starttls" : "off", allowHalfOpen: false });
    await socket.opened;
    return wrap(socket);
  } catch (e) {
    throw new StepError(`Could not connect to ${s.host}:${s.port}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
