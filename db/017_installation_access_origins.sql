-- Grouping sidecar for newly saved access rows. Existing rows stay NULL (no group).
-- No backfill and no rewrite of encrypted documents or archive tables.
-- Apply only after an approved deploy with a backup. This file does not run itself.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'INSTALLATION_ACCESS_ORIGINS_DATABASE_MISMATCH'; END IF;
END $$;
ALTER TABLE yeta_crm_private.installation_workspace
  ADD COLUMN IF NOT EXISTS access_origins jsonb;
ALTER TABLE yeta_crm_private.installation_workspace
  DROP CONSTRAINT IF EXISTS installation_workspace_access_origins_object;
ALTER TABLE yeta_crm_private.installation_workspace
  ADD CONSTRAINT installation_workspace_access_origins_object
  CHECK (access_origins IS NULL OR jsonb_typeof(access_origins) = 'object');
COMMIT;
