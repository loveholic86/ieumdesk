import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type {
  InstallationDetails,
  InstallationDetailField,
  InstallationDetailSection,
  InstallationSectionId,
  InstallationSecretReveal,
} from '../src/installation-types.ts';
import type { Store } from './store.ts';
import { ApiError, notFound } from './errors.ts';
import { databaseConfig } from './config.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';
import { BusinessEncryption } from './business-encryption.ts';

const SOURCE = 'CRM_OLD_DB:public:v1';
const TABLES = [
  'setup_tb',
  'setup_cominfo_tb',
  'ct_yetalogin_tb',
  'ct_sap_tb',
  'setup_setting_tb',
  'setting_file_tb',
  'code_tb',
] as const;
const TITLES: [InstallationSectionId, string][] = [
  ['installation', '설치 정보'],
  ['access', '접근 정보'],
  ['server', '서버 정보'],
  ['yeta', 'YETA 로그인 정보'],
  ['sap', 'SAP 정보'],
  ['settings', '별도 설정 정보'],
  ['files', '설정 파일'],
];
const MASK = '••••••••';
const unavailable = () =>
  new ApiError(
    503,
    'INSTALLATION_ARCHIVE_UNAVAILABLE',
    '보관된 설치 자료를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  );
const opaque = (...values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
type Row = Record<string, unknown>;
type Codes = Map<string, string>;
type Plain = (value: string, row: Row, codes: Codes) => string | undefined;
type Field = { key: string; label: string; plain?: Plain };
type ArchiveRow = { source_table: string; source_key: string; envelope: LegacyVaultEnvelope };
type Batch = {
  id: string;
  source: string;
  fingerprint: string;
  keyId: string;
  setupKey: string;
  sourceCounts: Record<string, number>;
};
export interface InstallationScope {
  id: string;
  data: Row;
  batch?: Batch;
}
export type InstallationAuditOutcome = 'allowed' | 'denied' | 'failed';
export interface InstallationDetailsAccess {
  details(id: string, options?: { protected?: boolean; raw?: boolean }): Promise<InstallationDetails>;
  secrets(id: string): Promise<InstallationSecretReveal>;
  audit(actorUserId: string, installationId: string, outcome: InstallationAuditOutcome): Promise<void>;
  close?(): Promise<void>;
}
export interface InstallationArchiveRepository {
  installation(id: string): Promise<InstallationScope | undefined>;
  archives(batchId: string): Promise<ArchiveRow[]>;
  audit(actorUserId: string, installationId: string, outcome: InstallationAuditOutcome): Promise<void>;
  close?(): Promise<void>;
}

const integer: Plain = (value) => (/^\d{1,30}$/.test(value) ? value : undefined);
const year: Plain = (value) => (/^(?:19|20|21)\d{2}$/.test(value) ? value : undefined);
const identifier: Plain = (value) => (/^[A-Za-z\d_-]{1,80}$/.test(value) ? value : undefined);
const date: Plain = (value) =>
  /^(?:\d{8}|\d{4}[-./]\d{2}[-./]\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)?)$/.test(value)
    ? value
    : undefined;
const flag: Plain = (value) => {
  const labels: Record<string, string> = {
    Y: '예',
    N: '아니오',
    '1': '예',
    '0': '아니오',
    true: '예',
    false: '아니오',
  };
  return Object.hasOwn(labels, value) ? labels[value] : undefined;
};
const safeLabel = (value: string) =>
  /^[\p{L}\p{N} _()/+-]{1,80}$/u.test(value) &&
  !/(?:password|passwd|secret|token|비밀번호|비번|패스워드|접속정보)/i.test(value);
const code =
  (group: string): Plain =>
  (value, _row, codes) =>
    codes.get(`${group}\0${value}`) ?? identifier(value, _row, codes);
const choice =
  (values: Record<string, string>): Plain =>
  (value) =>
    Object.hasOwn(values, value) ? values[value] : undefined;
const field = (key: string, label: string, plain?: Plain): Field => ({
  key,
  label,
  ...(plain ? { plain } : {}),
});

const CURRENT = [
  field('systemCode', '시스템 코드', (value) => (/^[A-Za-z\d_, -]{1,80}$/.test(value) ? value : undefined)),
  field(
    'serviceVersion',
    '서비스 버전',
    choice({ SAP: 'SAP', 'On Premises': 'On Premises', Cloud: 'Cloud' }),
  ),
  field('version', '현재 버전', (value) =>
    /^[vV]?\d{2,4}(?:[._-](?:\d{1,4}|[xX])){0,3}$/.test(value) ? value : undefined,
  ),
  field('installedAt', '설치일', date),
  field('patchedAt', '최종 패치일', date),
  field('engineer', '담당 엔지니어'),
  field('autoUpdate', '자동 업데이트', flag),
  field('domain', '도메인'),
  field('note', '비고'),
  field(
    'accessType',
    '접근 유형',
    choice({
      '알 수 없음': '알 수 없음',
      '바로 접근': '바로 접근',
      원격: '원격',
      불가: '불가',
      'VPN/VDI': 'VPN/VDI',
    }),
  ),
];
const BASIC = [
  field('setup_cd', '설치 ID', integer),
  field('sv_version', '서비스 버전', code('sv_version')),
  field('setup_year', '최초 설치 연도', year),
  field('setup_date', '최초 설치일', date),
  field('last_setup_date', '최종 패치일', date),
  field('yeta_version', '최종 예타 유형', choice({ '0': '중도퇴사자', '1': '일반' })),
  field('setup_engineer', '최종 패치 엔지니어'),
  field('autoupdate_yn', '자동 업데이트 가능', flag),
  field('bonding_yn', '네트워크 본딩', choice({ Y: 'Yes', N: 'No', E: '기타' })),
  field('mng_cd', '설치 담당자 코드', integer),
  field('ct_etc', '고객사 비고'),
  field('setup_etc', '서버 설정 비고'),
];
const CONNECTION = [
  field('ct_cd', '고객사 코드', integer),
  field('sys_cd', '시스템 코드', identifier),
  field('sys_member', '인원', integer),
  field('sys_com_count', '회사 코드 수', integer),
];
const ADDRESS = [
  field('domainurl', '도메인 URL'),
  field('ssh_port', 'SSH 포트'),
  field('external_ip', '외부 IP'),
  field('internal_ip', '내부 IP'),
  field('netmask', '넷마스크'),
  field('gateway', '게이트웨이'),
  field('dns1', 'DNS 1'),
  field('dns2', 'DNS 2'),
  field('ssl_apply_yn', 'SSL 적용', flag),
  field('ssl_manage_type', 'SSL 관리 유형', code('ssl_manage_type')),
  field('ssl_applydate', 'SSL 적용일', date),
  field('ssl_pwd', 'SSL 비밀번호'),
];
const VPN = [
  field('vpnsv_ip', 'VPN 서버 IP'),
  field('vpnsv_id', 'VPN 아이디'),
  field('vpnsv_pwd', 'VPN 비밀번호'),
];
const ACCESS = [
  field('access_type', '접근 유형', code('access_type')),
  field('rootpath', '설치 경로'),
  field('os_root_id', 'OS 관리자 아이디'),
  field('os_root_pwd', 'OS 관리자 비밀번호'),
  field('os_user_id', 'OS 사용자 아이디'),
  field('os_user_pwd', 'OS 사용자 비밀번호'),
  field('os_login_etc', 'OS 로그인 비고'),
  field('access_etc', '접근 비고'),
  field('access_reqst_date', '접근 신청일', date),
  field('access_reqst_enddate', '접근 종료일', date),
  field('access_url', '접근 URL'),
  field('access_id', '접근 아이디'),
  field('access_pwd', '접근 비밀번호'),
];
const SERVER = [
  field('hostname', '호스트네임'),
  field('servicetag', '서버 ServiceTag'),
  field('express_service_code', '서버 ExpressServiceCode'),
  field('model', '서버 모델명'),
  field('zipcode', '설치 장소 우편번호'),
  field('address', '설치 장소'),
  field('migration_date', '설치일', date),
  field('migration_engineer', '엔지니어'),
];
const YETA = [
  field('sys_cd', '시스템 코드', identifier),
  field('yeta_year', '연도', year),
  field('ct_cd', '고객사 코드', integer),
  field('app_type', '구분', code('app_type')),
  field('comcode', '회사 코드', identifier),
  field('yeta_id', 'YETA 아이디'),
  field('yeta_pwd', 'YETA 비밀번호'),
];
const SAP = [
  field('sys_cd', '시스템 코드', identifier),
  field('app_type', '구분', code('app_type')),
  field('app_ip', 'SAP 서버 IP'),
  field('sysnr', '인스턴스 번호'),
  field('r3name', '시스템 ID'),
  field('client', '클라이언트'),
  field('sap_id', 'SAP 아이디'),
  field('sap_pwd', 'SAP 비밀번호'),
  field('lang', '언어', choice({ KO: 'KO', EN: 'EN', ko: 'ko', en: 'en', K: 'K', E: 'E' })),
  field('gr_id', '그룹웨어 아이디'),
  field('gr_pwd', '그룹웨어 비밀번호'),
  field('etc', '비고'),
];
const SETTINGS = [
  field('setting_year', '연도', year),
  field('setting_type', '설정 종류', code('setting_type')),
  field('setting_yn', '적용 여부', flag),
  field('setting_etc', '비고'),
];
const settingValue: Plain = (value, row, codes) => {
  const key = String(row.set_name ?? '')
    .toLowerCase()
    .replace(/^file_/, '');
  if (['system_max_user_count', 'system_max_company_count', 'simplepay_use_cnt'].includes(key))
    return integer(value, row, codes);
  if (key === 'simplepay_use') return flag(value, row, codes);
  if (key === 'yeta_use_type') return choice({ '0': '중도퇴사자', '1': '일반' })(value, row, codes);
  return undefined; // Unknown configuration values may be credentials, URLs, or tokens.
};
const FILES = [
  field('system_code', '시스템 코드', identifier),
  field('att_year', '귀속 연도', year),
  field('set_name', '설정 키', (value) => (/^[A-Za-z][A-Za-z\d_.-]{0,79}$/.test(value) ? value : undefined)),
  field('set_value', '설정 값', settingValue),
];

/** Reclassify edited values from the same strict metadata allowlist as imports. */
export function installationWorkspaceField(
  sectionId: InstallationSectionId,
  rowId: string,
  key: string,
  label: string,
  value: string,
): InstallationDetailField {
  const definitions: Record<InstallationSectionId, Field[]> = {
    installation: [...CURRENT, ...BASIC, ...CONNECTION],
    access: [...ADDRESS, ...VPN, ...ACCESS],
    server: SERVER,
    yeta: YETA,
    sap: SAP,
    settings: SETTINGS,
    files: FILES,
  };
  const definition = definitions[sectionId].find((item) => item.key === key);
  // Configuration values need their complete row context; edits stay protected.
  const plain = key === 'set_value' ? undefined : definition?.plain?.(value, {}, new Map());
  const secret = value.length > 0 ? plain === undefined : !definition?.plain;
  return {
    id: `field-${opaque(rowId, key).slice(0, 32)}`,
    key,
    label,
    value: secret ? value : (plain ?? ''),
    secret,
    masked: false,
    present: value.length > 0,
  };
}

/** Preserve integer lexemes before JavaScript can round PostgreSQL bigint values. */
export function parseInstallationArchive(raw: string): Row {
  const parsed = (
    JSON.parse as (
      text: string,
      reviver: (key: string, value: unknown, context?: { source?: string }) => unknown,
    ) => unknown
  )(raw, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (context?.source && /^-?\d+$/.test(context.source)) return context.source;
    if (Number.isSafeInteger(value)) return String(value);
    throw unavailable();
  });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unavailable();
  return parsed as Row;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return String(value);
  throw unavailable();
}

