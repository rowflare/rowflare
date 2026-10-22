-- Sign-in codes for instances that use email and a code instead of passwords (AUTH_EMAIL=code). Keyed by email because the account may not exist yet.
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT,
  code_hash TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_codes_email ON email_codes (email, created_at);
CREATE INDEX IF NOT EXISTS email_codes_ip ON email_codes (ip, created_at);
CREATE INDEX IF NOT EXISTS email_codes_created ON email_codes (created_at);
