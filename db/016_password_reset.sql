-- Additive migration. Existing accounts, passwords and sessions are preserved.
BEGIN;
CREATE TABLE IF NOT EXISTS yeta_crm.auth_password_reset_requests (
  user_id text PRIMARY KEY REFERENCES yeta_crm.auth_users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS yeta_crm.auth_password_resets (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL UNIQUE REFERENCES yeta_crm.auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
COMMIT;
