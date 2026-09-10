import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { databaseConfig, configForDatabase } from '../server/config.ts';

// Deliberately manual: never imported by server startup or npm test.
const targetDatabase = 'yeta_crm';
let source: pg.Client | undefined;
let target: pg.Client | undefined;
let databaseCreated = false;
let schemaApplied = false;
try {
  if (!process.argv.includes('--create-new-database=yeta_crm'))
    throw new Error('EXPLICIT_CREATE_FLAG_REQUIRED');
  const configuration = await databaseConfig();
  source = new pg.Client(configuration);
  await source.connect();
  const exists = await source.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
    [targetDatabase],
  );
  if (exists.rows[0]?.exists) {
    console.log(
      JSON.stringify({
        database: targetDatabase,
        status: 'ALREADY_EXISTS_STOPPED',
        databaseCreated: false,
        schemaApplied: false,
        changesMade: false,
      }),
    );
    process.exitCode = 2;
  } else {
    await source.query("SET statement_timeout = '30s'");
    // A fixed identifier prevents this manual tool from creating arbitrary databases.
    await source.query("CREATE DATABASE yeta_crm WITH ENCODING 'UTF8' TEMPLATE template0");
    databaseCreated = true;
    target = new pg.Client(configForDatabase(configuration, targetDatabase));
    await target.connect();
    const identity = await target.query<{ database: string }>('SELECT current_database() AS database');
    if (identity.rows[0]?.database !== targetDatabase) throw new Error('TARGET_DATABASE_MISMATCH');
    const tablesBefore = await target.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'",
    );
    if (tablesBefore.rows[0]?.count !== 0) throw new Error('NEW_DATABASE_NOT_EMPTY');
    await target.query(await readFile(new URL('../db/001_initial.sql', import.meta.url), 'utf8'));
    schemaApplied = true;
    const tableCount = await target.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM information_schema.tables WHERE table_schema = 'yeta_crm' AND table_type = 'BASE TABLE'",
    );
    const encoding = await target.query<{ encoding: string }>(
      'SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()',
    );
    console.log(
      JSON.stringify({
        database: targetDatabase,
        status: 'CREATED',
        databaseCreated,
        schemaApplied,
        encoding: encoding.rows[0].encoding,
        schema: 'yeta_crm',
        tableCount: tableCount.rows[0].count,
        seedInserted: false,
        originalDatabaseTablesChanged: false,
      }),
    );
  }
} catch (error) {
  const candidate = (error as { code?: string; message?: string }).code || (error as Error).message;
  const code = candidate && /^[A-Z0-9_]{2,60}$/.test(candidate) ? candidate : 'PROVISION_FAILED';
  console.error(
    JSON.stringify({ database: targetDatabase, status: 'FAILED', code, databaseCreated, schemaApplied }),
  );
  process.exitCode = 1;
} finally {
  await target?.end();
  await source?.end();
}
