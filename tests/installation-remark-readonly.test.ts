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
} from '../src/installation-types.ts';

function field(id: string, key: string, value: string): InstallationDetailField {
  return { id, key, label: key, value, secret: false, masked: false, present: Boolean(value) };
}

test('the remark fields the editor no longer offers are recognised by key and by label', () => {
  for (const key of ['note', 'etc', 'ct_etc', 'setup_etc', 'os_login_etc', 'setting_etc'])
    assert.equal(installationRemarkField({ key }), true, key);
  assert.equal(installationRemarkField({ key: 'custom', label: '참고사항' }), true);
  assert.equal(installationRemarkField({ key: 'custom_bigo', label: '현장 비고' }), true);
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

const installationRow = (): InstallationDetailRow => ({
  id: 'meta',
  title: '설치 정보',
  fields: [
    field('code', 'systemCode', 'ACME-2026'),
    field('stored-note', 'note', '보존해야 하는 기존 비고'),
    field('stored-etc', 'setup_etc', '보존해야 하는 기존 설정 비고'),
  ],
});

test('a remark value in the draft is never written back, so the stored value survives', () => {
  const operations = prepareInstallationSectionOperations(details([installationRow()]), 'installation', {
    values: { 'stored-note': '', 'stored-etc': '덮어쓰기 시도' },
    titles: {},
    notes: {},
  });
  assert.deepEqual(operations, []);

  const edited = prepareInstallationSectionOperations(details([installationRow()]), 'installation', {
    values: { code: 'ACME-2027', 'stored-note': '', 'stored-etc': '덮어쓰기 시도' },
    titles: {},
    notes: {},
  });
  assert.equal(edited.length, 1);
  const [operation] = edited;
  assert.equal(operation.kind, 'row-update');
  if (operation.kind !== 'row-update') return;
  assert.deepEqual(operation.body.values, { systemCode: 'ACME-2027' });
  assert.equal(Object.hasOwn(operation.body.values ?? {}, 'note'), false);
  assert.equal(Object.hasOwn(operation.body.values ?? {}, 'setup_etc'), false);
});

test('the installation quick form cannot submit a remark at all', () => {
  assert.equal((installationBasicKeys as readonly string[]).includes('note'), false);
});
