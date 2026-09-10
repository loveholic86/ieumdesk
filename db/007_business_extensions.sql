BEGIN;
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'WRONG_DATABASE'; END IF;
END $$;
-- Reversible schema additions; this file does not rewrite imported business rows.
ALTER TABLE yeta_crm.activities ADD COLUMN IF NOT EXISTS activity_date date;
ALTER TABLE yeta_crm.activities ADD COLUMN IF NOT EXISTS activity_date_edited boolean NOT NULL DEFAULT false;
ALTER TABLE yeta_crm.activities ADD COLUMN IF NOT EXISTS activity_type_edited boolean NOT NULL DEFAULT false;
ALTER TABLE yeta_crm.activities DROP CONSTRAINT IF EXISTS activities_type_check;
ALTER TABLE yeta_crm.activities ADD CONSTRAINT activities_type_check
  CHECK (type IN ('call','email','meeting','note','invoice','quotation','contract'));
-- Contact / sales extensions and quotation revisions use the existing records.data JSONB.
-- Rollback: first export new activity types and dates, then restore the old CHECK and drop activity_date.

COMMIT;
