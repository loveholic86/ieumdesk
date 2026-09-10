BEGIN;
DO $$ BEGIN IF current_database()<>'yeta_crm' THEN RAISE EXCEPTION 'BACKUP_DATABASE_MISMATCH'; END IF; END $$;
CREATE TABLE IF NOT EXISTS yeta_crm_private.backup_schedule (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  enabled boolean NOT NULL DEFAULT false,
  interval_hours integer NOT NULL DEFAULT 24 CHECK(interval_hours BETWEEN 1 AND 168),
  next_run_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO yeta_crm_private.backup_schedule(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS yeta_crm_private.backup_history (
  id text PRIMARY KEY, action varchar(30) NOT NULL,
  outcome varchar(10) NOT NULL CHECK(outcome IN ('success','failed')),
  backup_id text, actor_id text, code varchar(100), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_history_created_idx ON yeta_crm_private.backup_history(created_at DESC);
REVOKE ALL ON yeta_crm_private.backup_schedule,yeta_crm_private.backup_history FROM PUBLIC;
COMMIT;
