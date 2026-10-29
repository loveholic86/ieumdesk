import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installationCustomerLinkRow,
  installationHiddenField,
  hiddenCustomerLinkKeys,
  hiddenInstallationKeys,
} from '../src/installation-types.ts';
import {
  prepareInstallationSectionOperations,
  visibleInstallationSection,
} from '../src/installation-client.ts';
import { installationEditorGroups, installationFieldGroup } from '../src/installation-editor.ts';
import { installationFieldTemplates } from '../src/installation-labels.ts';
import type {
  InstallationDetailField,
  InstallationDetailRow,
  InstallationDetailSection,
  InstallationDetails,
} from '../src/installation-types.ts';

function field(id: string, key: string, value: string, label = key): InstallationDetailField {
  return { id, key, label, value, secret: false, masked: false, present: Boolean(value) };
}

const basics = (): InstallationDetailRow => ({
  id: 'basics',
  title: '이관 원본 설치 정보',
  fields: [
    field('setup-cd', 'setup_cd', '101', '설치 ID'),
    field('mng-cd', 'mng_cd', '7', '설치 담당자 코드'),
    field('bonding', 'bonding_yn', 'Y', '네트워크 본딩'),
    field('member', 'sys_member', '12', '인원'),
    field('version', 'sv_version', '2026.1', '서비스 버전'),
  ],
});

const customerLink = (ordinal = 1): InstallationDetailRow => ({
  id: `link-${ordinal}`,
  title: `이관 원본 고객사 연결 ${ordinal}`,
  fields: [
    field(`ct-${ordinal}`, 'ct_cd', '9001', '고객사 코드'),
    field(`sys-${ordinal}`, 'sys_cd', 'DEMO', '시스템 코드'),
    field(`count-${ordinal}`, 'sys_com_count', '3', '회사 코드 수'),
    field(`people-${ordinal}`, 'sys_member', '12', '인원'),
  ],
});

const other = (): InstallationDetailRow => ({
  id: 'yeta-row',
  title: '이관 원본 YETA 로그인 1',
  fields: [
    field('yeta-sys', 'sys_cd', 'DEMO', '시스템 코드'),
    field('yeta-ct', 'ct_cd', '9001', '고객사 코드'),
    field('yeta-id', 'yeta_id', 'demo', 'YETA 아이디'),
  ],
});

const installationSection = (rows: InstallationDetailRow[]): InstallationDetailSection => ({
  id: 'installation',
  title: '설치 정보',
  imported: true,
  rows,
});

const sectionKeys = (section: InstallationDetailSection) =>
  section.rows.map((row) => ({ id: row.id, keys: row.fields.map((item) => item.key) }));

test('the installation tab hides its duplicate keys and the customer-link codes only', () => {
  assert.deepEqual([...hiddenInstallationKeys], ['mng_cd', 'setup_cd', 'bonding_yn']);
  assert.deepEqual([...hiddenCustomerLinkKeys], ['ct_cd', 'sys_cd']);
  const visible = visibleInstallationSection(installationSection([basics(), customerLink(), other()]));
  assert.deepEqual(sectionKeys(visible), [
    // Same row, duplicate basics gone, headcount kept.
    { id: 'basics', keys: ['sys_member', 'sv_version'] },
    // A customer-link row loses both codes but keeps its headcount and company-code count.
    { id: 'link-1', keys: ['sys_com_count', 'sys_member'] },
    // The same keys in another row are untouched: only the link row repeats the basics.
    { id: 'yeta-row', keys: ['sys_cd', 'ct_cd', 'yeta_id'] },
  ]);
});

test('hiding is display only: the stored rows keep every field', () => {
  const source = installationSection([basics(), customerLink()]);
  const before = JSON.stringify(source);
  visibleInstallationSection(source);
  assert.equal(JSON.stringify(source), before);
});

test('the customer-link row is recognised by its title or by holding only the link keys', () => {
  assert.equal(installationCustomerLinkRow({ title: '고객사 연결 1', fields: [] }), true);
  assert.equal(installationCustomerLinkRow({ title: '이관 원본 고객사 연결 12', fields: [] }), true);
  assert.equal(installationCustomerLinkRow({ title: '설치 정보', fields: [] }), false);
  const keys = (list: string[]) => list.map((key) => ({ key }));
  // Untitled rows from a saved workspace still match by their exact key set.
  assert.equal(
    installationCustomerLinkRow({ fields: keys(['ct_cd', 'sys_cd', 'sys_member', 'sys_com_count']) }),
    true,
  );
  // A normal installation row carrying a company code is not a link row.
  assert.equal(installationCustomerLinkRow({ fields: keys(['ct_cd', 'sys_cd', 'sv_version']) }), false);
  assert.equal(installationCustomerLinkRow({ fields: keys(['sys_cd', 'yeta_id']) }), false);
});

test('only the installation tab hides keys, and never a same-named field elsewhere', () => {
  for (const key of hiddenInstallationKeys)
    for (const id of ['access', 'server', 'yeta', 'sap', 'settings', 'files'] as const)
      assert.equal(installationHiddenField(id, other(), { key }), false, `${id}:${key}`);
  assert.equal(installationHiddenField('installation', other(), { key: 'setup_cd' }), true);
  assert.equal(installationHiddenField('installation', customerLink(), { key: 'ct_cd' }), true);
  assert.equal(installationHiddenField('installation', customerLink(), { key: 'sys_com_count' }), false);
});

