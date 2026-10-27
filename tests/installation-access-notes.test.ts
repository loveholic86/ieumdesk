import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiError } from '../server/errors.ts';
import { openLegacyVault, type LegacyVault } from '../server/legacy-vault.ts';
import {
  InstallationWorkspaceService,
  MemoryInstallationWorkspaceRepository,
  protectInstallationDetails,
  type InstallationWorkspaceAction,
  type InstallationWorkspaceRepository,
} from '../server/installation-workspace.ts';
import {
  managedInstallationSchema,
  managedField,
  metadataRow,
  managedMetadataRowId,
  type ManagedInstallationState,
} from '../server/installation-managed.ts';
import { installationMetadataPatch } from '../server/installation-metadata.ts';
import { createMaterializer } from '../scripts/materialize-installations.ts';
import { snapshotFingerprint, validateSnapshot, type BackupSnapshot } from '../server/backup-snapshot.ts';
import type { InstallationDetailsAccess } from '../server/installation-details.ts';
import type { InstallationSectionId } from '../src/installation-types.ts';

const actor = '11111111-1111-4111-8111-111111111111';
const installationId = 'synthetic-installation';
const firstTime = '2026-09-10T03:04:05.006Z';
const sections: InstallationSectionId[] = [
  'installation',
  'access',
  'server',
  'yeta',
  'sap',
  'settings',
  'files',
];
const context = (id = installationId, revision = 1) => ({
  source: 'yeta-crm-workspace:v1',
  table: 'installation_workspace',
  primaryKey: id,
  batchId: String(revision),
});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Note = NonNullable<ManagedInstallationState['accessNotes']>[number];
const note = (content = '합성 참고사항'): Note => ({ id: randomUUID(), content, createdAt: firstTime });

async function fixture(t: { after: (action: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'installation-access-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = await openLegacyVault({
    keyFile: path.join(directory, 'keys', 'fixture.key'),
    createIfMissing: true,
  });
  const records = new MemoryInstallationWorkspaceRepository();
  const audits: {
    installationHash: string;
    actor: string;
    action: InstallationWorkspaceAction;
    revision: number;
  }[] = [];
  const repository: InstallationWorkspaceRepository = {
    get: (id) => records.get(id),
    async save(id, expected, envelope, user, action) {
      const revision = await records.save(id, expected, envelope);
      audits.push({ installationHash: sha(id), actor: user, action, revision });
      return revision;
    },
  };
  const data: Record<string, unknown> = {
    systemCode: 'FIXTURE',
    serviceVersion: 'Cloud',
    installedAt: '2026-09-10',
    engineer: '기존 엔지니어',
    accessType: 'VPN',
    autoUpdate: true,
    note: '기존 설치 비고',
    legacySource: { fixtureOnly: true },
  };
  const initial: ManagedInstallationState = {
    version: 2,
    sections: sections.map((id) => ({
      id,
      title: id,
      rows:
        id === 'installation'
          ? [metadataRow(installationId, data)]
          : id === 'access'
            ? [
                {
                  id: 'access-row',
                  title: '접근 정보',
                  fields: [
                    managedField(
                      'access',
                      'access-row',
                      'os_login_etc',
                      'OS 로그인 비고',
                      '보존할 OS 로그인 비고',
                    ),
                    managedField(
                      'access',
                      'access-row',
                      'access_etc',
                      '접근 비고',
                      '별도로 보존할 긴 접근 비고\n다음 줄',
                    ),
                    managedField(
                      'access',
                      'access-row',
                      'access_pwd',
                      '접근 비밀번호',
                      'synthetic-existing-password',
                    ),
                  ],
                },
              ]
            : [],
    })),
  };
  const seed = (state: unknown, revision = 1, id = installationId) =>
    records.records.set(id, {
      revision,
      envelope: vault.encrypt(JSON.stringify(state), context(id, revision)),
    });
  seed(initial);
  let time = Date.parse(firstTime),
    exists = true;
  const base: InstallationDetailsAccess = {
    async details() {
      throw new Error('ORIGINAL_DETAILS_MUST_NOT_BE_READ');
    },
    async secrets() {
      throw new Error('RETIRED');
    },
    async audit() {
      throw new Error('NO_ORIGINAL_AUDIT');
    },
  };
  const metadata = {
    async read(id: string) {
      if (!exists || ![installationId, 'other-installation'].includes(id))
        throw new ApiError(404, 'NOT_FOUND', 'Missing synthetic installation');
      return structuredClone(data);
    },
    async update(_id: string, values: Record<string, string>) {
      Object.assign(data, installationMetadataPatch(values));
    },
  };
  const service = new InstallationWorkspaceService(base, repository, {
    vault: async () => vault,
    metadata,
    now: () => time,
  });
  const state = (id = installationId) => {
    const stored = records.records.get(id)!;
    return managedInstallationSchema.parse(
      JSON.parse(vault.decrypt(stored.envelope, context(id, stored.revision))),
    );
  };
  return {
    service,
    vault,
    records,
    audits,
    initial,
    data,
    seed,
    state,
    time: (value: string) => {
      time = Date.parse(value);
    },
    exists: (value: boolean) => {
      exists = value;
    },
  };
}

