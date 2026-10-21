import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installationBasicChanges,
  installationBasicErrors,
  installationEditorGroups,
  installationFieldGroup,
  installationInputDefinition,
  installationSectionChangeCount,
} from '../src/installation-editor.ts';
import { installationFieldTemplates } from '../src/installation-labels.ts';
import {
  prepareInstallationSection,
  prepareInstallationSectionOperations,
} from '../src/installation-client.ts';
import type { InstallationDetails, InstallationSectionId } from '../src/installation-types.ts';

test('every existing or custom field remains reachable and reference notes have a group without rows', () => {
  for (const section of Object.keys(installationFieldTemplates) as InstallationSectionId[]) {
    const keys = [...installationFieldTemplates[section].map(([key]) => key), 'custom_fixture'];
    const groups = installationEditorGroups(section, keys);
    for (const key of keys)
      assert.ok(groups.some((group) => group.id === installationFieldGroup(section, key).id));
    assert.equal(groups.filter((group) => group.id === 'other').length, 1);
  }
  assert.deepEqual(
    installationEditorGroups('access', [], true).map((group) => group.id),
    ['notes'],
  );
  assert.equal(installationFieldGroup('access', 'access_etc').id, 'notes');
  assert.equal(installationFieldGroup('access', 'os_login_etc').id, 'os');
});

test('typed inputs do not coerce imported dates, numbers, unknown flags or custom fields', () => {
  assert.equal(installationInputDefinition('setup_date', '2026-10-13').type, 'date');
  for (const value of ['20261013', '2026-02-30', '0000-01-01', '2026-10-13 10:00', '추후 확인'])
    assert.equal(installationInputDefinition('setup_date', value).type, 'text');
  assert.equal(installationInputDefinition('ssh_port', '22').type, 'number');
  for (const value of ['0022', ' 22 ', '22/2222', '1e3', '-1'])
    assert.equal(installationInputDefinition('ssh_port', value).type, 'text');
  assert.equal(installationInputDefinition('bonding_yn', 'E').type, 'text');
  assert.equal(installationInputDefinition('setting_yn', '확인 필요').type, 'text');
  assert.equal(installationInputDefinition('custom_fixture', '2026-10-13').type, 'text');
  assert.equal(installationInputDefinition('custom_fixture', 'one\ntwo').type, 'textarea');
});

test('masked values only count as changes when explicitly replaced or cleared; undo omits them', () => {
  const details: InstallationDetails = {
    id: 'fixture',
    imported: true,
    revision: 0,
    sections: [
      {
        id: 'access',
        title: '접근',
        imported: true,
        rows: [
          {
            id: 'row',
            title: '합성 기록',
            fields: [
              {
                id: 'port',
                key: 'ssh_port',
                label: 'SSH 포트',
                value: '22',
                secret: false,
                masked: false,
                present: true,
              },
              {
                id: 'password',
                key: 'os_root_pwd',
                label: '비밀번호',
                value: '••••••••',
                secret: true,
                masked: true,
                present: true,
              },
            ],
          },
        ],
      },
    ],
    accessNotes: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        content: '기존 메모',
        masked: false,
        createdAt: '2026-10-13T00:00:00.000Z',
      },
    ],
  };
  const unchanged = { values: { port: '22' }, titles: { row: '합성 기록' }, notes: {} };
  assert.equal(installationSectionChangeCount(details, 'access', unchanged), 0);
  assert.deepEqual(prepareInstallationSection(details, 'access', unchanged), []);
  const edit = { ...unchanged, values: { port: '2222' } };
  assert.equal(installationSectionChangeCount(details, 'access', edit), 1);
  assert.deepEqual(prepareInstallationSection(details, 'access', edit)[0].body.values, { ssh_port: '2222' });
  const clear = { ...edit, values: { ...edit.values, password: '' } };
  assert.equal(installationSectionChangeCount(details, 'access', clear), 2);
  assert.deepEqual(prepareInstallationSection(details, 'access', clear)[0].body.values, {
    ssh_port: '2222',
    os_root_pwd: '',
  });
  const withNote = { ...edit, notes: { [details.accessNotes![0].id]: '수정 메모' } };
  assert.equal(installationSectionChangeCount(details, 'access', withNote), 2);
  assert.equal(installationSectionChangeCount(details, 'server', withNote), 0);
});

