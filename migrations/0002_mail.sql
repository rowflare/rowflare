-- Mail credentials per workspace for automation email steps; secrets are encrypted with SECRET_KEY.
CREATE TABLE IF NOT EXISTS workspace_mail (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  settings TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  last4 TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);

-- System emails sent per workspace per day, for the cloud quota.
CREATE TABLE IF NOT EXISTS mail_usage (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, day)
);
