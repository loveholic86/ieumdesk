import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { databaseConfig } from '../server/config.ts';

let client: pg.Client | undefined;
try {
  if (!process.argv.includes('--database=yeta_crm') || !process.argv.includes('--apply-auth=1')) throw new Error('EXPLICIT_AUTH_MIGRATION_REQUIRED');
  process.env.CRM_DATABASE = 'yeta_crm';
  client = new pg.Client(await databaseConfig());
  await client.connect();
  if ((await client.query('SELECT current_database() AS database')).rows[0]?.database !== 'yeta_crm') throw new Error('TARGET_DATABASE_MISMATCH');
  const state = (await client.query("SELECT to_regclass('yeta_crm.companies') IS NOT NULL AS crm_ready,to_regclass('yeta_crm.auth_users') IS NOT NULL AS users_present,to_regclass('yeta_crm.auth_sessions') IS NOT NULL AS sessions_present")).rows[0];
  if (!state.crm_ready) throw new Error('CRM_SCHEMA_REQUIRED');
  if (state.users_present || state.sessions_present) {
    console.log(JSON.stringify({ database: 'yeta_crm', status: 'EXISTING_AUTH_TABLES_STOPPED', changed: false, completePair: state.users_present && state.sessions_present }));
    process.exitCode = 2;
  } else {
    await client.query(await readFile(new URL('../db/002_auth.sql', import.meta.url), 'utf8'));
    console.log(JSON.stringify({ database: 'yeta_crm', status: 'AUTH_SCHEMA_CREATED', tablesCreated: 2, usersSeeded: 0, existingCrmDataChanged: false }));
  }
} catch (error) {
  const value = (error as { code?: string; message?: string }).code || (error as Error).message;
  console.error(JSON.stringify({ database: 'yeta_crm', status: 'FAILED', code: value && /^[A-Z0-9_]{2,60}$/.test(value) ? value : 'AUTH_MIGRATION_FAILED' }));
  process.exitCode = 1;
} finally { await client?.end(); }