type ArchiveIndex = { bySetup: Map<string, ArchiveRow[]>; codes: Codes };
export class InstallationDetailsService implements InstallationDetailsAccess {
  private cached?: { key: string; until: number; ready: Promise<ArchiveIndex> };
  constructor(
    private repository: InstallationArchiveRepository,
    private options: {
      vault?: () => Promise<LegacyVault>;
      schemaFile?: string | URL;
      now?: () => number;
    } = {},
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private async scope(id: string) {
    if (!id || id.length > 200) throw notFound();
    const scope = await this.repository.installation(id);
    if (!scope) throw notFound();
    return scope;
  }
  private async index(batch: Batch, vault: LegacyVault): Promise<ArchiveIndex> {
    const key = `${batch.id}:${batch.fingerprint}:${batch.keyId}`;
    if (this.cached?.key === key && this.cached.until > this.now()) return this.cached.ready;
    const ready = this.buildIndex(batch, vault);
    const cache = { key, until: this.now() + 5 * 60_000, ready };
    this.cached = cache;
    try {
      return await ready;
    } catch (error) {
      if (this.cached === cache) this.cached = undefined;
      throw error;
    }
  }
  private async buildIndex(batch: Batch, vault: LegacyVault): Promise<ArchiveIndex> {
    const metadata = JSON.parse(
      await readFile(
        this.options.schemaFile ?? new URL('../.local/migration/source-schema.json', import.meta.url),
        'utf8',
      ),
    ) as { tables?: { table_name: string; columns: { name: string; type: string }[] }[] };
    if (!Array.isArray(metadata.tables)) throw unavailable();
    for (const table of TABLES.filter((table) => table !== 'code_tb')) {
      const column = metadata.tables
        .find((item) => item.table_name === table)
        ?.columns.find((item) => item.name === 'setup_cd');
      if (column?.type !== 'bigint') throw unavailable();
    }
    const archives = await this.repository.archives(batch.id);
    const actualCounts = Object.fromEntries(TABLES.map((table) => [table, 0]));
    const bySetup = new Map<string, ArchiveRow[]>();
    const codes: Codes = new Map();
    for (const archive of archives) {
      if (!(TABLES as readonly string[]).includes(archive.source_table)) throw unavailable();
      actualCounts[archive.source_table] += 1;
      const row = parseInstallationArchive(
        vault.decrypt(archive.envelope, {
          source: batch.source,
          table: archive.source_table,
          primaryKey: archive.source_key,
          batchId: batch.id,
        }),
      );
      if (archive.source_table === 'code_tb') {
        const group = scalar(row.grp_cd),
          codeValue = scalar(row.code),
          label = scalar(row.code_nm);
        if (
          ['sv_version', 'app_type', 'access_type', 'ssl_manage_type', 'setting_type'].includes(group) &&
          safeLabel(label)
        )
          codes.set(`${group}\0${codeValue}`, label);
        continue;
      }
      const setup = scalar(row.setup_cd);
      if (!setup) continue; // Do not guess a cross-installation association from a shared system code.
      if (!/^-?\d+$/.test(setup)) throw unavailable();
      const entries = bySetup.get(setup) ?? [];
      entries.push(archive); // Cache ciphertext and routing identifiers only, never the decoded row.
      bySetup.set(setup, entries);
    }
    for (const table of TABLES) if (actualCounts[table] !== batch.sourceCounts[table]) throw unavailable();
    return { bySetup, codes };
  }
  private async render(scope: InstallationScope, reveal: boolean) {
    const sections: InstallationDetailSection[] = TITLES.map(([id, title]) => ({
      id,
      title,
      imported: false,
      rows: [],
    }));
    const values: Record<string, string> = {};
    const rawValues: Record<string, string> = {};
    let codes: Codes = new Map();
    const add = (
      section: InstallationSectionId,
      title: string,
      row: Row,
      table: string,
      sourceKey: string,
      fields: Field[],
      imported: boolean,
    ) => {
      const group = sections.find((item) => item.id === section)!;
      if (imported) group.imported = true;
      const rowId = `row-${opaque(scope.id, table, sourceKey, title).slice(0, 32)}`;
      const rendered: InstallationDetailField[] = fields.map((definition) => {
        const raw = scalar(row[definition.key]);
        const present = raw.length > 0;
        const plain = definition.plain?.(raw, row, codes);
        const secret = !definition.plain || (present && plain === undefined);
        const id = `field-${opaque(rowId, definition.key).slice(0, 32)}`;
        if (reveal) rawValues[id] = raw;
        if (reveal && secret && present) values[id] = raw;
        return {
          id,
          key: definition.key,
          label: definition.label,
          value: present ? (secret ? MASK : (plain ?? '')) : '',
          secret,
          masked: secret && present,
          present,
        };
      });
      group.rows.push({ id: rowId, title, fields: rendered });
    };
    add('installation', '현재 설치 정보', scope.data, 'current', scope.id, CURRENT, false);
    if (scope.batch) {
      const batch = scope.batch;
      if (batch.source !== SOURCE) throw unavailable();
      const vault = await (this.options.vault ?? (() => openLegacyVault({ createIfMissing: false })))();
      if (vault.keyId !== batch.keyId) throw unavailable();
      const index = await this.index(batch, vault);
      codes = index.codes;
      const archived = [...(index.bySetup.get(batch.setupKey) ?? [])].sort(
        (a, b) =>
          TABLES.indexOf(a.source_table as (typeof TABLES)[number]) -
            TABLES.indexOf(b.source_table as (typeof TABLES)[number]) ||
          a.source_key.localeCompare(b.source_key),
      );
      if (archived.filter((row) => row.source_table === 'setup_tb').length !== 1) throw unavailable();
      const counters: Record<string, number> = {};
      for (const archive of archived) {
        const row = parseInstallationArchive(
          vault.decrypt(archive.envelope, {
            source: batch.source,
            table: archive.source_table,
            primaryKey: archive.source_key,
            batchId: batch.id,
          }),
        );
        if (scalar(row.setup_cd) !== batch.setupKey) throw unavailable();
        const ordinal = (counters[archive.source_table] = (counters[archive.source_table] ?? 0) + 1);
        const addRow = (section: InstallationSectionId, title: string, fields: Field[]) =>
          add(section, title, row, archive.source_table, archive.source_key, fields, true);
        if (archive.source_table === 'setup_tb') {
          addRow('installation', '이관 원본 설치 정보', BASIC);
          addRow('access', '이관 원본 Address', ADDRESS);
          addRow('access', '이관 원본 VPN', VPN);
          addRow('access', '이관 원본 접근 정보', ACCESS);
          addRow('server', '이관 원본 서버 정보', SERVER);
        } else if (archive.source_table === 'setup_cominfo_tb')
          addRow('installation', `이관 원본 고객사 연결 ${ordinal}`, CONNECTION);
        else if (archive.source_table === 'ct_yetalogin_tb')
          addRow('yeta', `이관 원본 YETA 로그인 ${ordinal}`, YETA);
        else if (archive.source_table === 'ct_sap_tb') addRow('sap', `이관 원본 SAP ${ordinal}`, SAP);
        else if (archive.source_table === 'setup_setting_tb')
          addRow('settings', `이관 원본 별도 설정 ${ordinal}`, SETTINGS);
        else if (archive.source_table === 'setting_file_tb')
          addRow('files', `이관 원본 고객 전달용 설정 ${ordinal}`, FILES);
      }
    }
    for (const section of sections) {
      if (!section.imported) section.note = '이 설치에 연결된 이관 자료가 없습니다.';
      else if (section.id === 'files')
        section.note =
          '이관된 설정값과 암호화 작업본으로 일반 속성 파일을 생성합니다. 기존 고객 전달용 파일 형식은 아직 확인되지 않았습니다.';
    }
    return {
      details: {
        id: scope.id,
        imported: Boolean(scope.batch),
        revision: 0,
        sections,
      } satisfies InstallationDetails,
      values,
      rawValues,
    };
  }
  async details(id: string, options: { protected?: boolean; raw?: boolean } = {}) {
    const { details, values, rawValues } = await this.render(
      await this.scope(id),
      options.protected === false,
    );
    if (options.protected === false)
      for (const section of details.sections)
        for (const row of section.rows)
          for (const item of row.fields) {
            if (options.raw) item.value = rawValues[item.id];
            else if (Object.hasOwn(values, item.id)) item.value = values[item.id];
            item.masked = false;
          }
    return details;
  }
  async secrets(id: string): Promise<InstallationSecretReveal> {
    const scope = await this.scope(id);
    if (!scope.batch)
      throw new ApiError(409, 'INSTALLATION_NOT_IMPORTED', '이 설치에 연결된 이관 보관 자료가 없습니다.');
    const { values } = await this.render(scope, true);
    return { id, expiresAt: new Date(this.now() + 60_000).toISOString(), values };
  }
  async audit(actorUserId: string, installationId: string, outcome: InstallationAuditOutcome) {
    await this.repository.audit(actorUserId, installationId, outcome);
  }
  async close() {
    await this.repository.close?.();
  }
}

export class PostgresInstallationRepository implements InstallationArchiveRepository {
  private readPool?: Promise<pg.Pool>;
  private auditPool?: Promise<pg.Pool>;
  private encryption: BusinessEncryption;
  constructor(vault?: () => Promise<LegacyVault>) {
    this.encryption = new BusinessEncryption(vault);
  }
  private async pool(readOnly: boolean) {
    const create = async () => {
      const pool = new pg.Pool({
        ...(await databaseConfig(readOnly)),
        max: readOnly ? 2 : 1,
        allowExitOnIdle: true,
      });
      pool.on('error', () => {
        /* Never log connection or row details. */
      });
      try {
        if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== 'yeta_crm')
          throw unavailable();
        return pool;
      } catch (error) {
        await pool.end();
        throw error;
      }
    };
    if (readOnly)
      return (this.readPool ??= create().catch((error) => {
        this.readPool = undefined;
        throw error;
      }));
    return (this.auditPool ??= create().catch((error) => {
      this.auditPool = undefined;
      throw error;
    }));
  }
  async installation(id: string): Promise<InstallationScope | undefined> {
    const pool = await this.pool(true);
    const stored = (
      await pool.query<{ id: string; kind: string; data: Row; protected_data: unknown }>(
        "SELECT id,kind,data,protected_data FROM yeta_crm.records WHERE kind='installations' AND id=$1 AND archived_at IS NULL",
        [id],
      )
    ).rows[0];
    if (!stored) return undefined;
    const decoded = await this.encryption.decrypt('records', stored);
    const record: InstallationScope = { id: stored.id, data: decoded.data as Row };
    const rows = (
      await pool.query(
        `SELECT i.source_key, r.id, r.source, r.fingerprint, r.key_id, r.report
       FROM yeta_crm_private.legacy_items i JOIN yeta_crm_private.legacy_runs r ON r.id=i.batch_id
       WHERE i.target_table='records' AND i.target_kind='installations' AND i.target_id=$1 AND i.source_table='setup_tb'`,
        [id],
      )
    ).rows;
    if (rows.length > 1) throw unavailable();
    const linked = rows[0];
    if (!linked || linked.report?.status !== 'committed') return record;
    if (
      linked.source !== SOURCE ||
      typeof linked.source_key !== 'string' ||
      !/^-?\d+$/.test(linked.source_key) ||
      !linked.report?.sourceCounts
    )
      throw unavailable();
    return {
      ...record,
      batch: {
        id: linked.id,
        source: linked.source,
        fingerprint: linked.fingerprint,
        keyId: linked.key_id,
        setupKey: linked.source_key,
        sourceCounts: linked.report.sourceCounts,
      },
    };
  }
  async archives(batchId: string) {
    return (
      await (
        await this.pool(true)
      ).query<ArchiveRow>(
        'SELECT source_table,source_key,envelope FROM yeta_crm_private.legacy_archive WHERE batch_id=$1 AND source_table=ANY($2::text[]) ORDER BY source_table,source_key',
        [batchId, TABLES],
      )
    ).rows;
  }
  async audit(actorUserId: string, installationId: string, outcome: InstallationAuditOutcome) {
    await (
      await this.pool(false)
    ).query(
      'INSERT INTO yeta_crm_private.installation_secret_audit(actor_user_id,installation_ref_hash,outcome) VALUES($1,$2,$3)',
      [actorUserId, opaque('installation-audit-v1', installationId), outcome],
    );
  }
  async close() {
    await Promise.all([
      this.readPool?.then((pool) => pool.end()),
      this.auditPool?.then((pool) => pool.end()),
    ]);
  }
}

export function createInstallationDetailsAccess(store: Store): InstallationDetailsAccess {
  if (store.mode === 'postgres') return new InstallationDetailsService(new PostgresInstallationRepository());
  return new InstallationDetailsService({
    async installation(id) {
      const record = (await store.listRecords('installations')).find((record) => record.id === id);
      return record ? { id: record.id, data: record as unknown as Row } : undefined;
    },
    async archives() {
      return [];
    },
    // Demo installations have no archived secrets and can never return a reveal.
    async audit() {},
  });
}