test('existing v2 without notes returns an empty list without rewriting ciphertext or materialization', async (t) => {
  const f = await fixture(t),
    before = structuredClone(f.records.records.get(installationId));
  assert.equal(Object.hasOwn(f.state(), 'accessNotes'), false);
  assert.deepEqual((await f.service.details(installationId)).accessNotes, []);
  const prepared = await f.service.prepareMaterialization(installationId);
  assert.equal(prepared.alreadyMaterialized, true);
  assert.equal(prepared.envelope, undefined);
  assert.equal(prepared.nextRevision, 1);
  assert.deepEqual(f.records.records.get(installationId), before);
  assert.equal(f.audits.length, 0);
});

test('create preserves raw text, creates server UTC dates, masks all content and stores only ciphertext plus audit metadata', async (t) => {
  const f = await fixture(t),
    content = '  첫 참고사항\n두 번째 줄 😀  ';
  await f.service.createAccessNote(installationId, { revision: 1, content }, actor);
  const raw = await f.service.details(installationId, { protected: false, raw: true }),
    created = raw.accessNotes![0];
  assert.match(created.id, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  assert.equal(created.content, content);
  assert.equal(created.createdAt, firstTime);
  assert.equal(created.updatedAt, undefined);
  assert.equal(created.masked, false);
  assert.equal(raw.revision, 2);
  const protectedDetails = await f.service.details(installationId);
  assert.deepEqual(protectedDetails.accessNotes, [{ ...created, content: '••••••••', masked: true }]);
  assert.deepEqual(protectInstallationDetails(raw).accessNotes, protectedDetails.accessNotes);
  assert.equal(raw.accessNotes![0].content, content);
  assert.deepEqual(f.state().sections, f.initial.sections);
  assert.ok(!JSON.stringify([...f.records.records.values()]).includes(content));
  assert.ok(!JSON.stringify(f.audits).includes(content));
  assert.deepEqual(f.audits, [
    { installationHash: sha(installationId), actor, action: 'note-create', revision: 2 },
  ]);
  f.time('2026-09-10T04:00:00.000Z');
  await f.service.createAccessNote(installationId, { revision: 2, content: '별도 댓글' }, actor);
  const notes = (await f.service.details(installationId, { protected: false })).accessNotes!;
  assert.equal(notes.length, 2);
  assert.notEqual(notes[0].id, notes[1].id);
  assert.equal(notes[1].createdAt, '2026-09-10T04:00:00.000Z');
});

test('update and delete use stable note IDs and preserve createdAt, other notes, all existing detail fields', async (t) => {
  const f = await fixture(t),
    original = note('첫 내용'),
    other = note('다른 참고사항');
  f.seed({ ...f.initial, accessNotes: [original, other] });
  f.time('2026-09-10T05:06:07.008Z');
  await f.service.updateAccessNote(
    installationId,
    original.id.toUpperCase(),
    { revision: 1, content: '수정한 본문' },
    actor,
  );
  const updated = f.state().accessNotes!;
  assert.deepEqual(updated[0], {
    ...original,
    content: '수정한 본문',
    updatedAt: '2026-09-10T05:06:07.008Z',
  });
  assert.deepEqual(updated[1], other);
  assert.deepEqual(f.state().sections, f.initial.sections);
  await f.service.deleteAccessNote(installationId, original.id, { revision: 2 }, actor);
  assert.deepEqual(f.state().accessNotes, [other]);
  assert.deepEqual(f.state().sections, f.initial.sections);
  assert.deepEqual(
    f.audits.map((item) => item.action),
    ['note-update', 'note-delete'],
  );
  await assert.rejects(f.service.deleteAccessNote(installationId, original.id, { revision: 3 }, actor), {
    code: 'NOT_FOUND',
  });
});

test('ordinary field and basic metadata edits keep existing notes unchanged', async (t) => {
  const f = await fixture(t),
    notes = [note('보존할 참고사항')];
  f.seed({ ...f.initial, accessNotes: notes });
  await f.service.updateRow(
    installationId,
    'access-row',
    { revision: 1, values: { access_etc: '바꾼 긴 접근 비고' } },
    actor,
  );
  assert.deepEqual(f.state().accessNotes, notes);
  const current = await f.service.details(installationId, { protected: false });
  await f.service.updateRow(
    installationId,
    managedMetadataRowId(installationId),
    { revision: 2, metadataRevision: current.metadataRevision, values: { engineer: '새 담당자' } },
    actor,
  );
  assert.deepEqual(f.state().accessNotes, notes);
  assert.equal(f.data.engineer, '새 담당자');
  assert.equal((await f.service.details(installationId)).revision, 2);
});

test('client supplied dates and identifiers, blank/oversize/invalid text, and malformed IDs cannot write', async (t) => {
  const f = await fixture(t),
    original = note();
  f.seed({ ...f.initial, accessNotes: [original] });
  const before = structuredClone(f.records.records.get(installationId));
  for (const extra of [
    { createdAt: firstTime },
    { updatedAt: firstTime },
    { id: randomUUID() },
    { masked: true },
    { title: 'forbidden' },
  ]) {
    await assert.rejects(
      f.service.createAccessNote(installationId, { revision: 1, content: 'valid', ...extra }, actor),
      { code: 'INSTALLATION_WORKSPACE_INVALID' },
    );
    await assert.rejects(
      f.service.updateAccessNote(
        installationId,
        original.id,
        { revision: 1, content: 'valid', ...extra },
        actor,
      ),
      { code: 'INSTALLATION_WORKSPACE_INVALID' },
    );
    await assert.rejects(
      f.service.deleteAccessNote(installationId, original.id, { revision: 1, ...extra }, actor),
      { code: 'INSTALLATION_WORKSPACE_INVALID' },
    );
  }
  for (const content of ['', ' \r\n\t', 'x'.repeat(16_385), 'null\0byte', '\uD800', '\uDC00']) {
    await assert.rejects(f.service.createAccessNote(installationId, { revision: 1, content }, actor), {
      code: 'INSTALLATION_WORKSPACE_INVALID',
    });
    await assert.rejects(
      f.service.updateAccessNote(installationId, original.id, { revision: 1, content }, actor),
      { code: 'INSTALLATION_WORKSPACE_INVALID' },
    );
  }
  for (const key of ['not-a-uuid', '', '00000000-0000-0000-0000-000000000000'])
    await assert.rejects(f.service.deleteAccessNote(installationId, key, { revision: 1 }, actor), {
      code: 'INSTALLATION_WORKSPACE_INVALID',
    });
  assert.deepEqual(f.records.records.get(installationId), before);
  assert.equal(f.audits.length, 0);
});

test('stale and simultaneous note/field writes cannot overwrite a newer workspace revision', async (t) => {
  const f = await fixture(t),
    original = note();
  f.seed({ ...f.initial, accessNotes: [original] });
  const results = await Promise.allSettled([
    f.service.updateAccessNote(
      installationId,
      original.id,
      { revision: 1, content: '동시 참고사항 수정' },
      actor,
    ),
    f.service.updateRow(
      installationId,
      'access-row',
      { revision: 1, values: { os_login_etc: '동시 필드 수정' } },
      actor,
    ),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter(
      (result) => result.status === 'rejected' && result.reason.code === 'INSTALLATION_REVISION_CONFLICT',
    ).length,
    1,
  );
  const before = structuredClone(f.records.records.get(installationId));
  await assert.rejects(f.service.createAccessNote(installationId, { revision: 1, content: 'stale' }, actor), {
    code: 'INSTALLATION_REVISION_CONFLICT',
  });
  await assert.rejects(f.service.deleteAccessNote(installationId, original.id, { revision: 1 }, actor), {
    code: 'INSTALLATION_REVISION_CONFLICT',
  });
  assert.deepEqual(f.records.records.get(installationId), before);
});

test('late authorization guards and archived installations prevent every note mutation', async (t) => {
  const f = await fixture(t),
    original = note();
  f.seed({ ...f.initial, accessNotes: [original] });
  const before = structuredClone(f.records.records.get(installationId));
  const guard = async () => {
    throw new ApiError(403, 'ADMIN_REQUIRED', 'revoked fixture');
  };
  for (const action of [
    () => f.service.createAccessNote(installationId, { revision: 1, content: 'blocked' }, actor, guard),
    () =>
      f.service.updateAccessNote(
        installationId,
        original.id,
        { revision: 1, content: 'blocked' },
        actor,
        guard,
      ),
    () => f.service.deleteAccessNote(installationId, original.id, { revision: 1 }, actor, guard),
  ])
    await assert.rejects(action, { code: 'ADMIN_REQUIRED' });
  assert.deepEqual(f.records.records.get(installationId), before);
  assert.equal(f.audits.length, 0);
  f.exists(false);
  await assert.rejects(
    f.service.createAccessNote(installationId, { revision: 1, content: 'archived' }, actor),
    { code: 'NOT_FOUND' },
  );
});

test('stored duplicate IDs, impossible/non-UTC dates and malformed note structures fail closed', async (t) => {
  const f = await fixture(t),
    original = note();
  const invalid: unknown[] = [
    [original, { ...original, id: original.id.toUpperCase() }],
    [{ ...original, id: 'invalid' }],
    [{ ...original, createdAt: '2026-02-30T00:00:00.000Z' }],
    [{ ...original, createdAt: '2026-09-10T12:00:00.000+09:00' }],
    [{ ...original, createdAt: '2026-09-10T00:00:00Z' }],
    [{ ...original, updatedAt: '2026-13-10T00:00:00.000Z' }],
    [{ ...original, content: '  ' }],
    [{ ...original, masked: false }],
    'not-an-array',
    null,
    Array.from({ length: 1_001 }, () => note()),
  ];
  for (const accessNotes of invalid) {
    const state = { ...f.initial, accessNotes };
    assert.equal(managedInstallationSchema.safeParse(state).success, false);
    f.seed(state);
    await assert.rejects(f.service.details(installationId), { code: 'INSTALLATION_WORKSPACE_UNAVAILABLE' });
  }
  assert.equal(f.audits.length, 0);
});

test('the 1000-note limit allows editing/deleting existing notes and never silently truncates', async (t) => {
  const f = await fixture(t),
    notes = Array.from({ length: 1_000 }, () => note());
  f.seed({ ...f.initial, accessNotes: notes });
  const before = structuredClone(f.records.records.get(installationId));
  await assert.rejects(
    f.service.createAccessNote(installationId, { revision: 1, content: 'overflow' }, actor),
    { code: 'INSTALLATION_ACCESS_NOTES_LIMIT' },
  );
  assert.deepEqual(f.records.records.get(installationId), before);
  await f.service.updateAccessNote(installationId, notes[0].id, { revision: 1, content: '수정 가능' }, actor);
  await f.service.deleteAccessNote(installationId, notes[1].id, { revision: 2 }, actor);
  await f.service.createAccessNote(installationId, { revision: 3, content: '빈 자리 등록' }, actor);
  assert.equal(f.state().accessNotes!.length, 1_000);
});

test('notes share the existing 8 MiB total document ceiling', async (t) => {
  const f = await fixture(t),
    notes: Note[] = [],
    content = '가'.repeat(16_384);
  while (
    Buffer.byteLength(JSON.stringify({ ...f.initial, accessNotes: [...notes, note(content)] })) <=
    8 * 1_048_576
  )
    notes.push(note(content));
  assert.ok(notes.length > 0 && notes.length < 1_000);
  f.seed({ ...f.initial, accessNotes: notes });
  const before = structuredClone(f.records.records.get(installationId));
  await assert.rejects(f.service.createAccessNote(installationId, { revision: 1, content }, actor), {
    code: 'INSTALLATION_WORKSPACE_TOO_LARGE',
  });
  assert.deepEqual(f.records.records.get(installationId), before);
  assert.equal(f.audits.length, 0);
});

test('materialization and generic backup snapshots preserve existing encrypted notes', async (t) => {
  const f = await fixture(t),
    notes = [note('합성 백업 보존 본문')];
  f.seed({ ...f.initial, accessNotes: notes });
  const stored = structuredClone(f.records.records.get(installationId)!);
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      throw new Error('UNEXPECTED_SOURCE_READ');
    },
  } as unknown as Parameters<typeof createMaterializer>[0];
  assert.throws(() => createMaterializer(client, f.vault), /INSTALLATION_MATERIALIZATION_RETIRED/);
  assert.equal(queries.length, 0);
  assert.deepEqual(f.records.records.get(installationId), stored);
  const row = JSON.stringify({ installation_id: installationId, ...stored });
  const snapshot: BackupSnapshot = {
    version: 1,
    database: 'yeta_crm',
    tables: [
      {
        schema: 'yeta_crm_private',
        name: 'installation_workspace',
        columns: [],
        constraints: [],
        indexes: [],
        triggers: [],
        rows: [row],
      },
    ],
    sequences: [],
    functions: [],
    files: [],
    externalReferences: false,
  };
  validateSnapshot(snapshot);
  const saved = JSON.parse(JSON.stringify(snapshot)) as BackupSnapshot;
  assert.equal(snapshotFingerprint(saved), snapshotFingerprint(snapshot));
  assert.ok(!JSON.stringify(saved).includes(notes[0].content));
  const restored = JSON.parse(saved.tables[0].rows[0]);
  assert.deepEqual(
    JSON.parse(f.vault.decrypt(restored.envelope, context(installationId, restored.revision))).accessNotes,
    notes,
  );
});