test('section editor drafts row, field and access note additions and removals as validated operations', () => {
  const details: InstallationDetails = {
    id: 'fixture',
    imported: true,
    revision: 7,
    metadataRevision: 'a'.repeat(64),
    sections: [
      {
        id: 'server',
        title: '서버',
        imported: true,
        rows: [
          {
            id: 'server-row',
            title: '서버 구성',
            fields: [
              {
                id: 'host',
                key: 'server_host',
                label: '호스트',
                value: 'old',
                secret: false,
                masked: false,
                present: true,
              },
              {
                id: 'port',
                key: 'server_port',
                label: '포트',
                value: '22',
                secret: false,
                masked: false,
                present: true,
              },
            ],
          },
        ],
      },
      {
        id: 'access',
        title: '접근',
        imported: true,
        rows: [
          {
            id: 'access-row',
            title: '접근 정보',
            managed: 'metadata',
            fields: [
              {
                id: 'system',
                key: 'systemCode',
                label: '시스템 코드',
                value: 'TEST',
                secret: false,
                masked: false,
                present: true,
              },
            ],
          },
        ],
      } as InstallationDetails['sections'][number],
      // Keep the fixture small while satisfying the details type.
      ...(['installation', 'yeta', 'sap', 'settings', 'files'] as const).map((id) => ({
        id,
        title: id,
        imported: true,
        rows: [],
      })),
    ],
    accessNotes: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        content: 'old note',
        masked: false,
        createdAt: '2026-10-13T00:00:00.000Z',
      },
    ],
  };
  const operations = prepareInstallationSectionOperations(details, 'server', {
    values: { host: 'new' },
    titles: {},
    notes: {},
    addedFields: { 'server-row': [{ localId: 'f1', key: 'server_zone', label: '영역', value: 'prod' }] },
    removedFields: { 'server-row': ['server_port'] },
    addedRows: [
      {
        localId: 'r1',
        title: '보조 서버',
        fields: [{ key: 'server_host', label: '호스트', value: 'backup' }],
      },
    ],
    removedRows: [],
  });
  assert.deepEqual(operations, [
    {
      kind: 'row-update',
      id: 'server-row',
      body: {
        title: '서버 구성',
        values: { server_host: 'new' },
        removeFields: ['server_port'],
        addFields: [{ key: 'server_zone', label: '영역', value: 'prod' }],
      },
      addFieldLocalIds: ['f1'],
      metadata: false,
    },
    {
      kind: 'row-create',
      localId: 'r1',
      fieldLocalIds: [''],
      body: {
        sectionId: 'server',
        title: '보조 서버',
        fields: [{ key: 'server_host', label: '호스트', value: 'backup' }],
      },
    },
  ]);
  const noteOps = prepareInstallationSectionOperations(details, 'access', {
    values: {},
    titles: {},
    notes: {},
    addedNotes: [{ localId: 'n1', content: 'new note' }],
    removedNotes: [details.accessNotes![0].id],
  });
  assert.deepEqual(noteOps, [
    { kind: 'note-delete', id: details.accessNotes![0].id },
    { kind: 'note-create', localId: 'n1', content: 'new note' },
  ]);
});

test('section editor rejects managed metadata structure changes and invalid new fields before saving', () => {
  const details: InstallationDetails = {
    id: 'fixture',
    imported: true,
    revision: 0,
    metadataRevision: 'a'.repeat(64),
    sections: [
      {
        id: 'installation',
        title: '설치',
        imported: true,
        rows: [
          {
            id: 'metadata',
            title: '기본 정보',
            managed: 'metadata',
            fields: [
              {
                id: 'name',
                key: 'systemCode',
                label: '시스템 코드',
                value: 'TEST',
                secret: false,
                masked: false,
                present: true,
              },
            ],
          },
        ],
      },
      ...(['access', 'server', 'yeta', 'sap', 'settings', 'files'] as const).map((id) => ({
        id,
        title: id,
        imported: true,
        rows: [],
      })),
    ],
  };
  assert.throws(
    () =>
      prepareInstallationSectionOperations(details, 'installation', {
        values: {},
        titles: {},
        notes: {},
        removedRows: ['metadata'],
      }),
    /기본 정보의 이름과 항목 구성은 변경할 수 없습니다/,
  );
  assert.throws(
    () =>
      prepareInstallationSectionOperations(details, 'installation', {
        values: {},
        titles: {},
        notes: {},
        removedFields: { metadata: ['systemCode'] },
      }),
    /이름과 항목 구성은 변경할 수 없습니다/,
  );
  assert.throws(
    () =>
      prepareInstallationSectionOperations(details, 'installation', {
        values: {},
        titles: {},
        notes: {},
        addedFields: { metadata: [{ localId: 'f1', key: 'custom_key', label: '새 항목', value: '' }] },
      }),
    /이름과 항목 구성은 변경할 수 없습니다/,
  );
  assert.throws(
    () =>
      prepareInstallationSectionOperations(details, 'server', {
        values: {},
        titles: {},
        notes: {},
        addedRows: [
          { localId: 'bad', title: '잘못된 항목', fields: [{ key: 'bad key', label: '이름', value: '' }] },
        ],
      }),
    /새 항목의 이름과 키를 확인해 주세요/,
  );
});

test('quick registration requires a linked or directly named company and preserves unlinked legacy records', () => {
  assert.ok(installationBasicErrors({}, true).companyName);
  assert.ok(installationBasicErrors({ companyName: '  ' }, true).companyName);
  assert.ok(installationBasicErrors({ companyName: '합성' }, true).systemCode);
  assert.deepEqual(installationBasicErrors({ companyName: '합성', systemCode: 'TEST' }, true), {});
  assert.deepEqual(installationBasicErrors({ companyId: 'fixture', systemCode: 'TEST' }, true), {});
  assert.deepEqual(installationBasicErrors({ systemCode: 'LEGACY' }, false), {});
});

test('quick registration validates edited dates and domains without blocking untouched legacy values', () => {
  const draft = {
    companyName: '합성',
    systemCode: 'TEST',
    installedAt: '2026-10-13',
    patchedAt: '2026-01-01',
    domain: 'legacy/value',
  };
  assert.ok(installationBasicErrors(draft, true).patchedAt);
  assert.ok(installationBasicErrors(draft, true).domain);
  assert.deepEqual(installationBasicErrors(draft, true, draft), {});
  assert.ok(installationBasicErrors({ ...draft, patchedAt: '2026-02-01' }, true, draft).patchedAt);
  assert.equal(
    installationBasicErrors({ systemCode: 'TEST', domain: 'service.example.com' }, false).domain,
    undefined,
  );
});

test('quick form dirty tracking clears on revert and preserves false versus an untouched default', () => {
  const original = { systemCode: 'TEST', companyId: null, autoUpdate: false, note: '••••••••' };
  assert.deepEqual(installationBasicChanges({ ...original, companyId: '', domain: '' }, original), []);
  assert.deepEqual(installationBasicChanges({ ...original, autoUpdate: true }, original), ['autoUpdate']);
  assert.deepEqual(installationBasicChanges({ ...original, note: '' }, original), ['note']);
  assert.deepEqual(installationBasicChanges({ ...original }, original), []);
});
