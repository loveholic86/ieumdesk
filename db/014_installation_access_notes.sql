-- Expand non-secret change metadata only. Existing encrypted documents are not rewritten.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'INSTALLATION_ACCESS_NOTES_DATABASE_MISMATCH'; END IF;
END $$;
ALTER TABLE yeta_crm_private.installation_workspace_audit
  DROP CONSTRAINT IF EXISTS installation_workspace_audit_action_check;
ALTER TABLE yeta_crm_private.installation_workspace_audit
  ADD CONSTRAINT installation_workspace_audit_action_check
  CHECK (action IN ('row-create','row-update','row-delete','materialize','note-create','note-update','note-delete'));
COMMIT;
