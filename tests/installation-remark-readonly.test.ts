import test from 'node:test';
import assert from 'node:assert/strict';
import { installationBasicKeys, installationEditableRows } from '../src/installation-editor.ts';
import { installationFieldTemplates } from '../src/installation-labels.ts';
import { installationRemarkField } from '../src/installation-types.ts';
import { prepareInstallationSectionOperations } from '../src/installation-client.ts';
import type {
  InstallationDetailField,
  InstallationDetailRow,
  InstallationDetails,
  InstallationSectionId,
} from '../src/installation-types.ts';

function field(id: string, key: string, value: string): InstallationDetailField {
  return { id, key, label: key, value, secret: false, masked: false, present: Boolean(value) };
}

test('only the installation tab keeps its own remarks editable; every other remark stays read-only', () => {
  // Read-only everywhere: another tab's remark keys and any custom 비고/참고사항 field.
  for (const key of ['etc', 'os_login_etc', 'setting_etc'])
    for (const section of [undefined, 'installation', 'access', 'sap', 'settings'] as const)
      assert.equal(installationRemarkField({ key }, section), true, `${section}:${key}`);
  for (const section of [undefined, 'access', 'sap'] as const)
    for (const key of ['note', 'ct_etc', 'setup_etc'])
      assert.equal(installationRemarkField({ key }, section), true, `${section}:${key}`);
  assert.equal(installationRemarkField({ key: 'custom', label: '참고사항' }), true);
  assert.equal(installationRemarkField({ key: 'custom_bigo', label: '현장 비고' }), true);
  // Opened for editing: the installation tab's own remark group only.
  for (const key of ['note', 'ct_etc', 'setup_etc']) {
    assert.equal(installationRemarkField({ key }, 'installation'), false, key);
    assert.equal(installationRemarkField({ key, label: '비고' }, 'installation'), false, key);
    assert.equal(installationEditableRows([{ fields: [{ key }] }], 'installation').length, 1, key);
  }
  // Editable values and the installation-wide remark keep their own input.
  for (const key of ['systemCode', 'version', 'hostname', 'setup_date']) {
    assert.equal(installationRemarkField({ key }), false, key);
    assert.equal(installationEditableRows([{ fields: [{ key }] }]).length, 1, key);
  }
  assert.equal(installationRemarkField({ key: 'access_etc' }), false);
});

test('edited reminder rows lose their remark fields and a remark-only row drops out', () => {
  const rows = [
    { id: 'server', fields: [{ key: 'hostname' }, { key: 'note' }, { key: 'setup_etc' }] },
    { id: 'remark-only', fields: [{ key: 'note' }, { key: 'ct_etc' }] },
  ];
  assert.deepEqual(
    installationEditableRows(rows).map((row) => ({ id: row.id, keys: row.fields.map((field) => field.key) })),
    [{ id: 'server', keys: ['hostname'] }],
  );
  // In the installation tab the same row keeps its own remarks, and the remark-only row survives.
  assert.deepEqual(
    installationEditableRows(rows, 'installation').map((row) => ({
      id: row.id,
      keys: row.fields.map((field) => field.key),
    })),
    [
      { id: 'server', keys: ['hostname', 'note', 'setup_etc'] },
      { id: 'remark-only', keys: ['note', 'ct_etc'] },
    ],
  );
});

