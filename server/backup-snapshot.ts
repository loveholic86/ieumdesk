import pg, { type PoolClient, type Pool } from 'pg';
import { databaseConfig } from './config.ts';
import {
  BackupFiles,
  BACKUP_MAX_BYTES,
  backupFailure,
  sha256,
  validateBackupFiles,
  type BackupFile,
} from './backup-files.ts';
import type { BackupCounts } from '../src/backup-types.ts';

export const BACKUP_EXCLUDED_TABLES = ['yeta_crm_private.backup_schedule', 'yeta_crm_private.backup_history'];
interface Column {
  name: string;
  type: string;
  identity: string;
  generated: string;
  nullable: boolean;
  default: string | null;
}
export interface BackupTable {
  schema: string;
  name: string;
  columns: Column[];
  constraints: { name: string; definition: string; parent: string | null; kind: string }[];
  indexes: string[];
  triggers: string[];
  rows: string[];
}
interface BackupSequence {
  schema: string;
  name: string;
  definition: string;
  next: string;
}
export interface BackupSnapshot {
  version: 1;
  database: 'yeta_crm';
  tables: BackupTable[];
  sequences: BackupSequence[];
  functions: string[];
  files: BackupFile[];
  externalReferences: boolean;
}
export interface BackupSnapshotProvider {
  capture(): Promise<BackupSnapshot>;
  restore(
    snapshot: BackupSnapshot,
    expectedFingerprint: string,
    beforeWrite: (current: BackupSnapshot) => Promise<void>,
  ): Promise<{ revokedSessions: number }>;
  close(): Promise<void>;
}
const identifier = (name: string) => {
  if (!/^[a-z_][a-z\d_]*$/.test(name)) throw backupFailure('BACKUP_SCHEMA_UNSUPPORTED');
  return `"${name}"`;
};
const relation = (table: { schema: string; name: string }) =>
  `${identifier(table.schema)}.${identifier(table.name)}`;
const key = (table: { schema: string; name: string }) => `${table.schema}.${table.name}`;
export const snapshotCounts = (snapshot: BackupSnapshot): BackupCounts => ({
  tables: snapshot.tables.length,
  rows: snapshot.tables.reduce((total, table) => total + table.rows.length, 0),
  files: snapshot.files.length,
  fileBytes: snapshot.files.reduce((total, file) => total + Buffer.byteLength(file.base64, 'base64'), 0),
});
export const schemaFingerprint = (snapshot: BackupSnapshot) =>
  sha256(
    JSON.stringify({
      tables: snapshot.tables.map(({ rows: _rows, ...definition }) => definition),
      sequences: snapshot.sequences.map(({ next: _next, ...definition }) => definition),
      functions: snapshot.functions,
      externalReferences: snapshot.externalReferences,
    }),
  );
