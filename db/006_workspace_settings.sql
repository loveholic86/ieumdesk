-- Explicit additive migration. Existing CRM rows and protected archives stay intact.
BEGIN;
DO $$ BEGIN IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'WORKSPACE_DATABASE_MISMATCH'; END IF; END $$;
CREATE TABLE IF NOT EXISTS yeta_crm.workspace_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
);
INSERT INTO yeta_crm.workspace_settings(singleton,data) VALUES(true,
 '{"brandName":"ieumdesk","workspaceName":"Workspace","protectionEnabled":true,"menus":{"overview":true,"companies":true,"contacts":true,"activities":true,"tasks":true,"sales":true,"quotations":true,"installations":true,"support":true,"users":true}}'::jsonb)
ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS yeta_crm.workspace_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL, action varchar(80) NOT NULL, area varchar(40) NOT NULL,
  result varchar(30) NOT NULL, fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(jsonb_typeof(fields)='array')
);
CREATE INDEX IF NOT EXISTS workspace_audit_created_idx ON yeta_crm.workspace_audit(created_at DESC);
REVOKE ALL ON yeta_crm.workspace_settings,yeta_crm.workspace_audit FROM PUBLIC;
COMMIT;
