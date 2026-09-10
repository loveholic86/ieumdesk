BEGIN;
DO $$ BEGIN IF current_database()<>'yeta_crm' THEN RAISE EXCEPTION 'SUPPORT_DATABASE_MISMATCH'; END IF; END $$;
CREATE TABLE IF NOT EXISTS yeta_crm_private.support_items (
  id text PRIMARY KEY,kind varchar(20) NOT NULL CHECK(kind IN ('tickets','notices')),
  revision integer NOT NULL CHECK(revision>0),envelope jsonb NOT NULL,
  company_id text REFERENCES yeta_crm.companies(id),archived_at timestamptz,
  updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS active_company_link ON yeta_crm_private.support_items;
CREATE TRIGGER active_company_link BEFORE INSERT OR UPDATE ON yeta_crm_private.support_items FOR EACH ROW EXECUTE FUNCTION yeta_crm.require_active_company();
REVOKE ALL ON yeta_crm_private.support_items FROM PUBLIC;
COMMIT;
