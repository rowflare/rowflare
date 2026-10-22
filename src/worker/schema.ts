// Applies the D1 schema at runtime so a one-click deploy (which only runs `wrangler deploy`) works
// without a separate migration step. Statements are idempotent; applied versions are recorded.
import type { Env } from "./env";
import m0001 from "../../migrations/0001_init.sql";
import m0002 from "../../migrations/0002_mail.sql";
import m0003 from "../../migrations/0003_ai.sql";
import m0004 from "../../migrations/0004_hosting.sql";
import m0005 from "../../migrations/0005_email_codes.sql";
import m0006 from "../../migrations/0006_no_guests.sql";

const MIGRATIONS: [number, string][] = [[1, m0001], [2, m0002], [3, m0003], [4, m0004], [5, m0005], [6, m0006]];

let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) ready = apply(env).catch(e => {
    ready = null;
    throw e;
  });
  return ready;
}

async function apply(env: Env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS _rowflare_schema (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)").run();
  const row = await env.DB.prepare("SELECT max(version) v FROM _rowflare_schema").first<{ v: number | null }>();
  const current = row?.v ?? 0;
  for (const [version, sql] of MIGRATIONS) {
    if (version <= current) continue;
    const statements = sql
      .split(/;\s*(?:\n|$)/)
      .map(s => s.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    try {
      await env.DB.batch([...statements.map(s => env.DB.prepare(s)), env.DB.prepare("INSERT OR IGNORE INTO _rowflare_schema (version, applied_at) VALUES (?, ?)").bind(version, Date.now())]);
    } catch (e) {
      // ALTER TABLE has no IF EXISTS: a database migrated another way (wrangler d1 migrations) already has the change.
      for (const st of statements) {
        try {
          await env.DB.prepare(st).run();
        } catch (err) {
          if (!/no such column|duplicate column/i.test(String(err))) throw e;
        }
      }
      await env.DB.prepare("INSERT OR IGNORE INTO _rowflare_schema (version, applied_at) VALUES (?, ?)").bind(version, Date.now()).run();
    }
  }
}
