-- Preparation only. scripts/encrypt-storage.ts executes this inside its locked transaction,
-- encrypts existing values, verifies the round trip, and installs NOT NULL / no-plaintext guards.
-- Running this file alone does not complete the migration.
DO $$ BEGIN
  IF current_database() <> 'yeta_crm' THEN RAISE EXCEPTION 'STORAGE_ENCRYPTION_WRONG_DATABASE'; END IF;
END $$;
ALTER TABLE yeta_crm.companies ADD COLUMN IF NOT EXISTS protected_data jsonb;
ALTER TABLE yeta_crm.activities ADD COLUMN IF NOT EXISTS protected_data jsonb;
ALTER TABLE yeta_crm.tasks ADD COLUMN IF NOT EXISTS protected_data jsonb;
ALTER TABLE yeta_crm.records ADD COLUMN IF NOT EXISTS protected_data jsonb;
ALTER TABLE yeta_crm.catalog ADD COLUMN IF NOT EXISTS protected_data jsonb;
ALTER TABLE yeta_crm.auth_users ADD COLUMN IF NOT EXISTS identity_cipher jsonb;
