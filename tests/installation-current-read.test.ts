import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CatalogService } from '../server/catalog.ts';
import { ApiError } from '../server/errors.ts';
import { InstallationDetailsService } from '../server/installation-details.ts';
import { managedField, type ManagedInstallationState } from '../server/installation-managed.ts';
import {
  InstallationWorkspaceService,
  MemoryInstallationWorkspaceRepository,
  PostgresInstallationWorkspaceRepository,
  type InstallationWorkspaceRepository,
} from '../server/installation-workspace.ts';
import { LegacyReader } from '../server/legacy-reader.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from '../server/legacy-vault.ts';
import { createMaterializer, materializeInstallations } from '../scripts/materialize-installations.ts';
import { FileInstallationWorkspaceRepository } from '../server/installation-workspace-file.ts';
import { english } from '../src/locales/en.ts';

const sections: [ManagedInstallationState['sections'][number]['id'], string][] = [
  ['installation', '설치 정보'],
  ['access', '접근 정보'],
  ['server', '서버 정보'],
  ['yeta', 'YETA 로그인 정보'],
  ['sap', 'SAP 정보'],
  ['settings', '별도 설정 정보'],
  ['files', '설정 파일'],
];
const tables = [
  'setup_tb',
  'setup_cominfo_tb',
  'ct_yetalogin_tb',
  'ct_sap_tb',
  'setup_setting_tb',
  'setting_file_tb',
  'code_tb',
] as const;
const setupKey = '9007199254740993';
const adjacentKey = '9007199254740992';
const workspaceContext = (id: string, revision: number) => ({
  source: 'yeta-crm-workspace:v1',
  table: 'installation_workspace',
  primaryKey: id,
  batchId: String(revision),
});

function accessState(): ManagedInstallationState {
  const rows = [
    ['address-row', 'domainurl', '도메인 URL', 'https://demo.example'],
    ['vpn-row', 'vpnsv_ip', 'VPN 서버 IP', '203.0.113.10'],
    ['access-row', 'access_url', '접근 URL', 'https://demo.example/gate'],
  ] as const;
  return {
    version: 2,
    sections: sections.map(([id, title]) => ({
      id,
      title,
      rows:
        id === 'access'
          ? rows.map(([rowId, key, label, value]) => ({
              id: rowId,
              title: label,
              fields: [managedField('access', rowId, key, label, value)],
            }))
          : [],
    })),
  };
}

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), 'ieum-current-'));
  const keys = path.join(root, 'keys');
  await mkdir(keys, { mode: 0o700 });
  return {
    root,
    vault: await openLegacyVault({ keyFile: path.join(keys, 'vault.key'), createIfMissing: true }),
  };
}

function store(stored: LegacyVault, id: string, state: unknown, revision = 1) {
  const repository = new MemoryInstallationWorkspaceRepository();
  const envelope = stored.encrypt(JSON.stringify(state), workspaceContext(id, revision));
  repository.records.set(id, { revision, envelope });
  return repository;
}

function blankDetails(rowId = 'row-0123456789abcdef0123456789abcdef') {
  return {
    id: 'inst-v1',
    imported: false,
    revision: 0,
    sections: sections.map(([id, title]) => ({
      id,
      title,
      imported: false,
      rows:
        id === 'access'
          ? [
              {
                id: rowId,
                title: '접속 주소',
                fields: [
                  {
                    id: 'field-domainurl',
                    key: 'domainurl',
                    label: '도메인 URL',
                    value: 'https://demo.example',
                    secret: false,
                    masked: false,
                    present: true,
                  },
                ],
              },
            ]
          : [],
    })),
  };
}

test('i18n translates the protected field label', () => {
  assert.equal(english['보호 항목'], 'Protected field');
});

