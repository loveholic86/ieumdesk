import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { databaseConfig } from '../server/config.ts';

const apply = process.argv.slice(2).join(' ') === '--apply';
const client = new Client(await databaseConfig(!apply));
try {
  if (process.argv.length > 2 && !apply) throw new Error('INVALID_ARGUMENTS');
  await client.connect();
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  if (database !== 'yeta_crm') throw new Error('INSTALLATION_AUDIT_DATABASE_MISMATCH');
  const counts = async () =>
    (
      await client.query(`SELECT
    (SELECT count(*)::int FROM yeta_crm.companies) AS companies,
    (SELECT count(*)::int FROM yeta_crm.activities) AS activities,
    (SELECT count(*)::int FROM yeta_crm.tasks) AS tasks,
    (SELECT count(*)::int FROM yeta_crm.records) AS records,
    (SELECT count(*)::int FROM yeta_crm.auth_users) AS users,
    (SELECT count(*)::int FROM yeta_crm.auth_sessions) AS sessions,
    (SELECT count(*)::int FROM yeta_crm_private.legacy_archive) AS archives`)
    ).rows[0];
  const before = await counts();
  if (apply) await client.query(await readFile('db/004_installation_audit.sql', 'utf8'));
  const ready = Boolean(
    (
      await client.query(
        "SELECT to_regclass('yeta_crm_private.installation_secret_audit') IS NOT NULL AS ready",
      )
    ).rows[0].ready,
  );
  console.log(
    JSON.stringify({
      mode: apply ? 'applied' : 'read-only',
      auditReady: ready,
      before,
      after: await counts(),
    }),
  );
} catch {
  console.error('INSTALLATION_AUDIT_MIGRATION_FAILED');
  process.exitCode = 1;
} finally {
  await client.end();
}
