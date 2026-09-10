import type pg from 'pg';
import { createHash } from 'node:crypto';
import type {
  Activity,
  CRMRecord,
  ContactComment,
  ContactRecord,
  SaleRecord,
  Company,
  Task,
} from '../src/types.ts';
import { ApiError } from './errors.ts';
import { parseInstallationArchive } from './installation-details.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';

type Archived = {
  batch_id: string;
  source: string;
  key_id: string;
  source_table: string;
  source_key: string;
  envelope: LegacyVaultEnvelope;
};
type Ledger = {
  batch_id: string;
  source_table: string;
  source_key: string;
  target_table: string;
  target_kind: string;
  target_id: string;
};
type ArchiveSnapshot = { archives: Archived[]; items: Ledger[] };
type Row = Record<string, unknown>;
const scalar = (value: unknown) => (value == null ? '' : String(value));
const source = 'CRM_OLD_DB:public:v1';
const businessTargets: Record<string, [string, string]> = {
  company_tb: ['companies', ''],
  manager_tb: ['records', 'contacts'],
  act_tb: ['activities', ''],
  sales_tb: ['records', 'sales'],
  task_tb: ['tasks', ''],
};
const ledgerIdentity = (batchId: string, table: string, key: string) => JSON.stringify([batchId, table, key]);
function sourceBusinessKey(table: string, row: Row): string | undefined {
  const key = (name: string) => scalar(row[name]).trim();
  if (table === 'manager_tb')
    return key('ct_cd') && key('mng_cd') ? `${key('ct_cd')}-${key('mng_cd')}` : undefined;
  const field: Record<string, string> = {
    company_tb: 'ct_cd',
    act_tb: 'act_id',
    sales_tb: 'sales_id',
    task_tb: 'task_id',
  };
  return field[table] ? key(field[table]) || undefined : undefined;
}
// Same credential-marker boundary as the original migration's public text projection.
const sensitiveText =
  /(?:password|passwd|비밀번호|비번|패스워드|접속정보|(?:pwd|pw|암호)\s*[:=]|아이디\s*[:=]|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i;
const legacyRedaction = '[접속정보가 포함될 수 있는 원문은 보안 보관함에 보존됨]';
const legacyPublicText = (value: string) =>
  sensitiveText.test(value.trim()) ? legacyRedaction : value.trim().slice(0, 10000);
const publicText = (value: string, protectionEnabled: boolean) =>
  protectionEnabled && sensitiveText.test(value) ? '보호됨' : value;
const unavailable = () =>
  new ApiError(
    503,
    'BUSINESS_ARCHIVE_UNAVAILABLE',
    '이관된 업무 상세 자료를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  );
const date = (value: unknown) => {
  const text = scalar(value)
    .replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
    .slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) &&
    new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text
    ? text
    : '';
};
/** Only fills absent extension fields. An explicit empty edit always wins over the archive. */
export function mergeLegacyBusiness<T extends CRMRecord | Activity | Company | Task>(
  record: T,
  sourceRow: Row,
  comments: Row[] = [],
  codes = new Map<string, string>(),
  protectionEnabled = true,
): T {
  const defaults: Row = {};
  if ('businessNumber' in record) {
    defaults.zipcode = publicText(scalar(sourceRow.zipcode), protectionEnabled);
  } else if ('dueDate' in record) {
    defaults.startDate = date(sourceRow.st_dt);
    defaults.contactId = scalar(sourceRow._linkedContactId);
    defaults.contactName = publicText(scalar(sourceRow.mng_nm), protectionEnabled);
  } else if ('department' in record) {
    defaults.fax = scalar(sourceRow.fax);
    defaults.workplace = scalar(sourceRow.address);
    defaults.zipcode = scalar(sourceRow.zipcode);
    defaults.commentHistory = comments
      .filter(
        (row) =>
          scalar(row.ct_cd) === scalar(sourceRow.ct_cd) && scalar(row.mng_cd) === scalar(sourceRow.mng_cd),
      )
      .map((row): ContactComment => ({
        id: `legacy-comment-${createHash('sha256').update(scalar(row.comment_id)).digest('hex').slice(0, 24)}`,
        body: scalar(row.contents),
        createdAt: date(row.cr_dt),
        author: '기존 CRM',
      }));
  } else if ('stage' in record) {
    defaults.failedReason = record.stage === '실패' ? scalar(sourceRow.sales_conts) : '';
    defaults.retryProbability =
      codes.get(`reopen_rate\0${scalar(sourceRow.reopen_rate)}`) ?? scalar(sourceRow.reopen_rate);
  } else if ('createdAt' in record) {
    defaults.activityDate = date(sourceRow.act_dt);
    // The migration kept unrecognized types in body. Override only its untouched note fallback.
    const legacyType = codes.get(`act_type\0${scalar(sourceRow.act_type)}`) ?? scalar(sourceRow.act_type);
    const mapped = (
      { 세금계산서: 'invoice', 견적서: 'quotation', 계약서: 'contract' } as Record<string, Activity['type']>
    )[legacyType];
    if (record.type === 'note' && mapped && !(record as unknown as Row)._activityTypeEdited)
      defaults._mappedActivityType = mapped;
  }
  const result = { ...defaults, ...record } as T;
  const restoreText = (key: string, original: string, limit: number, redactionSource = original) => {
    const current = result as unknown as Row;
    // Match the original migration projection exactly; explicit edits and clears win.
    if (sensitiveText.test(redactionSource.trim()) && current[key] === legacyRedaction.slice(0, limit))
      current[key] = protectionEnabled ? '보호됨' : original.trim().slice(0, limit);
  };
  if ('businessNumber' in record) {
    for (const [key, sourceKey, limit] of [
      ['name', 'ct_nm', 150],
      ['businessNumber', 'com_reg_num', 30],
      ['ceo', 'ct_rep', 150],
      ['address', 'com_addr', 500],
      ['corporationNumber', 'corp_reg_num', 50],
    ] as const)
      restoreText(key, scalar(sourceRow[sourceKey]), limit);
    restoreText('industry', codes.get(`com_cls\0${scalar(sourceRow.com_cls)}`) || '', 150);
    // Company.note was migration guidance, not a projection of any source note.
  } else if ('dueDate' in record) {
    restoreText('body', scalar(sourceRow.contents), 10000);
    restoreText(
      'title',
      scalar(sourceRow.contents)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' '),
      170,
      scalar(sourceRow.contents),
    );
    restoreText('owner', scalar(sourceRow.task_user_nm || sourceRow.task_user_id), 150);
  } else if ('department' in record) {
    for (const [key, sourceKey, limit] of [
      ['name', 'mng_nm', 150],
      ['department', 'mng_dept', 150],
      ['role', 'mng_grd', 150],
      ['phone', 'tel1', 40],
      ['mobile', 'tel2', 40],
      ['email', 'email', 254],
    ] as const)
      restoreText(key, scalar(sourceRow[sourceKey]), limit);
  } else if ('stage' in record) {
    restoreText('note', scalar(sourceRow.sales_conts), 10000);
    restoreText('owner', scalar(sourceRow.cr_user_id), 150);
  } else if ('createdAt' in record) {
    restoreText('title', scalar(sourceRow.title), 200);
    restoreText('author', scalar(sourceRow.cr_user_id), 150);
  }
  if (defaults._mappedActivityType) {
    (result as Activity).type = defaults._mappedActivityType as Activity['type'];
    delete (result as unknown as Row)._mappedActivityType;
  }
  if ('department' in record) {
    const archived = (defaults.commentHistory || []) as ContactComment[];
    const current = (record as ContactRecord).commentHistory || [];
    const merged = [
      ...archived,
      ...current.filter((comment) => !archived.some((source) => source.id === comment.id)),
    ];
    const archivedNote = [
      scalar(sourceRow.fax) ? `팩스: ${scalar(sourceRow.fax)}` : '',
      scalar(sourceRow.address),
      ...comments
        .filter(
          (row) =>
            scalar(row.ct_cd) === scalar(sourceRow.ct_cd) && scalar(row.mng_cd) === scalar(sourceRow.mng_cd),
        )
        .map((row) => scalar(row.contents)),
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (
      (record as ContactRecord).note === legacyRedaction &&
      legacyPublicText(archivedNote) === legacyRedaction
    )
      (result as ContactRecord).note = protectionEnabled ? '보호됨' : archivedNote.slice(0, 10000);
    (result as ContactRecord).commentHistory = merged.map((comment) => ({
      ...comment,
      body: publicText(comment.body, protectionEnabled),
    }));
    for (const key of ['fax', 'workplace', 'zipcode'] as const)
      if (typeof (result as ContactRecord)[key] === 'string')
        (result as ContactRecord)[key] = publicText((result as ContactRecord)[key]!, protectionEnabled);
  } else if ('createdAt' in record && 'body' in record) {
    const typeLabel = codes.get(`act_type\0${scalar(sourceRow.act_type)}`) || '미분류';
    const contents = scalar(sourceRow.contents).trim();
    const archivedBody = [
      `원본 활동유형: ${typeLabel}`,
      scalar(sourceRow.act_dt) ? `원본 활동일: ${scalar(sourceRow.act_dt)}` : '',
      contents,
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (record.body === legacyRedaction && legacyPublicText(archivedBody) === legacyRedaction)
      (result as Activity).body = protectionEnabled ? '보호됨' : archivedBody.slice(0, 10000);
  } else if ('stage' in record) {
    const sale = result as SaleRecord;
    if (typeof sale.failedReason === 'string')
      sale.failedReason = publicText(sale.failedReason, protectionEnabled);
    if (typeof sale.retryProbability === 'string')
      sale.retryProbability = publicText(sale.retryProbability, protectionEnabled);
  }
  for (const key of [
    'note',
    'body',
    'title',
    'name',
    'businessNumber',
    'corporationNumber',
    'industry',
    'ceo',
    'address',
    'zipcode',
    'contactName',
    'contactRole',
    'phone',
    'mobile',
    'email',
    'department',
    'role',
    'owner',
    'author',
  ]) {
    const row = result as unknown as Row;
    if (typeof row[key] === 'string') row[key] = publicText(row[key], protectionEnabled);
  }
  return result;
}

/** Cache encrypted rows only; decrypt into a short-lived projection for each request. */
export class BusinessLegacyReader {
  private cache?: { until: number; ready: Promise<ArchiveSnapshot> };
  constructor(
    private pool: Pick<pg.Pool, 'query'>,
    private vault: () => Promise<LegacyVault> = () => openLegacyVault({ createIfMissing: false }),
  ) {}
  private async archives() {
    if (this.cache && this.cache.until > Date.now()) return this.cache.ready;
    const ready = Promise.all([
      this.pool.query<Archived>(
        `SELECT a.batch_id, r.source, r.key_id, a.source_table, a.source_key, a.envelope
      FROM yeta_crm_private.legacy_archive a JOIN yeta_crm_private.legacy_runs r ON r.id=a.batch_id
      WHERE r.source=$1 AND r.report->>'status'='committed' AND a.source_table=ANY($2::text[])
      ORDER BY a.source_table,a.source_key`,
        [
          source,
          ['manager_tb', 'manager_comment_tb', 'sales_tb', 'act_tb', 'code_tb', 'company_tb', 'task_tb'],
        ],
      ),
      this.pool.query<Ledger>(
        `SELECT i.batch_id,i.source_table,i.source_key,i.target_table,i.target_kind,i.target_id
      FROM yeta_crm_private.legacy_items i JOIN yeta_crm_private.legacy_runs r ON r.id=i.batch_id
      WHERE r.source=$1 AND r.report->>'status'='committed' AND i.source_table=ANY($2::text[])`,
        [source, Object.keys(businessTargets)],
      ),
    ]).then(([archives, items]) => ({ archives: archives.rows, items: items.rows }));
    const cache = { until: Date.now() + 300_000, ready };
    this.cache = cache;
    try {
      return await ready;
    } catch (error) {
      if (this.cache === cache) this.cache = undefined;
      throw error;
    }
  }
  async enrich<T extends CRMRecord | Activity | Company | Task>(records: T[]): Promise<T[]> {
    const currentProtection = async () => {
      const setting = (
        await this.pool.query<{ enabled: boolean }>(
          "SELECT data->'protectionEnabled' AS enabled FROM yeta_crm.workspace_settings WHERE singleton=true",
        )
      ).rows[0];
      return setting?.enabled !== false;
    };
    const strip = (record: T): T => {
      const { _activityTypeEdited, ...clean } = record as unknown as Row;
      return clean as unknown as T;
    };
    if (!records.some((record) => record.id.startsWith('legacy-'))) {
      const protectionEnabled = await currentProtection();
      return records.map((record) =>
        strip(mergeLegacyBusiness(record, {}, [], new Map(), protectionEnabled)),
      );
    }
    const snapshot = await this.archives();
    const rows = snapshot.archives;
    if (!rows.length) {
      const protectionEnabled = await currentProtection();
      return records.map((record) =>
        strip(mergeLegacyBusiness(record, {}, [], new Map(), protectionEnabled)),
      );
    }
    const vault = await this.vault();
    const ledger = new Map<string, Ledger>();
    for (const item of snapshot.items) {
      const key = ledgerIdentity(item.batch_id, item.source_table, item.source_key);
      if (ledger.has(key)) throw unavailable();
      ledger.set(key, item);
    }
    const decoded = rows.map((row) => {
      if (row.source !== source || row.key_id !== vault.keyId) throw unavailable();
      const data = parseInstallationArchive(
        vault.decrypt(row.envelope, {
          source: row.source,
          table: row.source_table,
          primaryKey: row.source_key,
          batchId: row.batch_id,
        }),
      );
      // Archive keys are ciphertext AAD hashes; ledger keys are original business identifiers.
      const originalKey = sourceBusinessKey(row.source_table, data);
      const item =
        originalKey === undefined
          ? undefined
          : ledger.get(ledgerIdentity(row.batch_id, row.source_table, originalKey));
      const expected = businessTargets[row.source_table];
      if (item && (!expected || item.target_table !== expected[0] || item.target_kind !== expected[1]))
        throw unavailable();
      return { meta: { ...row, target_id: item?.target_id }, data };
    });
    const codesByBatch = new Map<string, Map<string, string>>();
    const targets = new Map<string, (typeof decoded)[number]>();
    for (const row of decoded) {
      if (row.meta.source_table === 'code_tb') {
        const codes = codesByBatch.get(row.meta.batch_id) || new Map<string, string>();
        codes.set(`${scalar(row.data.grp_cd)}\0${scalar(row.data.code)}`, scalar(row.data.code_nm));
        codesByBatch.set(row.meta.batch_id, codes);
      }
      if (row.meta.target_id) {
        if (targets.has(row.meta.target_id)) throw unavailable();
        targets.set(row.meta.target_id, row);
      }
    }
    // Evaluate after archive I/O/decryption so a policy change during the read is reflected.
    const protectionEnabled = await currentProtection();
    return records.map((record) => {
      const original = targets.get(record.id);
      if (!original) return strip(mergeLegacyBusiness(record, {}, [], new Map(), protectionEnabled));
      if (original.meta.source_table === 'task_tb') {
        const contact = decoded.find(
          (row) =>
            row.meta.source_table === 'manager_tb' &&
            row.meta.batch_id === original.meta.batch_id &&
            scalar(row.data.ct_cd) === scalar(original.data.ct_cd) &&
            scalar(row.data.mng_cd) === scalar(original.data.mng_cd),
        );
        original.data = {
          ...original.data,
          _linkedContactId: contact?.meta.target_id || '',
          mng_nm: original.data.mng_nm || contact?.data.mng_nm || '',
        };
      }
      const comments = decoded
        .filter(
          (row) =>
            row.meta.source_table === 'manager_comment_tb' && row.meta.batch_id === original.meta.batch_id,
        )
        .map((row) => row.data);
      return strip(
        mergeLegacyBusiness(
          record,
          original.data,
          comments,
          codesByBatch.get(original.meta.batch_id),
          protectionEnabled,
        ),
      );
    });
  }
}
