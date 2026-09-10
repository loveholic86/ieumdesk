BEGIN;
DO $$ BEGIN IF current_database()<>'yeta_crm' THEN RAISE EXCEPTION 'CATALOG_DATABASE_MISMATCH'; END IF; END $$;
CREATE TABLE IF NOT EXISTS yeta_crm.catalog (
  kind varchar(20) NOT NULL CHECK(kind IN ('products','codes')),id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0),data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_code_unique ON yeta_crm.catalog ((data->>'group'),(data->>'code')) WHERE kind='codes';
REVOKE ALL ON yeta_crm.catalog FROM PUBLIC;
COMMIT;
