-- Explicit authentication migration for the dedicated CRM database only.
-- Existing CRM rows are not modified; no accounts or credentials are seeded.
BEGIN;
CREATE TABLE yeta_crm.auth_users (
  id text PRIMARY KEY,
  email varchar(254) NOT NULL UNIQUE CHECK (email = lower(trim(email))),
  name varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
  password_hash text NOT NULL,
  role varchar(16) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE yeta_crm.auth_sessions (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES yeta_crm.auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON yeta_crm.auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON yeta_crm.auth_sessions(expires_at);
COMMIT;
