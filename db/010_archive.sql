BEGIN;
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'WRONG_DATABASE'; END IF;
END $$;
ALTER TABLE yeta_crm.companies ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE yeta_crm.companies ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE yeta_crm.activities ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE yeta_crm.activities ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE yeta_crm.tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE yeta_crm.tasks ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE yeta_crm.records ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE yeta_crm.records ADD COLUMN IF NOT EXISTS archived_by text;
-- Serialize new active links with customer archival. No existing rows are rewritten.
CREATE OR REPLACE FUNCTION yeta_crm.require_active_company() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked text; links text[];
BEGIN
  IF NEW.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  links := ARRAY[NEW.company_id];
  IF TG_TABLE_NAME='records' THEN
    SELECT links || COALESCE(array_agg(value),'{}'::text[]) INTO links
    FROM jsonb_array_elements_text(COALESCE(NEW.data->'relatedCompanyIds','[]'::jsonb));
  END IF;
  FOR linked IN SELECT DISTINCT value FROM unnest(links) value WHERE value IS NOT NULL AND value<>'' ORDER BY value LOOP
    PERFORM id FROM yeta_crm.companies WHERE id=linked AND archived_at IS NULL FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ARCHIVED_COMPANY_REFERENCE' USING ERRCODE='23503'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS active_company_link ON yeta_crm.activities;
CREATE TRIGGER active_company_link BEFORE INSERT OR UPDATE ON yeta_crm.activities FOR EACH ROW EXECUTE FUNCTION yeta_crm.require_active_company();
DROP TRIGGER IF EXISTS active_company_link ON yeta_crm.tasks;
CREATE TRIGGER active_company_link BEFORE INSERT OR UPDATE ON yeta_crm.tasks FOR EACH ROW EXECUTE FUNCTION yeta_crm.require_active_company();
DROP TRIGGER IF EXISTS active_company_link ON yeta_crm.records;
CREATE TRIGGER active_company_link BEFORE INSERT OR UPDATE ON yeta_crm.records FOR EACH ROW EXECUTE FUNCTION yeta_crm.require_active_company();
COMMIT;
-- Rollback: drop active_company_link triggers and require_active_company(), restore archived rows,
-- then drop the eight columns. Take a backup of tombstone metadata before rollback.