test('a save never clears, blanks, or removes a hidden field', () => {
  const details: InstallationDetails = {
    id: 'fixture',
    imported: true,
    revision: 5,
    sections: [installationSection([basics(), customerLink()])],
  };
  // A draft that touches only the visible headcount must not carry the hidden keys.
  const visible = visibleInstallationSection(details.sections[0]);
  const operations = prepareInstallationSectionOperations(details, 'installation', {
    values: {
      member: '13',
      // A stale or crafted draft naming the hidden fields is ignored as well.
      'setup-cd': '',
      'mng-cd': '9',
      bonding: 'N',
      'ct-1': '1',
      'sys-1': 'OTHER',
    },
    titles: {},
    notes: {},
  });
  assert.equal(operations.length, 1);
  const [operation] = operations;
  assert.equal(operation.kind, 'row-update');
  if (operation.kind !== 'row-update') return;
  assert.deepEqual(operation.body.values, { sys_member: '13' });
  assert.equal(Object.hasOwn(operation.body.values ?? {}, 'setup_cd'), false);
  assert.equal(Object.hasOwn(operation.body.values ?? {}, 'mng_cd'), false);
  assert.equal(Object.hasOwn(operation.body.values ?? {}, 'bonding_yn'), false);
  assert.deepEqual(operation.body.removeFields, []);
  assert.deepEqual(operation.body.addFields, []);
  // The hidden fields are still in the response the draft was built against.
  assert.deepEqual(sectionKeys(visible), [
    { id: 'basics', keys: ['sys_member', 'sv_version'] },
    { id: 'link-1', keys: ['sys_com_count', 'sys_member'] },
  ]);
  assert.equal(details.sections[0].rows[0].fields.length, 5);
});

test('an installation row holding only hidden keys neither disappears from storage nor is rewritten', () => {
  const onlyHidden: InstallationDetailRow = {
    id: 'hidden-only',
    title: '이관 원본 설치 정보',
    fields: [field('setup-cd', 'setup_cd', '101'), field('mng-cd', 'mng_cd', '7')],
  };
  const details: InstallationDetails = {
    id: 'fixture',
    imported: true,
    revision: 2,
    sections: [installationSection([onlyHidden, customerLink()])],
  };
  const visible = visibleInstallationSection(details.sections[0]);
  assert.deepEqual(
    visible.rows.map((row) => row.id),
    ['link-1'],
  );
  const operations = prepareInstallationSectionOperations(details, 'installation', {
    values: { 'count-1': '4' },
    titles: {},
    notes: {},
  });
  assert.deepEqual(
    operations.map((operation) => (operation.kind === 'row-update' ? operation.id : operation.kind)),
    ['link-1'],
  );
  assert.equal(details.sections[0].rows.length, 2);
});

test('a draft cannot remove a hidden field either', () => {
  const details: InstallationDetails = {
    id: 'fixture',
    imported: true,
    revision: 2,
    sections: [installationSection([basics(), customerLink()])],
  };
  assert.throws(
    () =>
      prepareInstallationSectionOperations(details, 'installation', {
        values: {},
        titles: {},
        notes: {},
        removedFields: { basics: ['setup_cd'] },
      }),
    /화면에 표시되지 않는 항목은 삭제할 수 없습니다/,
  );
  assert.throws(
    () =>
      prepareInstallationSectionOperations(details, 'installation', {
        values: {},
        titles: {},
        notes: {},
        removedFields: { 'link-1': ['ct_cd'] },
      }),
    /화면에 표시되지 않는 항목은 삭제할 수 없습니다/,
  );
  // A visible field is still removable, and the same keys stay removable in other tabs.
  const visibleOnly = prepareInstallationSectionOperations(details, 'installation', {
    values: {},
    titles: {},
    notes: {},
    removedFields: { basics: ['sv_version'] },
  });
  assert.deepEqual(
    visibleOnly.map((operation) => operation.kind),
    ['row-update'],
  );
});

test('the installation editor menus never point at a hidden key', () => {
  for (const key of hiddenInstallationKeys)
    assert.notEqual(installationFieldGroup('installation', key).id, 'notes', key);
  // Every seeded template key stays reachable or is deliberately hidden; none lands in 'other'.
  const keys = installationFieldTemplates.installation.map(([key]) => key);
  const groups = installationEditorGroups('installation', keys);
  for (const group of groups)
    for (const key of group.keys)
      if (hiddenInstallationKeys.has(key))
        assert.equal(installationFieldGroup('installation', key).id, group.id);
  // The installation remark group is a normal, always-listed menu entry, not a hidden block.
  assert.equal(installationFieldGroup('installation', 'note').id, 'notes');
  assert.equal(installationFieldGroup('installation', 'ct_etc').id, 'notes');
  assert.equal(installationFieldGroup('installation', 'setup_etc').id, 'notes');
  assert.ok(installationEditorGroups('installation', keys).some((group) => group.id === 'notes'));
});
