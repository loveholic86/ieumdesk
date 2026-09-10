-- Add the operational-data transition audit action. No business or archive rows are rewritten.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'INSTALLATION_MANAGED_DATABASE_MISMATCH'; END IF;
END $$;
ALTER TABLE yeta_crm_private.installation_workspace_audit
  DROP CONSTRAINT IF EXISTS installation_workspace_audit_action_check;
ALTER TABLE yeta_crm_private.installation_workspace_audit
  ADD CONSTRAINT installation_workspace_audit_action_check
  CHECK (action IN ('row-create','row-update','row-delete','materialize'));
COMMIT;
