import pg from 'pg';
import { databaseConfig } from '../server/config.ts';

let client: pg.Client | undefined;
try {
  client = new pg.Client(await databaseConfig(true));
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const tables = await client.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'
     ORDER BY table_schema, table_name`,
  );
  const relevant = tables.rows.filter((row) =>
    /crm|compan(?:y|ies)|customer|contact|activit(?:y|ies)|task|record/i.test(row.table_name),
  );
  const columns = await client.query(
    `SELECT table_schema, table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_name = ANY($1::text[])
     ORDER BY table_schema, table_name, ordinal_position`,
    [relevant.map((row) => row.table_name)],
  );
  await client.query('ROLLBACK');
  console.log(
    JSON.stringify(
      {
        connected: true,
        readOnly: true,
        inspectedAt: new Date().toISOString(),
        tableCount: tables.rowCount,
        candidateTables: relevant,
        columns: columns.rows,
        applicationSchemaPresent: tables.rows.some((row) => row.table_schema === 'yeta_crm'),
        boundary: 'Metadata only. No customer rows read, no schema or data changed.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  const rawCode = (error as { code?: string }).code;
  const safeCode = rawCode && /^[A-Z0-9_]{2,40}$/.test(rawCode) ? rawCode : 'DATABASE_INSPECTION_FAILED';
  console.error(
    JSON.stringify({
      connected: false,
      code: safeCode,
      message: '데이터베이스 메타데이터 확인에 실패했습니다. 접속 설정과 네트워크를 확인해 주세요.',
    }),
  );
  process.exitCode = 1;
} finally {
  await client?.end();
}
