import 'dotenv/config';
import pg, { type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { databaseConfig } from '../server/config.ts';
import { openLegacyVault, type LegacyVault } from '../server/legacy-vault.ts';
import {
  businessPrivateColumns,
  encryptBusinessRow,
  decryptBusinessRow,
  type BusinessTable,
} from '../server/business-encryption.ts';
import { encodeAuthIdentity, decodeAuthIdentity, type StoredAuthIdentity } from '../server/auth-identity.ts';
import { BackupService, PostgresBackupControl, safeBackupCode } from '../server/backup.ts';
import { PostgresBackupSnapshotProvider } from '../server/backup-snapshot.ts';
import { BackupFiles } from '../server/backup-files.ts';
import { canonical, installationFingerprints } from './materialize-installations.ts';

const targets = ['companies', 'activities', 'tasks', 'records', 'catalog', 'auth_users'] as const;
type Target = (typeof targets)[number];
type Row = Record<string, unknown> & { id: string };
type Client = Pick<PoolClient, 'query'>;
const failure = (code: string): never => {
  throw new Error(`STORAGE_ENCRYPTION_${code}`);
};
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const quote = (name: string) => {
  if (!/^[a-z_][a-z\d_]*$/.test(name)) failure('IDENTIFIER_INVALID');
  return `"${name}"`;
};
const relation = (name: string) => name.split('.').map(quote).join('.');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const encrypted = (table: Target, row: Row) =>
  row[table === 'auth_users' ? 'identity_cipher' : 'protected_data'] != null;
function plain(vault: LegacyVault, table: Target, row: Row): Row {
  if (!encrypted(table, row)) {
    const { protected_data: _business, identity_cipher: _identity, ...rest } = row;
    return rest as Row;
  }
  if (table === 'auth_users') {
    const { identity_cipher, ...rest } = row;
    return decodeAuthIdentity(vault, {
      ...rest,
      identityCipher: identity_cipher,
    } as unknown as StoredAuthIdentity) as Row;
  }
  return decryptBusinessRow(vault, table, row) as Row;
}
export function prepareEncryptedStorageRow(vault: LegacyVault, table: Target, source: Row) {
  const decoded = plain(vault, table, source);
  const result: Row =
    table === 'auth_users'
      ? (() => {
          const value = encodeAuthIdentity(vault, source.id, {
            email: String(decoded.email),
            name: String(decoded.name),
          });
          return { ...decoded, email: value.email, name: value.name, identity_cipher: value.identityCipher };
        })()
      : (encryptBusinessRow(vault, table, decoded) as Row);
  if (!same(decoded, plain(vault, table, result))) failure('ROUNDTRIP_FAILED');
  return { decoded, stored: result, alreadyEncrypted: encrypted(table, source) };
}
export function parseEncryptionArguments(args: string[]) {
  let apply = false,
    rehearse = false,
    fingerprint: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) failure('ARGUMENT_INVALID');
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--rehearse') rehearse = true;
    else if (arg === '--expected-fingerprint' && /^[a-f\d]{64}$/.test(args[index + 1] ?? ''))
      fingerprint = args[++index];
    else failure('ARGUMENT_INVALID');
  }
  if (apply && rehearse) failure('ARGUMENT_INVALID');
  if ((apply || rehearse) && !fingerprint) failure('EXPECTED_FINGERPRINT_REQUIRED');
  return { apply, rehearse, fingerprint };
}
async function inventory(client: Client) {
  const tables = (
    await client.query(`SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('yeta_crm','yeta_crm_private') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`)
  ).rows
    .map((row) => String(row.name))
    .filter(
      (name) => !['yeta_crm_private.backup_history', 'yeta_crm_private.backup_schedule'].includes(name),
    );
  if (
    targets.some((table) => !tables.includes(`yeta_crm.${table}`)) ||
    !tables.includes('yeta_crm.auth_sessions')
  )
    failure('SCHEMA_INCOMPLETE');
  const fingerprints = await installationFingerprints(client, tables);
  const schema = (
    await client.query(
      `SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
    WHERE table_schema='yeta_crm' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`,
      [targets],
    )
  ).rows;
  return { tables, fingerprints, fingerprint: hash({ fingerprints, schema }) };
}
async function rows(client: Client, table: Target) {
  // PostgreSQL serializes DATE directly as YYYY-MM-DD: never let pg convert it to a JS Date/UTC timestamp.
  const raw = (
    await client.query<{ raw: string }>(
      `SELECT to_jsonb(t)::text AS raw FROM yeta_crm.${quote(table)} t ORDER BY ${table === 'records' || table === 'catalog' ? 'kind,' : ''}id`,
    )
  ).rows;
  const parsed = raw.map((item) => JSON.parse(item.raw) as Row);
  // A JS number must not silently round a legacy JSON numeric value. Compare in PostgreSQL,
  // which still has the exact numeric lexeme, before encrypting or claiming preservation.
  const precise = await client.query(
    `SELECT NOT EXISTS (SELECT 1 FROM unnest($1::text[],$2::text[]) AS pair(original,parsed)
    WHERE original::jsonb IS DISTINCT FROM parsed::jsonb) AS exact`,
    [raw.map((item) => item.raw), parsed.map((item) => JSON.stringify(item))],
  );
  if (precise.rows[0]?.exact !== true) failure('NUMERIC_PRECISION_UNSUPPORTED');
  return parsed;
}
function placeholder(value: unknown): string {
  if (value === null) return 'NULL';
  if (Array.isArray(value)) return "'{}'::text[]";
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}
export async function finalizeEncryptedSchema(client: Client) {
  const envelopeCheck = (
    column: string,
  ) => `jsonb_typeof(${column})='object' AND ${column} ?& ARRAY['ciphertext','nonce','tag','keyId','sha256']
    AND ${column}-ARRAY['ciphertext','nonce','tag','keyId','sha256']='{}'::jsonb
    AND jsonb_typeof(${column}->'ciphertext')='string' AND jsonb_typeof(${column}->'nonce')='string'
    AND jsonb_typeof(${column}->'tag')='string' AND jsonb_typeof(${column}->'keyId')='string' AND jsonb_typeof(${column}->'sha256')='string'`;
  for (const table of targets) {
    const column = table === 'auth_users' ? 'identity_cipher' : 'protected_data';
    let guards = '';
    if (table === 'auth_users') guards = "AND email ~ '^lookup:[a-f0-9]{64}$' AND name='[보호됨]'";
    else if (table === 'records')
      guards = `AND jsonb_typeof(data)='object' AND data-'relatedCompanyIds'='{}'::jsonb AND (NOT data ? 'relatedCompanyIds' OR (jsonb_typeof(data->'relatedCompanyIds')='array' AND NOT jsonb_path_exists(data->'relatedCompanyIds', '$[*] ? (@.type() != "string")')))`;
    else if (table === 'catalog')
      guards =
        "AND ((kind='products' AND data='{}'::jsonb) OR (kind='codes' AND data ? 'lookup' AND jsonb_typeof(data->'lookup')='string' AND data-'lookup'='{}'::jsonb AND data->>'lookup' ~ '^[a-f0-9]{64}$'))";
    else
      guards = Object.entries(businessPrivateColumns[table])
        .map(([key, value]) => `AND ${quote(key)} IS NOT DISTINCT FROM ${placeholder(value)}`)
        .join(' ');
    await client.query(`ALTER TABLE yeta_crm.${quote(table)} ALTER COLUMN ${column} SET NOT NULL,
      DROP CONSTRAINT IF EXISTS ${quote(`${table}_encrypted_storage`)};
      ALTER TABLE yeta_crm.${quote(table)} ADD CONSTRAINT ${quote(`${table}_encrypted_storage`)} CHECK ((${envelopeCheck(column)} ${guards}) IS TRUE)`);
  }
  await client.query(`DROP INDEX IF EXISTS yeta_crm.catalog_code_unique;
    CREATE UNIQUE INDEX catalog_code_unique ON yeta_crm.catalog ((data->>'lookup')) WHERE kind='codes'`);
}
async function storeRow(client: Client, table: Target, row: Row) {
  const keys =
    table === 'auth_users'
      ? ['email', 'name', 'identity_cipher']
      : table === 'records' || table === 'catalog'
        ? ['data', 'protected_data']
        : [...Object.keys(businessPrivateColumns[table]), 'protected_data'];
  const parameters: unknown[] = keys.map((key) =>
    ['data', 'protected_data', 'identity_cipher'].includes(key) ? JSON.stringify(row[key]) : row[key],
  );
  parameters.push(row.id);
  const hasKind = table === 'records' || table === 'catalog';
  if (hasKind) parameters.push(row.kind);
  const updated = await client.query(
    `UPDATE yeta_crm.${quote(table)} SET ${keys.map((key, index) => `${quote(key)}=$${index + 1}${['data', 'protected_data', 'identity_cipher'].includes(key) ? '::jsonb' : ''}`).join(',')}
    WHERE id=$${keys.length + 1}${hasKind ? ` AND kind=$${keys.length + 2}` : ''} RETURNING id`,
    parameters,
  );
  if (updated.rowCount !== 1 || updated.rows[0]?.id !== row.id) failure('ROW_CHANGED');
}
export async function encryptStorage(options: ReturnType<typeof parseEncryptionArguments>) {
  const vault = await openLegacyVault({ createIfMissing: false });
  const mutating = options.apply || options.rehearse;
  const pool = new pg.Pool({
    ...(await databaseConfig(!mutating)),
    max: 1,
    application_name: 'ieumdesk_storage_encryption',
    options: `-c statement_timeout=120000 -c lock_timeout=5000${mutating ? '' : ' -c default_transaction_read_only=on'}`,
  });
  pool.on('error', () => {});
  const client = await pool.connect();
  let transaction = false;
  let committing = false;
  let releaseFiles: (() => Promise<void>) | undefined;
  let backup: Awaited<ReturnType<BackupService['create']>> | undefined;
  try {
    if ((await client.query('SELECT current_database() AS name')).rows[0]?.name !== 'yeta_crm')
      failure('WRONG_DATABASE');
    // Preliminary compare prevents a stale apply request from even creating a backup.
    const initial = await inventory(client);
    if (mutating && initial.fingerprint !== options.fingerprint) failure('PLAN_STALE');
    if (options.apply) {
      const service = new BackupService(new PostgresBackupSnapshotProvider(), new PostgresBackupControl());
      try {
        backup = await service.create('manual');
      } finally {
        await service.close();
      }
      if (!backup.verifiedAt) failure('BACKUP_NOT_VERIFIED');
    }
    if (mutating) releaseFiles = await new BackupFiles().lock();
    await client.query(
      mutating ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    transaction = true;
    if (mutating)
      await client.query(`LOCK TABLE ${initial.tables.map(relation).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const before = await inventory(client);
    if (mutating && before.fingerprint !== options.fingerprint) failure('PLAN_STALE');
    const originals = new Map<Target, Row[]>();
    const converted: { table: Target; rows: number; pending: number }[] = [];
    for (const table of targets) {
      const source = await rows(client, table);
      originals.set(
        table,
        source.map((row) => plain(vault, table, row)),
      );
      // Verify all existing encrypted rows and every prospective conversion before any SQL write.
      source.forEach((row) => prepareEncryptedStorageRow(vault, table, row));
      converted.push({
        table,
        rows: source.length,
        pending: source.filter((row) => !encrypted(table, row)).length,
      });
    }
    if (!mutating) {
      await client.query('ROLLBACK');
      transaction = false;
      return {
        status: 'plan',
        readOnly: true,
        fingerprint: before.fingerprint,
        tables: converted,
        pending: converted.reduce((n, item) => n + item.pending, 0),
        contentRoundTripVerified: true,
      };
    }
    await client.query(await readFile(new URL('../db/015_storage_encryption.sql', import.meta.url), 'utf8'));
    for (const table of targets) {
      for (const source of await rows(client, table)) {
        if (encrypted(table, source)) continue;
        const item = prepareEncryptedStorageRow(vault, table, source);
        await storeRow(client, table, item.stored);
      }
    }
    await finalizeEncryptedSchema(client);
    for (const table of targets) {
      const after = await rows(client, table);
      if (
        after.some((row) => !encrypted(table, row)) ||
        !same(
          originals.get(table),
          after.map((row) => plain(vault, table, row)),
        )
      )
        failure('PRESERVATION_FAILED');
    }
    const unaffected = before.tables.filter(
      (table) => !targets.some((target) => table === `yeta_crm.${target}`),
    );
    const afterOther = await installationFingerprints(client, unaffected);
    if (
      !same(
        before.fingerprints.filter((item) => unaffected.includes(item.table)),
        afterOther,
      )
    )
      failure('UNRELATED_DATA_CHANGED');
    if (options.rehearse) {
      await client.query('ROLLBACK');
      transaction = false;
      if ((await inventory(client)).fingerprint !== before.fingerprint) failure('REHEARSAL_ROLLBACK_FAILED');
      return {
        status: 'rehearsed',
        rolledBack: true,
        databaseUnchanged: true,
        tables: converted,
        contentRoundTripVerified: true,
        unrelatedTablesUnchanged: true,
        plaintextGuardsValidated: true,
      };
    }
    committing = true;
    await client.query('COMMIT');
    transaction = false;
    committing = false;
    return {
      status: 'committed',
      tables: converted,
      converted: converted.reduce((n, item) => n + item.pending, 0),
      backupId: backup!.id,
      backupVerified: true,
      contentRoundTripVerified: true,
      unrelatedTablesUnchanged: true,
      authenticationSessionsUnchanged: true,
      plaintextGuardsEnabled: true,
    };
  } catch (error) {
    if (committing) failure('COMMIT_RESULT_UNCERTAIN');
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
    await releaseFiles?.();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  encryptStorage(parseEncryptionArguments(process.argv.slice(2)))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      const code =
        error instanceof Error && /^STORAGE_ENCRYPTION_[A-Z_]+$/.test(error.message)
          ? error.message
          : safeBackupCode(error) === 'BACKUP_UNAVAILABLE'
            ? 'STORAGE_ENCRYPTION_FAILED'
            : safeBackupCode(error);
      console.error(JSON.stringify({ status: 'failed', code }));
      process.exitCode = 1;
    });
