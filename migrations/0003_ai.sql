-- Model services per workspace for AI fields and AI automation steps; keys are encrypted with SECRET_KEY.
CREATE TABLE IF NOT EXISTS workspace_ai (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT,
  model TEXT NOT NULL,
  secret_enc TEXT,
  last4 TEXT,
  key_rejected_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_ai_ws ON workspace_ai (workspace_id);

-- Model calls per workspace, service and month.
CREATE TABLE IF NOT EXISTS ai_usage (
  workspace_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  month TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, service_id, month)
);
