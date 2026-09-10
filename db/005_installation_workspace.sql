-- Explicit target-only migration. Original archive rows and login data remain untouched.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'INSTALLATION_WORKSPACE_DATABASE_MISMATCH'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS yeta_crm_private;
REVOKE ALL ON SCHEMA yeta_crm_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS yeta_crm_private.installation_workspace (
  installation_id text PRIMARY KEY,
  revision integer NOT NULL CHECK(revision > 0),
  envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS yeta_crm_private.installation_workspace_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installation_ref_hash char(64) NOT NULL CHECK(installation_ref_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('row-create','row-update','row-delete')),
  revision integer NOT NULL CHECK(revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON yeta_crm_private.installation_workspace, yeta_crm_private.installation_workspace_audit FROM PUBLIC;
CREATE INDEX IF NOT EXISTS installation_workspace_audit_created_idx ON yeta_crm_private.installation_workspace_audit(created_at DESC);
COMMIT;
