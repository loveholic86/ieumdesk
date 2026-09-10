import pg from 'pg';
import { databaseConfig } from './config.ts';
import { ApiError } from './errors.ts';
import { parseInstallationArchive } from './installation-details.ts';
import { openLegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';

export type LegacyArchiveItem = { table: string; key: string; data: Record<string, unknown> };
const permitted = new Set([
  'code_tb',
  'quotation_item_tb',
  'company_tb',
  'cs_qna_tb',
  'cs_answer_tb',
  'cs_reply_tb',
  'cs_notice_tb',
  'cs_addfile_tb',
  'cs_mng_comp',
  'cs_webhook_tb',
]);
type CipherRow = {
  batch_id: string;
  source: string;
  key_id: string;
  source_table: string;
  source_key: string;
  envelope: LegacyVaultEnvelope;
};
export class LegacyReader {
  private pool?: Promise<pg.Pool>;
  private cache = new Map<string, { until: number; rows: Promise<CipherRow[]> }>();
  constructor(private mode: 'demo' | 'postgres') {}
  private async connection() {
    return (this.pool ??= (async () => {
      const pool = new pg.Pool({ ...(await databaseConfig(true)), max: 2, allowExitOnIdle: true });
      pool.on('error', () => {});
      try {
        if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== 'yeta_crm')
          throw new Error();
        return pool;
      } catch {
        await pool.end();
        throw new ApiError(503, 'LEGACY_READ_UNAVAILABLE', '보관 자료를 확인하지 못했습니다.');
      }
    })().catch((error) => {
      this.pool = undefined;
      throw error;
    }));
  }
  async read(tables: string[]): Promise<LegacyArchiveItem[]> {
    if (tables.some((table) => !permitted.has(table))) throw new Error('LEGACY_TABLE_NOT_ALLOWED');
    if (this.mode === 'demo') return [];
    const key = [...new Set(tables)].sort().join(',');
    let entry = this.cache.get(key);
    if (!entry || entry.until < Date.now()) {
      const rows = (async () =>
        (
          await (
            await this.connection()
          ).query<CipherRow>(
            `SELECT a.batch_id,r.source,r.key_id,a.source_table,a.source_key,a.envelope FROM yeta_crm_private.legacy_archive a JOIN yeta_crm_private.legacy_runs r ON r.id=a.batch_id WHERE r.source='CRM_OLD_DB:public:v1' AND r.report->>'status'='committed' AND a.source_table=ANY($1::text[]) ORDER BY a.source_table,a.source_key`,
            [tables],
          )
        ).rows)();
      entry = { until: Date.now() + 300000, rows };
      this.cache.set(key, entry);
      rows.catch(() => this.cache.delete(key));
    }
    const cipher = await entry.rows;
    if (!cipher.length) return [];
    const vault = await openLegacyVault({ createIfMissing: false });
    return cipher.map((row) => {
      if (row.key_id !== vault.keyId)
        throw new ApiError(503, 'LEGACY_READ_UNAVAILABLE', '보관 자료를 확인하지 못했습니다.');
      return {
        table: row.source_table,
        key: row.source_key,
        data: parseInstallationArchive(
          vault.decrypt(row.envelope, {
            source: row.source,
            table: row.source_table,
            primaryKey: row.source_key,
            batchId: row.batch_id,
          }),
        ),
      };
    });
  }
  async companyIds(): Promise<Map<string, string>> {
    if (this.mode === 'demo') return new Map();
    const rows = (
      await (
        await this.connection()
      ).query(
        `SELECT i.source_key,i.target_id FROM yeta_crm_private.legacy_items i JOIN yeta_crm_private.legacy_runs r ON r.id=i.batch_id WHERE r.source='CRM_OLD_DB:public:v1' AND r.report->>'status'='committed' AND i.source_table='company_tb' AND i.target_table='companies'`,
      )
    ).rows;
    // Unlike encrypted archive hashes, ledger source keys retain the original ct_cd.
    return new Map(rows.map((row) => [row.source_key, row.target_id]));
  }
  async close() {
    if (this.pool) await (await this.pool).end();
  }
}
export const legacySensitive = (value: string) =>
  /(?:password|passwd|비밀번호|비번|패스워드|접속정보|(?:pwd|pw|암호)\s*[:=]|아이디\s*[:=]|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i.test(
    value,
  );
