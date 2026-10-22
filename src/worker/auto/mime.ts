// A single-part MIME message (UTF-8, base64 body) for SMTP.
export interface MimeMessage {
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  format: "text" | "html";
  messageId: string;
  date: Date;
}

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

export function b64utf8(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Header text; non-ASCII becomes an RFC 2047 encoded word, and line breaks cannot add headers. */
function headerText(s: string): string {
  const t = oneLine(s);
  return ascii(t) ? t : `=?UTF-8?B?${b64utf8(t)}?=`;
}

function mailbox(email: string, name?: string): string {
  if (!name) return email;
  const n = oneLine(name);
  return ascii(n) ? `"${n.replace(/["\\]/g, "\\$&")}" <${email}>` : `${headerText(n)} <${email}>`;
}

export function buildMime(m: MimeMessage): string {
  const lines = [
    `From: ${mailbox(m.from, m.fromName)}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${headerText(m.subject)}`,
    `Date: ${m.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${m.messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: text/${m.format === "html" ? "html" : "plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    ...(b64utf8(m.body).match(/.{1,76}/g) ?? [""]),
  ];
  return lines.join("\r\n");
}