test('a new record never pre-fills a remark input in any section', () => {
  // 「기록 추가」 seeds a new row from the templates, so the templates themselves must be clean.
  for (const [section, templates] of Object.entries(installationFieldTemplates)) {
    const seeded = templates.filter(([key, label]) => !installationRemarkField({ key, label }));
    assert.equal(
      seeded.length,
      templates.length - templates.filter(([key, label]) => installationRemarkField({ key, label })).length,
      section,
    );
    assert.deepEqual(
      seeded.filter(([key, label]) => installationRemarkField({ key, label })),
      [],
      section,
    );
  }
  // The known remark templates are the ones dropping out, so the filter is doing real work.
  const installationKeys = installationFieldTemplates.installation.map(([key]) => key);
  assert.ok(installationKeys.includes('ct_etc') && installationKeys.includes('setup_etc'));
  const seededInstallation = installationFieldTemplates.installation
    .filter(([key, label]) => !installationRemarkField({ key, label }))
    .map(([key]) => key);
  assert.equal(seededInstallation.includes('ct_etc'), false);
  assert.equal(seededInstallation.includes('setup_etc'), false);
  assert.ok(seededInstallation.includes('systemCode') || seededInstallation.includes('sys_cd'));
  // The installation tab's remarks are editable on an existing row, yet a new row still seeds none:
  // 「기록 추가」 filters the templates without a section, so every remark key is dropped.
  const remarkTemplates = installationFieldTemplates.installation.filter(([key, label]) =>
    installationRemarkField({ key, label }),
  );
  assert.deepEqual(
    remarkTemplates.map(([key]) => key).filter((key) => ['ct_etc', 'setup_etc'].includes(key)),
    ['ct_etc', 'setup_etc'],
  );
  assert.ok(seededInstallation.includes('sys_member'));
  // The access section keeps its ordinary fields but still drops its own OS remark input.
  assert.equal(seededInstallation.includes('os_login_etc'), false, 'the access OS remark is still a remark');
  const seededAccess = installationFieldTemplates.access
    .filter(([key, label]) => !installationRemarkField({ key, label }))
    .map(([key]) => key);
  assert.equal(seededAccess.includes('os_login_etc'), false);
  assert.ok(seededAccess.includes('vpnsv_ip') && seededAccess.includes('domainurl'));
  // The installation-wide access remark keeps its own panel, so it is never a remark input.
  assert.equal(installationRemarkField({ key: 'access_etc', label: '접근 비고' }), false);
});

function details(rows: InstallationDetailRow[]): InstallationDetails {
  return {
    id: 'fixture',
    imported: false,
    revision: 3,
    sections: [{ id: 'installation', title: '설치', imported: false, rows }],
  };
}

/** One section holding the given rows, so another tab's remark can be drafted against it. */
function remarkDetails(id: InstallationSectionId, rows: InstallationDetailRow[]): InstallationDetails {
  return {
    id: 'fixture',
    imported: false,
    revision: 3,
    sections: [{ id, title: id, imported: false, rows }],
  };
}

const installationRow = (): InstallationDetailRow => ({
  id: 'meta',
  title: '설치 정보',
  fields: [
    field('code', 'systemCode', 'ACME-2026'),
    field('stored-note', 'note', '보존해야 하는 기존 비고'),
    field('stored-etc', 'setup_etc', '보존해야 하는 기존 설정 비고'),
  ],
});

test('the installation remark now saves, while every other section remark is never written back', () => {
  const edited = prepareInstallationSectionOperations(details([installationRow()]), 'installation', {
    values: { code: 'ACME-2027', 'stored-note': '수정한 설치 비고', 'stored-etc': '' },
    titles: {},
    notes: {},
  });
  assert.equal(edited.length, 1);
  const [operation] = edited;
  assert.equal(operation.kind, 'row-update');
  if (operation.kind !== 'row-update') return;
  assert.deepEqual(operation.body.values, {
    systemCode: 'ACME-2027',
    note: '수정한 설치 비고',
    setup_etc: '',
  });

  // Another tab's remark stays read-only even when the draft carries a value for it.
  const access = remarkDetails('access', [
    { id: 'os', title: 'OS 계정', fields: [field('os-etc', 'os_login_etc', '기존 OS 비고')] },
  ]);
  assert.deepEqual(
    prepareInstallationSectionOperations(access, 'access', {
      values: { 'os-etc': '덮어쓰기 시도' },
      titles: {},
      notes: {},
    }),
    [],
  );
  const sap = remarkDetails('sap', [
    { id: 'sap', title: 'SAP', fields: [field('sap-etc', 'etc', '기존 SAP 비고')] },
  ]);
  assert.deepEqual(
    prepareInstallationSectionOperations(sap, 'sap', {
      values: { 'sap-etc': '덮어쓰기 시도' },
      titles: {},
      notes: {},
    }),
    [],
  );
  const settings = remarkDetails('settings', [
    { id: 'setting', title: '별도 설정', fields: [field('setting-etc', 'setting_etc', '기존 설정 비고')] },
  ]);
  assert.deepEqual(
    prepareInstallationSectionOperations(settings, 'settings', {
      values: { 'setting-etc': '덮어쓰기 시도' },
      titles: {},
      notes: {},
    }),
    [],
  );
});

test('the installation quick form cannot submit a remark at all', () => {
  assert.equal((installationBasicKeys as readonly string[]).includes('note'), false);
});
