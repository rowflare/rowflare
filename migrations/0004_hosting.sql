-- Billing moved out of the open-source app; plans and limits come from the hosting extension.
-- The workspaces columns trial_ends_at, stripe_customer_id, stripe_subscription_id and subscription_status are no longer
-- used. They stay for this release so the previous version keeps working during a rollout or a rollback; a later
-- migration drops them.

-- Attachment bytes per workspace for plan limits: uploads add to it, an hourly recount sets it from the files still in cells.
CREATE TABLE IF NOT EXISTS workspace_storage (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_since INTEGER NOT NULL DEFAULT 0,
  counted_at INTEGER
);

-- Monthly counters per workspace for plan limits (automation runs when the plan counts them per workspace); base objects add to them in batches.
CREATE TABLE IF NOT EXISTS workspace_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  month TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, kind, month)
);

-- Email verification and password reset. Accounts from before this migration count as verified.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
UPDATE users SET email_verified_at = created_at WHERE is_guest = 0;
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens (user_id, created_at);
