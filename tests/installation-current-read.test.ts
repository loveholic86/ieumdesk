import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CatalogService } from '../server/catalog.ts';
import { InstallationDetailsService } from '../server/installation-details.ts';
import { managedField, type ManagedInstallationState } from '../server/installation-managed.ts';
import {
  InstallationWorkspaceService,
  MemoryInstallationWorkspaceRepository,
} from '../server/installation-workspace.ts';
import { LegacyReader } from '../server/legacy-reader.ts';
import { openLegacyVault, type LegacyVault } from '../server/legacy-vault.ts';
import { createMaterializer } from '../scripts/materialize-installations.ts';

const sections: [ManagedInstallationState['sections'][number]['id'], string][] = [
  ['installation', '설치 정보'],
  ['access', '접근 정보'],
  ['server', '서버 정보'],
  ['yeta', 'YETA 로그인 정보'],
  ['sap', 'SAP 정보'],
  ['settings', '별도 설정 정보'],
  ['files', '설정 파일'],
];

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

function workspace(stored: LegacyVault, id: string, reads: { count: number }, read: () => Promise<Record<string, unknown>>) {
  const repository = new MemoryInstallationWorkspaceRepository();
  let saves = 0;
  const service = new InstallationWorkspaceService(
    {
      async details() {
        reads.count += 1;
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async secrets() {
        reads.count += 1;
        throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
      },
      async audit() {
        reads.count += 1;
        throw new Error('INSTALLATION_MATERIALIZATION_PREPARATION_WRITE_FORBIDDEN');
      },
    },
    {
      get: (key) => repository.get(key),
      async save() {
        saves += 1;
        throw new Error('INSTALLATION_MATERIALIZATION_PREPARATION_WRITE_FORBIDDEN');
      },
    },
    { vault: async () => stored, metadata: { read, async update() {} } },
  );
  const envelope = stored.encrypt(JSON.stringify(accessState()), {
    source: 'yeta-crm-workspace:v1',
    table: 'installation_workspace',
    primaryKey: id,
    batchId: '1',
  });
  repository.records.set(id, { revision: 1, envelope });
  return { service, saves: () => saves };
}

test('stored access rows stay grouped when original reads throw', async () => {
  const opened = await vault();
  try {
    const reads = { count: 0 };
    const { service, saves } = workspace(opened.vault, 'inst-current', reads, async () => {
      throw new Error('archive deliberately unavailable after materialization');
    });
    const details = await service.details('inst-current', { protected: false, raw: true });
    const rows = details.sections.find((section) => section.id === 'access')!.rows;
    assert.equal(details.sections.length, 7);
    assert.equal(rows.length, 3);
    assert.match(rows[0].origin?.group ?? '', /^[a-f0-9]{64}$/);
    assert.equal(new Set(rows.map((row) => row.origin?.group)).size, 1);
    assert.deepEqual(
      rows.map((row) => row.origin?.part),
      ['address', 'vpn', 'access'],
    );
    const prepared = await service.prepareMaterialization('inst-current');
    assert.equal(prepared.alreadyMaterialized, true);
    assert.equal(prepared.envelope, undefined);
    assert.equal(saves(), 0);
    assert.equal(reads.count, 0);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('detail opens from the current record when no original and no workspace exist', async () => {
  const opened = await vault();
  try {
    const repository = new MemoryInstallationWorkspaceRepository();
    const service = new InstallationWorkspaceService(
      {
        async details() {
          throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
        },
        async secrets() {
          throw new Error('UNEXPECTED_SOURCE_READ');
        },
        async audit() {
          throw new Error('INSTALLATION_MATERIALIZATION_PREPARATION_WRITE_FORBIDDEN');
        },
      },
      repository,
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
    const details = await service.details('missing-original');
    assert.deepEqual(
      details.sections.map((section) => section.id),
      sections.map(([id]) => id),
    );
    assert.equal(details.metadataRevision, undefined);
    const readable = new InstallationWorkspaceService(
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
      {
        vault: async () => opened.vault,
        metadata: { async read() { return { systemCode: 'DEMO-CURRENT' }; }, async update() {} },
      },
    );
    const current = await readable.details('missing-original');
    assert.equal(current.sections.length, 7);
    assert.match(current.metadataRevision ?? '', /^[a-f0-9]{64}$/);
    const code = current.sections[0].rows[0]?.fields.find((field) => field.key === 'systemCode');
    assert.equal(code?.value, 'DEMO-CURRENT');
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('installation details and catalog do not read archive or source', async () => {
  let archives = 0;
  const details = new InstallationDetailsService({
    async installation(id) {
      return { id, data: { systemCode: 'DEMO-CURRENT', note: 'current table' } };
    },
    async archives() {
      archives += 1;
      throw new Error('archive deliberately unavailable after materialization');
    },
    async audit() {
      throw new Error('INSTALLATION_MATERIALIZATION_PREPARATION_WRITE_FORBIDDEN');
    },
  });
  const rendered = await details.details('demo-current');
  assert.equal(archives, 0);
  assert.equal(rendered.sections.length, 7);
  assert.equal(rendered.sections[0].rows[0]?.fields.find((field) => field.key === 'systemCode')?.value, 'DEMO-CURRENT');

  const originalRead = LegacyReader.prototype.read;
  let sourceReads = 0;
  LegacyReader.prototype.read = async function () {
    sourceReads += 1;
    throw new Error('UNEXPECTED_SOURCE_READ');
  };
  const opened = await vault();
  try {
    const catalog = new CatalogService('demo', path.join(opened.root, 'catalog.json'));
    assert.deepEqual(await catalog.list('codes'), []);
    assert.deepEqual(await catalog.list('products'), []);
    await catalog.close();
    assert.equal(sourceReads, 0);
  } finally {
    LegacyReader.prototype.read = originalRead;
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('materializer preparation reads the current record and workspace only', async () => {
  const opened = await vault();
  const id = 'inst-materialized';
  const envelope = opened.vault.encrypt(JSON.stringify(accessState()), {
    source: 'yeta-crm-workspace:v1',
    table: 'installation_workspace',
    primaryKey: id,
    batchId: '1',
  });
  const queries: string[] = [];
  try {
    const service = createMaterializer(
      {
        async query(sql: string) {
          queries.push(sql);
          if (/legacy_(archive|items|runs)/.test(sql)) throw new Error('UNEXPECTED_SOURCE_READ');
          if (sql.includes('yeta_crm.records'))
            return { rows: [{ id, data: { systemCode: 'DEMO-CURRENT' }, protected_data: null }] };
          if (sql.includes('installation_workspace'))
            return { rows: [{ installation_id: id, revision: 1, envelope }] };
          throw new Error('UNEXPECTED_SOURCE_READ');
        },
      },
      opened.vault,
      undefined,
      true,
    );
    const details = await service.details(id, { protected: false, raw: true });
    assert.equal(new Set(details.sections.find((section) => section.id === 'access')!.rows.map((row) => row.origin?.group)).size, 1);
    const prepared = await service.prepareMaterialization(id);
    assert.equal(prepared.alreadyMaterialized, true);
    assert.equal(queries.some((sql) => /legacy_(archive|items|runs)/.test(sql)), false);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});
