import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLegacyVault, type LegacyVault } from '../server/legacy-vault.ts';
import {
  canonical,
  createMaterializer,
  filesFingerprint,
  materializationFingerprint,
  materializeInstallations,
  parseMaterializationArguments,
  type MaterializationArguments,
  type PreparedInstallation,
} from '../scripts/materialize-installations.ts';
import { encryptBusinessRow } from '../server/business-encryption.ts';
import type { BackupFile } from '../server/backup-files.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const actor = '11111111-1111-4111-8111-111111111111';
const context = (id: string, revision: number) => ({
  source: 'yeta-crm-workspace:v1',
  table: 'installation_workspace',
  primaryKey: id,
  batchId: String(revision),
});
type Row = Record<string, any>;
const tables = [
  'yeta_crm.companies',
  'yeta_crm.records',
  'yeta_crm.auth_users',
  'yeta_crm.auth_sessions',
  'yeta_crm_private.installation_workspace',
  'yeta_crm_private.installation_workspace_audit',
  'yeta_crm_private.legacy_archive',
  'yeta_crm_private.legacy_items',
  'yeta_crm_private.legacy_runs',
].sort();

/** Synthetic SQL model: exercises the real v1/v2 service, encrypted vault, and CLI transaction logic. */
class Fixture {
  queries: { sql: string; parameters: unknown[] }[] = [];
  rows: Record<string, Row[]>;
  before?: Record<string, Row[]>;
  nextAuditId = 100;
  committed = false;
  rolledBack = false;
  failCas = false;
  alterCompany = false;
  alterAudit = false;
  failCommit = false;
  failRollback = false;
  readOnly = false;
  constructor(vault: LegacyVault) {
    const id = 'installation-a';
    const currentRowId = `row-${hash(JSON.stringify([id, 'current', id, '현재 설치 정보'])).slice(0, 32)}`;
    const overlay = {
      version: 1,
      added: [
        {
          id: 'workspace-row-22222222-2222-4222-8222-222222222222',
          sectionId: 'access',
          title: '추가 접근',
          fields: [
            { key: 'access_pwd', label: '비밀번호', value: 'fixture-sensitive-value' },
            { key: 'empty', label: '빈 값', value: '' },
          ],
        },
      ],
      deleted: [],
      patches: { [currentRowId]: { values: { engineer: '수정 엔지니어' }, removeFields: [], addFields: [] } },
    };
    this.rows = Object.fromEntries(tables.map((table) => [table, []]));
    this.rows['yeta_crm.records'] = [id, 'installation-b'].map((value) => ({
      id: value,
      kind: 'installations',
      company_id: 'company-old',
      title: '설치',
      data: {
        systemCode: 'YETA',
        serviceVersion: 'Cloud',
        version: '2026',
        installedAt: '',
        patchedAt: '',
        engineer: '기존 엔지니어',
        accessType: '알 수 없음',
        autoUpdate: false,
        domain: '',
        note: '이관 비고 유지',
        legacySource: { preserved: true },
        other: 'preserved',
      },
      archived_at: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    }));
    this.rows['yeta_crm.records'].push(
      { id: 'archived', kind: 'installations', data: { note: 'archived' }, archived_at: '2026-01-02' },
      { id: 'installation-a', kind: 'contacts', data: { phone: 'preserved' }, archived_at: null },
    );
    this.rows['yeta_crm.companies'] = [{ id: 'company-old', name: '보존 회사' }];
    this.rows['yeta_crm.auth_users'] = [
      { id: actor, role: 'admin', status: 'active', password_hash: 'fixture-hash-must-not-be-returned' },
    ];
    this.rows['yeta_crm.auth_sessions'] = [
      { token_hash: 'fixture-token-must-not-be-returned', user_id: actor },
    ];
    this.rows['yeta_crm_private.legacy_archive'] = [{ id: 'archive', envelope: 'untouched-ciphertext' }];
    this.rows['yeta_crm_private.installation_workspace'] = [
      {
        installation_id: id,
        revision: 1,
        envelope: vault.encrypt(JSON.stringify(overlay), context(id, 1)),
        updated_by: actor,
        updated_at: '2026-01-01',
      },
      { installation_id: 'archived', revision: 4, envelope: 'untouched', updated_by: actor },
    ];
    this.rows['yeta_crm_private.installation_workspace_audit'] = [
      { id: '1', installation_ref_hash: hash(id), actor_user_id: actor, action: 'row-update', revision: 1 },
    ];
  }
  get client() {
    return this as unknown as Parameters<typeof materializeInstallations>[0];
  }
  get writes() {
    return this.queries.filter((query) => /^(INSERT|UPDATE|DELETE|ALTER|CREATE)/.test(query.sql));
  }
  async query(sql: string, parameters: unknown[] = []) {
    this.queries.push({ sql, parameters });
    const result = (rows: Row[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount });
    const values = parameters as any[];
    if (sql.startsWith('BEGIN')) {
      this.before = structuredClone(this.rows);
      this.readOnly = sql.includes('READ ONLY');
      return result();
    }
    if (sql === 'ROLLBACK') {
      if (this.failRollback) throw new Error('fixture-disconnect');
      this.rows = this.before!;
      this.rolledBack = true;
      return result();
    }
    if (sql === 'COMMIT') {
      if (this.failCommit) throw new Error('fixture-disconnect');
      this.committed = true;
      return result();
    }
    if (/^(SET|LOCK)/.test(sql) || sql.includes('pg_advisory_xact_lock')) return result();
    if (sql.includes('current_database()')) return result([{ name: 'yeta_crm' }]);
    if (sql.includes('FROM pg_class')) return result(tables.map((name) => ({ name })));
    if (sql.startsWith('SELECT id FROM yeta_crm.auth_users')) {
      // auth_users.id is text in the real schema, unlike workspace actor UUID columns.
      assert.doesNotMatch(sql, /id=\$1::uuid/);
      return result(
        this.rows['yeta_crm.auth_users']
          .filter(
            (row) =>
              row.role === 'admin' && row.status === 'active' && (!values.length || row.id === values[0]),
          )
          .map((row) => ({ id: row.id })),
      );
    }
    if (sql.startsWith('SELECT id FROM yeta_crm.records'))
      return result(
        this.rows['yeta_crm.records']
          .filter((row) => row.kind === 'installations' && row.archived_at === null)
          .map((row) => ({ id: row.id }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    if (sql.startsWith('SELECT count(*)::text AS count')) {
      const match = sql.match(/FROM "(\w+)"\."(\w+)" t/)!;
      const table = `${match[1]}.${match[2]}`;
      let rows = structuredClone(this.rows[table]);
      if (table === 'yeta_crm.records' && values.length) {
        const mapping = JSON.parse(values[0]);
        rows = rows.map((row) => {
          if (row.kind !== 'installations' || !Object.hasOwn(mapping, row.id)) return row;
          delete row.updated_at;
          delete row.protected_data;
          for (const key of mapping[row.id]) delete row.data[key];
          return row;
        });
      } else if (table.endsWith('.installation_workspace') && values.length)
        rows = rows.filter((row) => !values[0].includes(row.installation_id));
      else if (table.endsWith('.installation_workspace_audit') && values.length)
        rows = rows.filter((row) => !values[0].includes(String(row.id)));
      return result([
        {
          count: String(rows.length),
          digest: hash(
            rows
              .map((row) => hash(canonical(row)))
              .sort()
              .join(''),
          ),
        },
      ]);
    }
    if (sql.startsWith('SELECT id,data,to_jsonb(records)'))
      return result(
        this.rows['yeta_crm.records']
          .filter(
            (row) =>
              row.kind === 'installations' &&
              row.archived_at === null &&
              (sql.includes('id=ANY')
                ? values[0].includes(row.id)
                : sql.includes('id=$1')
                  ? row.id === values[0]
                  : true),
          )
          .map((row) => ({ id: row.id, data: row.data, protected_data: row.protected_data })),
      );
    if (sql.startsWith('SELECT data FROM yeta_crm.records'))
      return result(
        this.rows['yeta_crm.records']
          .filter((row) => row.kind === 'installations' && row.id === values[0] && row.archived_at === null)
          .map((row) => ({ data: row.data })),
      );
    if (sql.startsWith('SELECT i.source_key') || sql.startsWith('SELECT i.target_id')) return result();
    if (sql.startsWith('SELECT source_table,source_key,envelope'))
      throw new Error('ORIGINAL_ARCHIVE_MUST_NOT_BE_READ_FOR_NATIVE_FIXTURES');
    if (sql.startsWith('SELECT installation_id,revision,envelope'))
      return result(
        this.rows['yeta_crm_private.installation_workspace']
          .filter((row) => values[0].includes(row.installation_id))
          .map((row) => ({
            installation_id: row.installation_id,
            revision: row.revision,
            envelope: row.envelope,
            ...(sql.includes('updated_by') ? { updated_by: row.updated_by } : {}),
          })),
      );
    if (sql.startsWith('SELECT revision,envelope'))
      return result(
        this.rows['yeta_crm_private.installation_workspace']
          .filter((row) => row.installation_id === values[0])
          .map((row) => ({
            revision: row.revision,
            envelope: row.envelope,
            ...(sql.includes('updated_by') ? { updated_by: row.updated_by } : {}),
          })),
      );
    if (sql.startsWith('SELECT data @>'))
      return result(
        this.rows['yeta_crm.records']
          .filter((row) => row.kind === 'installations' && row.id === values[0] && row.archived_at === null)
          .map((row) => ({
            matches: Object.entries(JSON.parse(values[1])).every(
              ([key, value]) => canonical(row.data[key]) === canonical(value),
            ),
          })),
      );
    if (sql.startsWith('SELECT installation_ref_hash'))
      return result(
        this.rows['yeta_crm_private.installation_workspace_audit']
          .filter((row) => values[0].includes(row.id))
          .map(({ id: _id, ...row }) => row)
          .sort(
            (a, b) =>
              a.installation_ref_hash.localeCompare(b.installation_ref_hash) || a.revision - b.revision,
          ),
      );
    if (this.readOnly) throw new Error('READONLY_WRITE_ATTEMPT');
    if (
      sql.startsWith('INSERT INTO yeta_crm_private.installation_workspace(') ||
      sql.startsWith('UPDATE yeta_crm_private.installation_workspace SET')
    ) {
      if (this.failCas) return result([], 0);
      const rows = this.rows['yeta_crm_private.installation_workspace'],
        existing = rows.find((row) => row.installation_id === values[0]);
      if (sql.startsWith('UPDATE') && (!existing || existing.revision !== values[4])) return result([], 0);
      if (sql.startsWith('INSERT') && existing) return result([], 0);
      const next = {
        installation_id: values[0],
        revision: values[1],
        envelope: values[2],
        updated_by: values[3],
        updated_at: '2026-09-10',
      };
      if (existing) Object.assign(existing, next);
      else rows.push(next);
      if (this.alterCompany) this.rows['yeta_crm.companies'][0].name = 'unexpected trigger change';
      return result([{ installation_id: values[0] }]);
    }
    if (sql.startsWith('UPDATE yeta_crm.records SET data=$2::jsonb,protected_data=')) {
      const row = this.rows['yeta_crm.records'].find(row => row.kind === 'installations' && row.id === values[0] && row.archived_at === null);
      if (!row) return result([], 0);
      row.data = JSON.parse(values[1]);
      row.protected_data = JSON.parse(values[2]);
      row.updated_at = '2026-09-10';
      return result([{ id: values[0] }]);
    }
    if (sql.startsWith('UPDATE yeta_crm.records SET data=data||')) {
      const row = this.rows['yeta_crm.records'].find(
        (row) => row.kind === 'installations' && row.id === values[0] && row.archived_at === null,
      );
      if (!row) return result([], 0);
      row.data = { ...row.data, ...JSON.parse(values[1]) };
      row.updated_at = '2026-09-10';
      return result([{ id: values[0] }]);
    }
    if (sql.startsWith('INSERT INTO yeta_crm_private.installation_workspace_audit')) {
      const id = String(this.nextAuditId++);
      this.rows['yeta_crm_private.installation_workspace_audit'].push({
        id,
        installation_ref_hash: values[0],
        actor_user_id: values[1],
        action: this.alterAudit ? 'row-update' : 'materialize',
        revision: values[2],
      });
      return result([{ id }]);
    }
    throw new Error(`UNEXPECTED_FIXTURE_SQL: ${sql}`);
  }
}

class FilesFixture {
  captures = 0;
  locks = 0;
  releases = 0;
  changeOnCapture = Infinity;
  events: string[] = [];
  async lock() {
    this.locks++;
    this.events.push('lock');
    return async () => {
      this.releases++;
      this.events.push('release');
    };
  }
  async capture(): Promise<BackupFile[]> {
    this.captures++;
    return [
      {
        root: 'migration',
        name: 'source-schema.json',
        base64: '',
        sha256: hash(this.captures >= this.changeOnCapture ? 'changed' : 'unchanged'),
      },
    ];
  }
}
async function fixture(run: (db: Fixture, vault: LegacyVault) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'installation-materialization-test-'));
  try {
    const vault = await openLegacyVault({
      keyFile: path.join(directory, 'private', 'key'),
      createIfMissing: true,
    });
    await run(new Fixture(vault), vault);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const planOptions: MaterializationArguments = { apply: false, expectedCount: 2 };
// The core's source-conflict rules have their own tests. This adapter models a
// canonical preparation that accepts one typed metadata change, exercising the
// CLI's deliberately narrow SQL merge and all surrounding preservation checks.
const metadataFixtureMaterializer: NonNullable<Parameters<typeof materializeInstallations>[4]> = (
  client,
  vault,
) => {
  const service = createMaterializer(client, vault);
  return {
    async prepareMaterialization(id) {
      const item = await service.prepareMaterialization(id);
      if (id === 'installation-a' && !item.alreadyMaterialized) {
        item.metadataPatch = { engineer: '수정 엔지니어' };
        const state = JSON.parse(vault.decrypt(item.envelope!, context(id, item.nextRevision)));
        const field = state.sections
          .flatMap((section: Row) => section.rows)
          .find((row: Row) => row.managed === 'metadata')
          .fields.find((field: Row) => field.key === 'engineer');
        field.value = '수정 엔지니어';
        field.displayValue = '수정 엔지니어';
        item.envelope = vault.encrypt(JSON.stringify(state), context(id, item.nextRevision));
      }
      return item;
    },
  };
};

test('arguments default to a 259-row read-only plan and reject ambiguous apply arguments', () => {
  assert.deepEqual(parseMaterializationArguments([]), { apply: false, expectedCount: 259 });
  assert.deepEqual(
    parseMaterializationArguments([
      '--apply',
      '--expected-fingerprint',
      'a'.repeat(64),
      '--actor-id',
      actor,
      '--expected-count',
      '2',
    ]),
    { apply: true, expectedCount: 2, expectedFingerprint: 'a'.repeat(64), actorId: actor },
  );
  for (const args of [
    ['--apply'],
    ['--apply', '--apply'],
    ['--actor-id', 'secret'],
    ['--expected-count', '-1'],
    ['--unknown'],
    ['--expected-fingerprint', 'password'],
  ])
    assert.throws(() => parseMaterializationArguments(args), /INSTALLATION_MATERIALIZATION_/);
});

function retiredGate(db: Fixture, before: Record<string, Row[]>, files?: FilesFixture) {
  assert.equal(db.queries.length, 0);
  assert.equal(db.writes.length, 0);
  assert.equal(db.committed, false);
  assert.equal(db.rolledBack, false);
  assert.deepEqual(db.rows, before);
  if (!files) return;
  assert.equal(files.locks, 0);
  assert.equal(files.captures, 0);
  assert.equal(files.releases, 0);
  assert.deepEqual(files.events, []);
}

test('plan uses real v1 preparation but no SQL writes, file lock, revision or audit changes', async () =>
  fixture(async (db, vault) => {
    const before = structuredClone(db.rows);
    const files = new FilesFixture();
    await assert.rejects(
      () => materializeInstallations(db.client, vault, files, planOptions),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    retiredGate(db, before, files);
  }));

test('apply saves encrypted v2, preserves explicit empty/custom values, merges only metadata and verifies archive-independent reads', async () =>
  fixture(async (db, vault) => {
    const before = structuredClone(db.rows);
    assert.throws(() => metadataFixtureMaterializer(db.client, vault), /INSTALLATION_MATERIALIZATION_RETIRED/);
    assert.throws(() => createMaterializer(db.client, vault), /INSTALLATION_MATERIALIZATION_RETIRED/);
    const files = new FilesFixture();
    await assert.rejects(
      () =>
        materializeInstallations(
          db.client,
          vault,
          files,
          { ...planOptions, apply: true, expectedFingerprint: 'ab'.repeat(32) },
          metadataFixtureMaterializer,
        ),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    retiredGate(db, before, files);
  }));

test('second plan/apply is idempotent and does not call original details or increment revisions and audit', async () =>
  fixture(async (db, vault) => {
    const before = structuredClone(db.rows);
    const planned = new FilesFixture();
    const applied = new FilesFixture();
    await assert.rejects(
      () => materializeInstallations(db.client, vault, planned, planOptions),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    await assert.rejects(
      () =>
        materializeInstallations(db.client, vault, applied, {
          ...planOptions,
          apply: true,
          expectedFingerprint: 'ab'.repeat(32),
        }),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    retiredGate(db, before, planned);
    retiredGate(db, before, applied);
  }));

test('stale plan, target count, and ambiguous or disabled actors fail before first write', async () =>
  fixture(async (db, vault) => {
    db.rows['yeta_crm.records'][0].data.note = 'concurrent edit';
    const before = structuredClone(db.rows);
    const files = new FilesFixture();
    await assert.rejects(
      () =>
        materializeInstallations(db.client, vault, files, {
          ...planOptions,
          apply: true,
          expectedFingerprint: 'ab'.repeat(32),
        }),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    await assert.rejects(
      () => materializeInstallations(db.client, vault, files, { ...planOptions, expectedCount: 259 }),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    retiredGate(db, before, files);
    db.rows['yeta_crm.auth_users'].push({
      id: '33333333-3333-4333-8333-333333333333',
      role: 'admin',
      status: 'active',
    });
    const withExtraAdmin = structuredClone(db.rows);
    const again = new FilesFixture();
    await assert.rejects(
      () => materializeInstallations(db.client, vault, again, planOptions),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    await assert.rejects(
      () => materializeInstallations(db.client, vault, again, { ...planOptions, actorId: actor }),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    db.rows['yeta_crm.auth_users'][0].status = 'disabled';
    const disabled = structuredClone(db.rows);
    await assert.rejects(
      () => materializeInstallations(db.client, vault, again, { ...planOptions, actorId: actor }),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    assert.equal(db.queries.length, 0);
    assert.equal(db.writes.length, 0);
    assert.deepEqual(db.rows, disabled);
    assert.deepEqual(
      db.rows['yeta_crm_private.installation_workspace'],
      withExtraAdmin['yeta_crm_private.installation_workspace'],
    );
    retiredGate(db, disabled, again);
  }));

test('CAS failure, protected-row drift, and incorrect audit actions roll back the whole change', async () => {
  for (const flag of ['failCas', 'alterCompany', 'alterAudit'] as const)
    await fixture(async (db, vault) => {
      const files = new FilesFixture();
      db[flag] = true;
      const before = structuredClone(db.rows);
      await assert.rejects(
        () =>
          materializeInstallations(db.client, vault, files, {
            ...planOptions,
            apply: true,
            expectedFingerprint: 'ab'.repeat(32),
          }),
        /INSTALLATION_MATERIALIZATION_RETIRED/,
      );
      retiredGate(db, before, files);
    });
});

test('file changes during preparation or after writes abort and preserve database rows', async () =>
  fixture(async (db, vault) => {
    const before = structuredClone(db.rows);
    for (const capture of [2, 3]) {
      const files = new FilesFixture();
      files.changeOnCapture = capture;
      await assert.rejects(
        () =>
          materializeInstallations(db.client, vault, files, {
            ...planOptions,
            apply: true,
            expectedFingerprint: 'ab'.repeat(32),
          }),
        /INSTALLATION_MATERIALIZATION_RETIRED/,
      );
      retiredGate(db, before, files);
    }
  }));

test('invalid prepared envelope, counts, and forbidden metadata keys never reach a write', async () =>
  fixture(async (db, vault) => {
    const before = structuredClone(db.rows);
    for (const change of [
      (item: PreparedInstallation) => {
        item.fieldCount++;
      },
      (item: PreparedInstallation) => {
        item.metadataPatch = { companyId: 'forbidden' };
      },
      (item: PreparedInstallation) => {
        item.envelope!.tag = 'A'.repeat(24);
      },
    ]) {
      const factory: Parameters<typeof materializeInstallations>[4] = (client, key) => {
        const service = createMaterializer(client, key);
        return {
          async prepareMaterialization(id) {
            const item = await service.prepareMaterialization(id);
            change(item);
            return item;
          },
        };
      };
      const files = new FilesFixture();
      assert.throws(() => createMaterializer(db.client, vault), /INSTALLATION_MATERIALIZATION_RETIRED/);
      await assert.rejects(
        () => materializeInstallations(db.client, vault, files, planOptions, factory),
        /INSTALLATION_MATERIALIZATION_RETIRED/,
      );
      retiredGate(db, before, files);
    }
  }));

test('COMMIT uncertainty closes the connection before releasing locks and never claims rollback', async () =>
  fixture(async (db, vault) => {
    const before = structuredClone(db.rows);
    const files = new FilesFixture();
    const closed: string[] = [];
    db.failCommit = true;
    await assert.rejects(
      () =>
        materializeInstallations(
          db.client,
          vault,
          files,
          { ...planOptions, apply: true, expectedFingerprint: 'ab'.repeat(32) },
          createMaterializer,
          async () => {
            closed.push('connection-closed');
          },
        ),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    assert.deepEqual(closed, []);
    retiredGate(db, before, files);
  }));

test('failed connection teardown retains locks and rollback uncertainty is reported separately', async () =>
  fixture(async (db, vault) => {
    const before = structuredClone(db.rows);
    const files = new FilesFixture();
    db.failCommit = true;
    await assert.rejects(
      () =>
        materializeInstallations(
          db.client,
          vault,
          files,
          { ...planOptions, apply: true, expectedFingerprint: 'ab'.repeat(32) },
          createMaterializer,
          async () => {
            throw new Error('fixture-close-failed');
          },
        ),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    retiredGate(db, before, files);
  }));

test('rollback uncertainty closes the connection before releasing locks', async () =>
  fixture(async (db, vault) => {
    const before = structuredClone(db.rows);
    const files = new FilesFixture();
    const closed: string[] = [];
    db.failCas = true;
    db.failRollback = true;
    await assert.rejects(
      () =>
        materializeInstallations(
          db.client,
          vault,
          files,
          { ...planOptions, apply: true, expectedFingerprint: 'ab'.repeat(32) },
          createMaterializer,
          async () => {
            closed.push('connection-closed');
          },
        ),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    assert.deepEqual(closed, []);
    retiredGate(db, before, files);
  }));

test('plan fingerprints ignore randomized encryption and backup-control rows while tracking source, metadata and file bytes', () => {
  const item = {
    id: 'a',
    expectedRevision: 0,
    fingerprint: 'b'.repeat(64),
    metadataPatch: {},
    envelope: { nonce: 'first' },
  } as PreparedInstallation;
  const inputs = [{ table: 'yeta_crm.records', count: '1', digest: 'a'.repeat(64) }];
  const first = materializationFingerprint([item], inputs, 'files');
  const differentNonce = { ...item, envelope: { nonce: 'second' } } as PreparedInstallation;
  assert.equal(
    first,
    materializationFingerprint(
      [differentNonce],
      [...inputs, { table: 'yeta_crm_private.backup_history', count: '9', digest: 'c'.repeat(64) }],
      'files',
    ),
  );
  assert.notEqual(first, materializationFingerprint([item], inputs, 'changed-files'));
  assert.notEqual(
    first,
    materializationFingerprint([{ ...item, metadataPatch: { note: 'changed' } }], inputs, 'files'),
  );
  assert.notEqual(
    filesFingerprint([{ root: 'migration', name: 'schema', base64: '', sha256: 'a' }]),
    filesFingerprint([{ root: 'migration', name: 'schema', base64: '', sha256: 'b' }]),
  );
});

test('encrypted installation metadata survives materialization and only the requested field changes', async () =>
  fixture(async (db, vault) => {
    db.rows['yeta_crm.records'] = db.rows['yeta_crm.records'].map((row) =>
      encryptBusinessRow(vault, 'records', row),
    );
    const before = structuredClone(db.rows);
    const files = new FilesFixture();
    assert.throws(() => metadataFixtureMaterializer(db.client, vault), /INSTALLATION_MATERIALIZATION_RETIRED/);
    await assert.rejects(
      () => materializeInstallations(db.client, vault, files, planOptions, metadataFixtureMaterializer),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    await assert.rejects(
      () =>
        materializeInstallations(
          db.client,
          vault,
          files,
          { ...planOptions, apply: true, expectedFingerprint: 'ab'.repeat(32) },
          metadataFixtureMaterializer,
        ),
      /INSTALLATION_MATERIALIZATION_RETIRED/,
    );
    retiredGate(db, before, files);
  }));