export const snapshotFingerprint = (snapshot: BackupSnapshot) => sha256(JSON.stringify(snapshot));
export function insertionOrder(snapshot: BackupSnapshot): BackupTable[] {
  const pending = new Map(snapshot.tables.map((table) => [key(table), table]));
  const ordered: BackupTable[] = [];
  while (pending.size) {
    const ready = [...pending].find(([name, table]) =>
      table.constraints.every(
        (c) => c.kind !== 'f' || !c.parent || (c.parent !== name && !pending.has(c.parent)),
      ),
    );
    if (!ready) throw backupFailure('BACKUP_FOREIGN_KEY_CYCLE');
    ordered.push(ready[1]);
    pending.delete(ready[0]);
  }
  return ordered;
}
export function validateSnapshot(snapshot: BackupSnapshot) {
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    snapshot.database !== 'yeta_crm' ||
    !Array.isArray(snapshot.tables) ||
    snapshot.tables.length < 1 ||
    snapshot.tables.length > 1000 ||
    !Array.isArray(snapshot.sequences) ||
    !Array.isArray(snapshot.functions) ||
    typeof snapshot.externalReferences !== 'boolean'
  )
    throw backupFailure('BACKUP_PAYLOAD_INVALID');
  const tables = new Set<string>();
  for (const table of snapshot.tables) {
    if (
      !['yeta_crm', 'yeta_crm_private'].includes(table.schema) ||
      BACKUP_EXCLUDED_TABLES.includes(key(table)) ||
      tables.has(key(table)) ||
      !Array.isArray(table.rows) ||
      !Array.isArray(table.columns) ||
      !Array.isArray(table.constraints) ||
      !Array.isArray(table.indexes) ||
      !Array.isArray(table.triggers)
    )
      throw backupFailure('BACKUP_PAYLOAD_INVALID');
    relation(table);
    tables.add(key(table));
    for (const column of table.columns) identifier(column.name);
    for (const row of table.rows) {
      if (typeof row !== 'string') throw backupFailure('BACKUP_PAYLOAD_INVALID');
      const parsed: unknown = JSON.parse(row);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw backupFailure('BACKUP_PAYLOAD_INVALID');
    }
  }
  for (const sequence of snapshot.sequences) {
    relation(sequence);
    if (
      !['yeta_crm', 'yeta_crm_private'].includes(sequence.schema) ||
      !/^-?\d+$/.test(sequence.next) ||
      typeof sequence.definition !== 'string'
    )
      throw backupFailure('BACKUP_PAYLOAD_INVALID');
  }
  validateBackupFiles(snapshot.files);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > BACKUP_MAX_BYTES) throw backupFailure('BACKUP_TOO_LARGE');
}
export function restoreBlockers(snapshot: BackupSnapshot, current: BackupSnapshot): string[] {
  const codes: string[] = [];
  if (schemaFingerprint(snapshot) !== schemaFingerprint(current)) codes.push('BACKUP_SCHEMA_MISMATCH');
  if (snapshot.externalReferences || current.externalReferences) codes.push('BACKUP_EXTERNAL_REFERENCES');
  try {
    insertionOrder(snapshot);
  } catch {
    codes.push('BACKUP_FOREIGN_KEY_CYCLE');
  }
  return codes;
}
async function identity(client: PoolClient) {
  if ((await client.query('SELECT current_database() AS database')).rows[0]?.database !== 'yeta_crm')
    throw backupFailure('BACKUP_DATABASE_MISMATCH');
}
async function captureDatabase(client: PoolClient, files: BackupFiles): Promise<BackupSnapshot> {
  await identity(client);
  await client.query(
    "SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle TO 'ISO, YMD'; SET LOCAL IntervalStyle TO 'postgres'; SET LOCAL extra_float_digits TO 3",
  );
  const tableNames = (
    await client.query<{ schema: string; name: string; kind: string; secured: boolean }>(
      `SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,(c.relrowsecurity OR c.relforcerowsecurity) AS secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('yeta_crm','yeta_crm_private') AND c.relkind IN ('r','p','f','m') ORDER BY n.nspname,c.relname`,
    )
  ).rows.filter((table) => !BACKUP_EXCLUDED_TABLES.includes(key(table)));
  if (tableNames.some((table) => table.kind !== 'r' || table.secured))
    throw backupFailure('BACKUP_SCHEMA_UNSUPPORTED');
  const tables: BackupTable[] = [];
  let bytes = 0;
  for (const table of tableNames) {
    const name = key(table);
    const columns = (
      await client.query<Column>(
        `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attidentity AS identity,a.attgenerated AS generated,NOT a.attnotnull AS nullable,pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [name],
      )
    ).rows;
    const constraints = (
      await client.query<BackupTable['constraints'][number]>(
        `SELECT c.conname AS name,pg_get_constraintdef(c.oid,true) AS definition,CASE WHEN c.contype='f' THEN pn.nspname||'.'||pc.relname END AS parent,c.contype AS kind FROM pg_constraint c LEFT JOIN pg_class pc ON pc.oid=c.confrelid LEFT JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE c.conrelid=$1::regclass ORDER BY c.conname`,
        [name],
      )
    ).rows;
    const indexes = (
      await client.query<{ definition: string }>(
        'SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid=$1::regclass ORDER BY indexrelid::regclass::text',
        [name],
      )
    ).rows.map((row) => row.definition);
    const triggers = (
      await client.query<{ definition: string }>(
        'SELECT pg_get_triggerdef(oid,true) AS definition FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname',
        [name],
      )
    ).rows.map((row) => row.definition);
    const estimated = Number(
      (
        await client.query<{ bytes: string }>(
          `SELECT COALESCE(sum(octet_length(row_to_json(t)::text)),0)::text AS bytes FROM ${relation(table)} t`,
        )
      ).rows[0].bytes,
    );
    if (!Number.isSafeInteger(estimated) || bytes + estimated > BACKUP_MAX_BYTES)
      throw backupFailure('BACKUP_TOO_LARGE');
    const rows = (
      await client.query<{ raw: string }>(
        `SELECT row_to_json(t)::text AS raw FROM ${relation(table)} t ORDER BY row_to_json(t)::text COLLATE "C"`,
      )
    ).rows.map((row) => row.raw);
    bytes += rows.reduce((total, row) => total + Buffer.byteLength(row), 0);
    if (bytes > BACKUP_MAX_BYTES) throw backupFailure('BACKUP_TOO_LARGE');
    tables.push({ schema: table.schema, name: table.name, columns, constraints, indexes, triggers, rows });
  }
  const sequences: BackupSequence[] = [];
  const definitions = (
    await client.query<{
      schema: string;
      name: string;
      definition: string;
      increment: string;
      min: string;
      max: string;
      cycle: boolean;
    }>(
      `SELECT n.nspname AS schema,c.relname AS name,concat_ws('|',format_type(s.seqtypid,NULL),s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle) AS definition,s.seqincrement::text AS increment,s.seqmin::text AS min,s.seqmax::text AS max,s.seqcycle AS cycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('yeta_crm','yeta_crm_private') ORDER BY n.nspname,c.relname`,
    )
  ).rows;
  for (const sequence of definitions) {
    const state = (
      await client.query<{ last_value: string; is_called: boolean }>(
        `SELECT last_value::text,is_called FROM ${relation(sequence)}`,
      )
    ).rows[0];
    let next = BigInt(state.last_value) + (state.is_called ? BigInt(sequence.increment) : 0n);
    if (next < BigInt(sequence.min) || next > BigInt(sequence.max)) {
      if (!sequence.cycle) throw backupFailure('BACKUP_SEQUENCE_EXHAUSTED');
      next = BigInt(sequence.increment) > 0n ? BigInt(sequence.min) : BigInt(sequence.max);
    }
    sequences.push({
      schema: sequence.schema,
      name: sequence.name,
      definition: sequence.definition,
      next: next.toString(),
    });
  }
  const functions = (
    await client.query<{ definition: string }>(
      `SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('yeta_crm','yeta_crm_private') AND p.prokind IN ('f','p') ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`,
    )
  ).rows.map((row) => row.definition);
  const externalReferences = (
    await client.query<{ found: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace WHERE c.contype='f' AND ((cn.nspname IN ('yeta_crm','yeta_crm_private'))<>(pn.nspname IN ('yeta_crm','yeta_crm_private')))) AS found`,
    )
  ).rows[0].found;
  const snapshot: BackupSnapshot = {
    version: 1,
    database: 'yeta_crm',
    tables,
    sequences,
    functions,
    files: await files.capture(),
    externalReferences,
  };
  validateSnapshot(snapshot);
  return snapshot;
}

export class PostgresBackupSnapshotProvider implements BackupSnapshotProvider {
  private pool?: Pool;
  constructor(
    private files = new BackupFiles(),
    private connect?: () => Promise<PoolClient>,
  ) {}
  private async connection() {
    if (this.connect) return this.connect();
    this.pool ??= new pg.Pool({
      ...(await databaseConfig(false)),
      max: 1,
      allowExitOnIdle: true,
      application_name: 'ieumdesk_backup',
      options: '-c statement_timeout=120000 -c lock_timeout=5000',
    });
    return this.pool.connect();
  }
  async capture() {
    const release = await this.files.lock();
    let client: PoolClient | undefined;
    try {
      client = await this.connection();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = await captureDatabase(client, this.files);
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client?.release();
      await release();
    }
  }
  async restore(
    snapshot: BackupSnapshot,
    expectedFingerprint: string,
    beforeWrite: (current: BackupSnapshot) => Promise<void>,
  ) {
    validateSnapshot(snapshot);
    const release = await this.files.lock();
    let client: PoolClient | undefined,
      staged: Awaited<ReturnType<BackupFiles['stage']>> | undefined,
      committed = false,
      commitStarted = false,
      uncertain = false;
    try {
      client = await this.connection();
      await identity(client);
      // Stop the API, schedulers and other database clients before applying a restore.
      if (
        Number(
          (
            await client.query(
              "SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
            )
          ).rows[0].count,
        )
      )
        throw backupFailure('BACKUP_SERVER_MUST_STOP');
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('yeta-crm-backup-restore-v1',0))");
      const names = (
        await client.query<{ schema: string; name: string }>(
          `SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('yeta_crm','yeta_crm_private') AND c.relkind='r' ORDER BY n.nspname,c.relname`,
        )
      ).rows;
      await client.query(`LOCK TABLE ${names.map(relation).join(',')} IN ACCESS EXCLUSIVE MODE`);
      const current = await captureDatabase(client, this.files),
        blockers = restoreBlockers(snapshot, current);
      if (blockers.length) throw backupFailure(blockers[0]);
      if (snapshotFingerprint(current) !== expectedFingerprint)
        throw backupFailure('BACKUP_CURRENT_STATE_CHANGED');
      await beforeWrite(current); // Durable encrypted preimage precedes staging, DELETE and sequence changes.
      staged = await this.files.stage(snapshot.files);
      if (
        Number(
          (
            await client.query(
              "SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
            )
          ).rows[0].count,
        )
      )
        throw backupFailure('BACKUP_SERVER_MUST_STOP');
      const ordered = insertionOrder(snapshot);
      for (const table of [...ordered].reverse()) await client.query(`DELETE FROM ${relation(table)}`);
      for (const table of ordered) {
        const columns = table.columns
          .filter((column) => !column.generated)
          .map((column) => identifier(column.name));
        for (let offset = 0; offset < table.rows.length; offset += 200) {
          await client.query(
            `INSERT INTO ${relation(table)} (${columns.join(',')}) OVERRIDING SYSTEM VALUE SELECT ${columns.join(',')} FROM json_populate_recordset(NULL::${relation(table)},$1::json)`,
            [`[${table.rows.slice(offset, offset + 200).join(',')}]`],
          );
        }
      }
      for (const sequence of snapshot.sequences)
        await client.query(`ALTER SEQUENCE ${relation(sequence)} RESTART WITH ${sequence.next}`);
      await staged.publish();
      const restored = await captureDatabase(client, this.files);
      if (snapshotFingerprint(restored) !== snapshotFingerprint(snapshot))
        throw backupFailure('BACKUP_RESTORE_VERIFICATION_FAILED');
      const revoked = snapshot.tables.some((table) => key(table) === 'yeta_crm.auth_sessions')
        ? ((await client.query('DELETE FROM yeta_crm.auth_sessions')).rowCount ?? 0)
        : 0;
      commitStarted = true;
      try {
        await client.query('COMMIT');
        committed = true;
      } catch {
        uncertain = true;
        throw backupFailure('BACKUP_COMMIT_UNCERTAIN');
      }
      try {
        await staged.committed();
      } catch {
        throw backupFailure('BACKUP_RESTORE_COMMITTED_CLEANUP_FAILED');
      }
      return { revokedSessions: revoked };
    } catch (error) {
      if (!committed && !commitStarted) {
        await client?.query('ROLLBACK').catch(() => {});
        await staged?.rollback();
      }
      throw error;
    } finally {
      client?.release(uncertain);
      if (!uncertain) await release();
    }
  }
  async close() {
    await this.pool?.end();
    this.pool = undefined;
  }
}
