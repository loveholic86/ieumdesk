BEGIN;
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'WRONG_DATABASE'; END IF;
END $$;
-- NULL distinguishes untouched imported fields from an explicit empty edit.
ALTER TABLE yeta_crm.companies ADD COLUMN IF NOT EXISTS zipcode text;
ALTER TABLE yeta_crm.tasks ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE yeta_crm.tasks ADD COLUMN IF NOT EXISTS start_date_edited boolean NOT NULL DEFAULT false;
ALTER TABLE yeta_crm.tasks ADD COLUMN IF NOT EXISTS contact_id text;
ALTER TABLE yeta_crm.tasks ADD COLUMN IF NOT EXISTS contact_name text;
COMMIT;
-- Rollback after exporting new values: drop these five additive columns.
