-- Executed inside migrate-legacy.ts's single target transaction.
CREATE SCHEMA IF NOT EXISTS yeta_crm_private;
REVOKE ALL ON SCHEMA yeta_crm_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS yeta_crm_private.legacy_runs (
  id uuid PRIMARY KEY, source text NOT NULL UNIQUE, fingerprint text NOT NULL,
  key_id text NOT NULL, report jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS yeta_crm_private.legacy_archive (
  batch_id uuid NOT NULL REFERENCES yeta_crm_private.legacy_runs(id),
  source_table text NOT NULL, source_key text NOT NULL, envelope jsonb NOT NULL,
  PRIMARY KEY(batch_id,source_table,source_key)
);
CREATE TABLE IF NOT EXISTS yeta_crm_private.legacy_items (
  batch_id uuid NOT NULL REFERENCES yeta_crm_private.legacy_runs(id),
  source_table text NOT NULL, source_key text NOT NULL,
  target_table text NOT NULL, target_kind text NOT NULL DEFAULT '', target_id text NOT NULL,
  target_digest text NOT NULL,
  PRIMARY KEY(batch_id,target_table,target_kind,target_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA yeta_crm_private FROM PUBLIC;
ALTER TABLE yeta_crm.companies DROP CONSTRAINT IF EXISTS companies_status_check;
ALTER TABLE yeta_crm.companies ADD CONSTRAINT companies_status_check CHECK(status IN ('active','prospect','paused','unclassified'));
ALTER TABLE yeta_crm.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE yeta_crm.tasks ADD CONSTRAINT tasks_status_check CHECK(status IN ('received','in_progress','done','unclassified'));
ALTER TABLE yeta_crm.tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
ALTER TABLE yeta_crm.tasks ADD CONSTRAINT tasks_type_check CHECK(type IN ('개발요청','채권관리','영업관리','미분류'));
ALTER TABLE yeta_crm.activities ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE yeta_crm.records ALTER COLUMN company_id DROP NOT NULL;
