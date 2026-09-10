-- Apply explicitly to the target yeta_crm database. No legacy source writes.
-- Store access decisions only: never passwords, sessions, connection values, or response bodies.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN
    RAISE EXCEPTION 'INSTALLATION_AUDIT_DATABASE_MISMATCH';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS yeta_crm_private;
REVOKE ALL ON SCHEMA yeta_crm_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS yeta_crm_private.installation_secret_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  installation_ref_hash char(64) NOT NULL CHECK (installation_ref_hash ~ '^[a-f0-9]{64}$'),
  outcome varchar(10) NOT NULL CHECK (outcome IN ('allowed','denied','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON yeta_crm_private.installation_secret_audit FROM PUBLIC;
CREATE INDEX IF NOT EXISTS installation_secret_audit_created_idx
  ON yeta_crm_private.installation_secret_audit (created_at DESC);
COMMIT;