test('installation-details keeps archive safety on current table rows', async () => {
  const opened = await vault();
  const now = 1_700_000_000_000;
  const schemaPath = path.join(opened.root, 'schema.json');
  await writeFile(
    schemaPath,
    JSON.stringify({
      tables: tables
        .filter((table) => table !== 'code_tb')
        .map((table) => ({ table_name: table, columns: [{ name: 'setup_cd', type: 'bigint' }] })),
    }),
  );
  const archiveContext = (table: string, sourceKey: string) => ({
    source: 'CRM_OLD_DB:public:v1',
    table,
    primaryKey: sourceKey,
    batchId: 'batch-1',
  });
  const body = (table: string, sourceKey: string) => {
    if (table === 'code_tb') return JSON.stringify({ grp_cd: 'sv_version', code: '1', code_nm: '비번' });
    if (table === 'setup_cominfo_tb') return `{"setup_cd":${setupKey},"ct_cd":${sourceKey},"sys_cd":"DEMO"}`;
    if (table === 'setting_file_tb')
      return `{"setup_cd":${setupKey},"system_code":"DEMO","att_year":"2026","set_name":"system_max_user_count","set_value":"12"}`;
    if (table === 'setup_tb')
      return `{"setup_cd":${setupKey},"sv_version":"1","domainurl":"https://demo.example","ssl_apply_yn":"Y","ssl_pwd":"present","access_pwd":"present","access_url":"https://demo.example/gate"}`;
    return `{"setup_cd":${setupKey}}`;
  };
  const envelopes = () =>
    tables.flatMap((table) => {
      const keys = table === 'setup_cominfo_tb' ? [adjacentKey, setupKey] : [table === 'setup_tb' ? setupKey : '1'];
      return keys.map((sourceKey) => ({
        source_table: table,
        source_key: sourceKey,
        envelope: opened.vault.encrypt(body(table, sourceKey), archiveContext(table, sourceKey)),
      }));
    });
  const batch = {
    id: 'batch-1',
    source: 'CRM_OLD_DB:public:v1',
    fingerprint: 'ab'.repeat(32),
    keyId: opened.vault.keyId,
    setupKey,
    sourceCounts: Object.fromEntries(tables.map((table) => [table, table === 'setup_cominfo_tb' ? 2 : 1])),
  };
  let archives = 0;
  const repository = {
    async installation(id: string) {
      return { id, data: { systemCode: 'DEMO-CURRENT' }, batch };
    },
    async archives() {
      archives += 1;
      return envelopes();
    },
    async audit() {},
  };
  try {
    const details = new InstallationDetailsService(repository, {
      vault: async () => opened.vault,
      schemaFile: schemaPath,
      now: () => now,
    });
    const masked = await details.details('inst-archive');
    const again = await details.details('inst-archive');
    assert.equal(archives, 1);
    assert.equal(again.sections.length, masked.sections.length);
    assert.deepEqual(
      masked.sections.map((section) => section.id),
      sections.map(([id]) => id),
    );
    const secret = masked.sections
      .flatMap((section) => section.rows.flatMap((row) => row.fields))
      .filter((field) => field.secret && field.present);
    assert.ok(secret.length > 0);
    assert.ok(secret.every((field) => field.masked && field.value === '••••••••'));
    const links = masked.sections
      .find((section) => section.id === 'installation')!
      .rows.filter((row) => row.title?.includes('고객사 연결'));
    assert.deepEqual(
      links.map((row) => row.fields.find((field) => field.key === 'ct_cd')?.value),
      [adjacentKey, setupKey],
    );
    const setup = masked.sections
      .find((section) => section.id === 'installation')!
      .rows.flatMap((row) => row.fields)
      .find((field) => field.key === 'setup_cd');
    assert.equal(setup?.value, setupKey);
    const version = masked.sections
      .find((section) => section.id === 'installation')!
      .rows.flatMap((row) => row.fields)
      .find((field) => field.key === 'sv_version');
    assert.equal(version?.value, '1');
    const fileRow = masked.sections.find((section) => section.id === 'files')!.rows[0];
    assert.equal(fileRow.fields.find((field) => field.key === 'set_name')?.value, 'system_max_user_count');
    const revealed = await details.details('inst-archive', { protected: false });
    const password = revealed.sections
      .find((section) => section.id === 'access')!
      .rows.flatMap((row) => row.fields)
      .find((field) => field.key === 'access_pwd');
    assert.equal(password?.present, true);
    assert.equal(password?.masked, false);
    assert.equal(archives, 1);
    const secrets = await details.secrets('inst-archive');
    assert.equal(secrets.expiresAt, new Date(now + 60_000).toISOString());
    assert.equal(archives, 1);

    const mismatch = {
      ...batch,
      sourceCounts: { ...batch.sourceCounts, setting_file_tb: 9 },
    };
    const closed = new InstallationDetailsService(
      { ...repository, async installation(id: string) { return { id, data: { systemCode: 'DEMO-CURRENT' }, batch: mismatch }; } },
      { vault: async () => opened.vault, schemaFile: schemaPath, now: () => now },
    );
    await assert.rejects(
      () => closed.details('inst-archive'),
      (error: ApiError) => error.code === 'INSTALLATION_ARCHIVE_UNAVAILABLE',
    );
    let tamperReads = 0;
    const tampered = new InstallationDetailsService(
      { ...repository, async archives() { return envelopes(); } },
      {
        schemaFile: schemaPath,
        now: () => now,
        vault: async () => ({
          keyId: opened.vault.keyId,
          encrypt: opened.vault.encrypt.bind(opened.vault),
          decrypt(envelope: LegacyVaultEnvelope, context: { source: string; table: string; primaryKey: string; batchId: string }) {
            const plain = opened.vault.decrypt(envelope, context);
            if (context.table === 'setup_cominfo_tb' && context.primaryKey === adjacentKey) {
              tamperReads += 1;
              if (tamperReads > 1) return plain.replaceAll(setupKey, '1');
            }
            return plain;
          },
        }),
      },
    );
    await assert.rejects(
      () => tampered.details('inst-archive'),
      (error: ApiError) => error.code === 'INSTALLATION_ARCHIVE_UNAVAILABLE',
    );
    const badSchema = path.join(opened.root, 'schema-int.json');
    await writeFile(
      badSchema,
      JSON.stringify({
        tables: tables
          .filter((table) => table !== 'code_tb')
          .map((table) => ({ table_name: table, columns: [{ name: 'setup_cd', type: 'integer' }] })),
      }),
    );
    const schemaRejected = new InstallationDetailsService(repository, {
      vault: async () => opened.vault,
      schemaFile: badSchema,
      now: () => now,
    });
    await assert.rejects(
      () => schemaRejected.details('inst-archive'),
      (error: ApiError) => error.code === 'INSTALLATION_ARCHIVE_UNAVAILABLE',
    );
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('installation-workspace keeps existing row ids and does not swallow original-read errors', async () => {
  const opened = await vault();
  const id = 'inst-v1';
  const rowId = 'row-0123456789abcdef0123456789abcdef';
  const reads = { count: 0 };
  const repository = store(opened.vault, id, { version: 1, added: [], deleted: [], patches: {} });
  const service = new InstallationWorkspaceService(
    {
      async details() {
        reads.count += 1;
        return blankDetails(rowId);
      },
      async secrets() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async audit() {
        throw new Error('INSTALLATION_MATERIALIZATION_PREPARATION_WRITE_FORBIDDEN');
      },
    },
    repository,
    { vault: async () => opened.vault },
  );
  try {
    await service.updateRow(id, rowId, { revision: 1, values: { domainurl: 'https://demo.example/kept' } }, 'actor');
    assert.equal(reads.count, 2);
    const details = await service.details(id, { protected: false, raw: true });
    assert.equal(reads.count, 2);
    const row = details.sections.find((section) => section.id === 'access')!.rows[0];
    assert.equal(row.id, rowId);
    assert.match(row.id, /^row-[a-f0-9]{32}$/);
    await assert.rejects(
      () =>
        service.updateRow(
          id,
          'row-ffffffffffffffffffffffffffffffff',
          { revision: 2, values: { domainurl: 'https://demo.example/missing' } },
          'actor',
        ),
      (error: ApiError) => error.status === 404 && error.message === '요청한 항목을 찾을 수 없습니다.',
    );
    const blown = new InstallationWorkspaceService(
      {
        async details() {
          throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
        },
        async secrets() {
          throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
        },
        async audit() {},
      },
      store(opened.vault, 'inst-v2', accessState()),
      {
        vault: async () => opened.vault,
        metadata: {
          async read() {
            throw new Error('UNEXPECTED_SOURCE_READ');
          },
          async update() {
            throw new Error('INSTALLATION_MATERIALIZATION_PREPARATION_WRITE_FORBIDDEN');
          },
        },
      },
    );
    await assert.rejects(() => blown.details('inst-v2'), /UNEXPECTED_SOURCE_READ/);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('prepareMaterialization does not save an empty document when the workspace is absent', async () => {
  const opened = await vault();
  const reads = { count: 0 };
  let saves = 0;
  const service = new InstallationWorkspaceService(
    {
      async details() {
        reads.count += 1;
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async secrets() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async audit() {
        throw new Error('INSTALLATION_MATERIALIZATION_PREPARATION_WRITE_FORBIDDEN');
      },
    },
    {
      async get() {
        return undefined;
      },
      async save() {
        saves += 1;
        throw new Error('INSTALLATION_MATERIALIZATION_PREPARATION_WRITE_FORBIDDEN');
      },
    },
    { vault: async () => opened.vault },
  );
  try {
    await assert.rejects(
      () => service.prepareMaterialization('missing-workspace'),
      (error: ApiError) => error.code === 'INSTALLATION_WORKSPACE_ABSENT',
    );
    assert.equal(reads.count, 0);
    assert.equal(saves, 0);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('installation-managed does not group a manually added adjacent row', async () => {
  const opened = await vault();
  const id = 'inst-current';
  const plain = accessState();
  const storedGroup = 'cd'.repeat(32);
  const grouped = accessState();
  grouped.sections.find((section) => section.id === 'access')!.rows[0].origin = {
    group: storedGroup,
    part: 'address',
  };
  grouped.sections.find((section) => section.id === 'access')!.rows[1].origin = {
    group: storedGroup,
    part: 'vpn',
  };
  const reads = { count: 0 };
  const service = new InstallationWorkspaceService(
    {
      async details() {
        reads.count += 1;
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async secrets() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async audit() {},
    },
    store(opened.vault, id, grouped),
    { vault: async () => opened.vault, metadata: { async read() { return { systemCode: 'DEMO-CURRENT' }; }, async update() {} } },
  );
  const ungrouped = new InstallationWorkspaceService(
    {
      async details() {
        reads.count += 1;
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async secrets() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async audit() {},
    },
    store(opened.vault, 'inst-plain', plain),
    { vault: async () => opened.vault, metadata: { async read() { return {}; }, async update() {} } },
  );
  try {
    const before = await service.details(id, { protected: false, raw: true });
    assert.equal(reads.count, 0);
    const beforeRows = before.sections.find((section) => section.id === 'access')!.rows;
    assert.deepEqual(
      beforeRows.map((row) => row.id),
      ['address-row', 'vpn-row', 'access-row'],
    );
    assert.equal(beforeRows[0].origin?.group, storedGroup);
    assert.equal(beforeRows[1].origin?.group, storedGroup);
    assert.equal(beforeRows[2].origin, undefined);
    await service.createRow(
      id,
      {
        revision: 1,
        sectionId: 'access',
        title: '수동 인접 행',
        fields: [{ key: 'domainurl', label: '도메인 URL', value: 'https://demo.example/manual' }],
      },
      'actor',
    );
    const after = await service.details(id, { protected: false, raw: true });
    const rows = after.sections.find((section) => section.id === 'access')!.rows;
    const manual = rows.find((row) => row.title === '수동 인접 행');
    assert.equal(manual?.origin, undefined);
    assert.match(manual?.id ?? '', /^workspace-row-/);
    assert.equal(rows.find((row) => row.id === 'address-row')?.origin?.group, storedGroup);
    assert.equal(rows.find((row) => row.id === 'vpn-row')?.origin?.group, storedGroup);
    assert.equal(rows.find((row) => row.id === 'access-row')?.origin, undefined);
    const guessed = await ungrouped.details('inst-plain', { protected: false, raw: true });
    assert.ok(
      guessed.sections
        .find((section) => section.id === 'access')!
        .rows.every((row) => row.origin === undefined),
    );
    assert.equal(reads.count, 0);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('materialize execution is retired before any read or encrypted save', async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      throw new Error(`UNEXPECTED_SOURCE_READ ${sql}`);
    },
  };
  const files = {
    async lock() {
      throw new Error('LOCK_MUST_NOT_RUN');
    },
    async capture() {
      throw new Error('CAPTURE_MUST_NOT_RUN');
    },
  };
  assert.throws(() => createMaterializer(client, {} as LegacyVault), /INSTALLATION_MATERIALIZATION_RETIRED/);
  await assert.rejects(
    () =>
      materializeInstallations(client, {} as LegacyVault, files, {
        apply: true,
        expectedCount: 1,
        expectedFingerprint: 'ab'.repeat(32),
      }),
    /INSTALLATION_MATERIALIZATION_RETIRED/,
  );
  await assert.rejects(
    () => materializeInstallations(client, {} as LegacyVault, files, { apply: false, expectedCount: 0 }),
    /INSTALLATION_MATERIALIZATION_RETIRED/,
  );
  assert.equal(queries.length, 0);
});

test('a new multi-part access save groups outside the ciphertext', async () => {
  const opened = await vault();
  const id = 'inst-new-save';
  const empty = accessState();
  for (const section of empty.sections) section.rows = [];
  const repository = new FileInstallationWorkspaceRepository(path.join(opened.root, 'workspaces'));
  const envelope = opened.vault.encrypt(JSON.stringify(empty), workspaceContext(id, 1));
  await repository.save(id, 0, envelope, 'actor', 'row-create');
  const reads = { count: 0 };
  const service = new InstallationWorkspaceService(
    {
      async details() {
        reads.count += 1;
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async secrets() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async audit() {},
    },
    repository,
    { vault: async () => opened.vault },
  );
  try {
    await service.createRow(
      id,
      {
        revision: 1,
        sectionId: 'access',
        title: '신규 접근',
        fields: [
          { key: 'domainurl', label: '도메인 URL', value: 'https://demo.example' },
          { key: 'vpnsv_ip', label: 'VPN 서버 IP', value: '203.0.113.10' },
          { key: 'vpnsv_pwd', label: 'VPN 비밀번호', value: 'demo-vpn-secret' },
          { key: 'access_url', label: '접근 URL', value: 'https://demo.example/gate' },
        ],
      },
      'actor',
    );
    const stored = await repository.get(id);
    const plain = JSON.parse(opened.vault.decrypt(stored!.envelope, workspaceContext(id, stored!.revision)));
    const savedRows = plain.sections.find((section: { id: string }) => section.id === 'access').rows;
    assert.equal(savedRows.length, 3);
    assert.ok(savedRows.every((row: { origin?: unknown }) => !Object.hasOwn(row, 'origin')));
    assert.equal(Object.keys(stored!.accessOrigins ?? {}).length, 3);
    const details = await service.details(id, { protected: false, raw: true });
    const rows = details.sections.find((section) => section.id === 'access')!.rows;
    assert.deepEqual(
      rows.map((row) => row.origin?.part),
      ['address', 'vpn', 'access'],
    );
    assert.equal(rows[0].origin?.group, rows[1].origin?.group);
    assert.equal(rows[1].origin?.group, rows[2].origin?.group);
    assert.match(rows[0].origin?.group ?? '', /^[a-f0-9]{64}$/);
    assert.equal(reads.count, 0);
    await service.createRow(
      id,
      {
        revision: stored!.revision,
        sectionId: 'access',
        title: '단일 접속',
        fields: [{ key: 'domainurl', label: '도메인 URL', value: 'https://demo.example/manual' }],
      },
      'actor',
    );
    const after = await service.details(id, { protected: false, raw: true });
    const manual = after.sections.find((section) => section.id === 'access')!.rows.find((row) => row.title === '단일 접속');
    assert.equal(manual?.origin, undefined);
    assert.equal(reads.count, 0);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('legacy vault creates a private key directory and rejects an existing unsafe one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ieum-vault-env-'));
  const loose = path.join(root, 'loose');
  const sealed = path.join(root, 'sealed');
  const absent = path.join(root, 'absent');
  await mkdir(loose);
  await mkdir(sealed, { mode: 0o700 });
  await chmod(loose, 0o755);
  await chmod(sealed, 0o700);
  const previous = process.env.LEGACY_VAULT_KEY_FILE;
  const previousUmask = process.umask(0o022);
  delete process.env.LEGACY_VAULT_KEY_FILE;
  try {
    await assert.rejects(
      () => openLegacyVault({ keyFile: path.join(loose, 'vault.key'), createIfMissing: true }),
      (error: Error) => error.message === 'LEGACY_VAULT_KEY_DIRECTORY_UNSAFE',
    );
    assert.equal((await stat(loose)).mode & 0o777, 0o755);
    await assert.rejects(
      () => openLegacyVault({ keyFile: path.join(loose, 'other.key'), createIfMissing: false }),
      (error: Error) => error.message === 'LEGACY_VAULT_KEY_DIRECTORY_UNSAFE',
    );
    assert.equal((await stat(loose)).mode & 0o777, 0o755);
    await assert.rejects(
      () => openLegacyVault({ keyFile: path.join(sealed, 'missing.key'), createIfMissing: false }),
      (error: Error) => error.message === 'LEGACY_VAULT_KEY_MISSING',
    );
    assert.equal(await stat(path.join(sealed, 'missing.key')).then(() => true, () => false), false);
    assert.equal((await stat(sealed)).mode & 0o777, 0o700);
    await assert.rejects(
      () => openLegacyVault({ keyFile: path.join(absent, 'vault.key'), createIfMissing: false }),
      (error: Error) => error.message === 'LEGACY_VAULT_KEY_MISSING',
    );
    assert.equal(await stat(absent).then(() => true, () => false), false);
    const keyFile = path.join(root, 'fresh', 'vault.key');
    process.env.LEGACY_VAULT_KEY_FILE = keyFile;
    const opened = await openLegacyVault({ createIfMissing: true });
    const context = workspaceContext('env-override', 1);
    assert.equal(opened.decrypt(opened.encrypt('kept', context), context), 'kept');
    assert.equal((await stat(path.dirname(keyFile))).mode & 0o777, 0o700);
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    if (previous === undefined) delete process.env.LEGACY_VAULT_KEY_FILE;
    else process.env.LEGACY_VAULT_KEY_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('access origin migration adds a nullable sidecar and does not rewrite rows', () => {
  const sql = readFileSync(new URL('../db/017_installation_access_origins.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../scripts/migrate-features.ts', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS access_origins jsonb/);
  assert.match(sql, /access_origins IS NULL OR jsonb_typeof\(access_origins\) = 'object'/);
  assert.equal(/\bUPDATE\b/i.test(sql), false);
  assert.match(runner, /017_installation_access_origins\.sql/);
});

function postgresDouble() {
  const rows = new Map<string, { revision: number; envelope: unknown; access_origins: unknown }>();
  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (text.includes('FROM yeta_crm.records')) return { rows: [{ present: 1 }], rowCount: 1 };
    if (text.includes('FROM yeta_crm.auth_users'))
      return { rows: [{ role: 'admin', status: 'active' }], rowCount: 1 };
    if (text.startsWith('SELECT revision FROM yeta_crm_private.installation_workspace')) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [{ revision: row.revision }] : [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith('SELECT revision,envelope,access_origins')) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith('INSERT INTO yeta_crm_private.installation_workspace(')) {
      const [id, revision, envelope, , accessOrigins] = params;
      rows.set(String(id), {
        revision: revision as number,
        envelope,
        access_origins: accessOrigins,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO yeta_crm_private.installation_workspace_audit'))
      return { rows: [], rowCount: 1 };
    throw new Error(`unexpected sql ${text}`);
  };
  const client = { query, release() {} };
  return {
    rows,
    query,
    async connect() {
      return client;
    },
  };
}

test('postgres save and get round-trip access origins for a new multi-part row', async () => {
  const opened = await vault();
  const database = postgresDouble();
  const repository = new PostgresInstallationWorkspaceRepository(database);
  const id = 'inst-postgres-group';
  const empty = accessState();
  for (const section of empty.sections) section.rows = [];
  const envelope = opened.vault.encrypt(JSON.stringify(empty), workspaceContext(id, 1));
  const service = new InstallationWorkspaceService(
    {
      async details() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async secrets() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async audit() {},
    },
    repository,
    { vault: async () => opened.vault },
  );
  try {
    assert.equal(repository.persistsAccessOrigins, true);
    await repository.save(id, 0, envelope, '00000000-0000-4000-8000-000000000001', 'row-create');
    assert.equal(database.rows.get(id)?.access_origins, null);
    await service.createRow(
      id,
      {
        revision: 1,
        sectionId: 'access',
        title: '신규 접근',
        fields: [
          { key: 'domainurl', label: '도메인 URL', value: 'https://demo.example' },
          { key: 'vpnsv_ip', label: 'VPN 서버 IP', value: '203.0.113.10' },
          { key: 'vpnsv_pwd', label: 'VPN 비밀번호', value: 'demo-vpn-secret' },
          { key: 'access_url', label: '접근 URL', value: 'https://demo.example/gate' },
        ],
      },
      '00000000-0000-4000-8000-000000000001',
    );
    const stored = await repository.get(id);
    const plain = JSON.parse(opened.vault.decrypt(stored!.envelope, workspaceContext(id, stored!.revision)));
    const savedRows = plain.sections.find((section: { id: string }) => section.id === 'access').rows;
    assert.equal(savedRows.length, 3);
    assert.ok(savedRows.every((row: { origin?: unknown }) => !Object.hasOwn(row, 'origin')));
    assert.equal(Object.keys(stored!.accessOrigins ?? {}).length, 3);
    const details = await service.details(id, { protected: false, raw: true });
    const rows = details.sections.find((section) => section.id === 'access')!.rows;
    assert.deepEqual(
      rows.map((row) => row.origin?.part),
      ['address', 'vpn', 'access'],
    );
    assert.equal(rows[0].origin?.group, rows[2].origin?.group);
  } finally {
    await repository.close();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('a repository that cannot persist the sidecar keeps a multi-part save as one row', async () => {
  const opened = await vault();
  const id = 'inst-no-sidecar';
  class DroppingRepository implements InstallationWorkspaceRepository {
    readonly persistsAccessOrigins = false;
    private record?: { revision: number; envelope: LegacyVaultEnvelope };
    async get() {
      return this.record ? structuredClone(this.record) : undefined;
    }
    async save(_id: string, expected: number, envelope: LegacyVaultEnvelope) {
      if ((this.record?.revision ?? 0) !== expected) throw new Error('conflict');
      this.record = { revision: expected + 1, envelope: structuredClone(envelope) };
      return this.record.revision;
    }
  }
  const repository = new DroppingRepository();
  const empty = accessState();
  for (const section of empty.sections) section.rows = [];
  await repository.save(
    id,
    0,
    opened.vault.encrypt(JSON.stringify(empty), workspaceContext(id, 1)),
  );
  const service = new InstallationWorkspaceService(
    {
      async details() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async secrets() {
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async audit() {},
    },
    repository,
    { vault: async () => opened.vault },
  );
  try {
    await service.createRow(
      id,
      {
        revision: 1,
        sectionId: 'access',
        title: '신규 접근',
        fields: [
          { key: 'domainurl', label: '도메인 URL', value: 'https://demo.example' },
          { key: 'vpnsv_ip', label: 'VPN 서버 IP', value: '203.0.113.10' },
          { key: 'access_url', label: '접근 URL', value: 'https://demo.example/gate' },
        ],
      },
      'actor',
    );
    const stored = await repository.get();
    const plain = JSON.parse(opened.vault.decrypt(stored!.envelope, workspaceContext(id, stored!.revision)));
    const savedRows = plain.sections.find((section: { id: string }) => section.id === 'access').rows;
    assert.equal(savedRows.length, 1);
    assert.equal(Object.hasOwn(savedRows[0], 'origin'), false);
    const details = await service.details(id, { protected: false, raw: true });
    const rows = details.sections.find((section) => section.id === 'access')!.rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.origin, undefined);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('catalog list merges legacy code and product rows', async () => {
  const original = LegacyReader.prototype.read;
  let calls = 0;
  LegacyReader.prototype.read = async function (tables: string[]) {
    calls += 1;
    if (tables[0] === 'code_tb')
      return [
        {
          table: 'code_tb',
          key: 'sv',
          data: { grp_cd: 'sv_version', grp_cd_nm: '버전', code: '1', code_nm: 'Cloud', parent_cd: '' },
        },
      ];
    return [
      {
        table: 'quotation_item_tb',
        key: 'item',
        data: { qt_item_nm: '설치', amount: 10, conts: '', qt_bcls: '구축', qt_mcls: '기본' },
      },
    ];
  };
  const opened = await vault();
  try {
    const catalog = new CatalogService('demo', path.join(opened.root, 'catalog.json'));
    const codes = await catalog.list('codes');
    const products = await catalog.list('products');
    assert.equal(codes.length, 1);
    assert.equal(codes[0]?.imported, true);
    assert.equal(codes[0]?.name, 'Cloud');
    assert.equal(products[0]?.name, '설치');
    assert.ok(calls >= 2);
    await catalog.close();
  } finally {
    LegacyReader.prototype.read = original;
    await rm(opened.root, { recursive: true, force: true });
  }
});
