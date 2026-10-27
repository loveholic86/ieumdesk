import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  installationFieldMasked,
  installationBooleanChoice,
  prepareInstallationSection,
  installationRowCanDelete,
  prepareInstallationRow,
  refreshedInstallationSelection,
  validateInstallationDetails,
  visibleInstallationSection,
} from '../src/installation-client.ts';
import { downloadInstallationFile, installationRequest } from '../src/installation-api.ts';
import type { InstallationDetailRow } from '../src/installation-types.ts';
import { installationFieldTemplates } from '../src/installation-labels.ts';

const row: InstallationDetailRow = {
  id: 'row-fixture',
  title: '합성 설치 기록',
  fields: [
    {
      id: 'field-secret',
      key: 'os_root_pwd',
      label: 'OS 관리자 비밀번호',
      value: '••••••••',
      secret: true,
      masked: true,
      present: true,
    },
    {
      id: 'field-year',
      key: 'setup_year',
      label: '최초 설치 연도',
      value: '2026',
      secret: false,
      masked: false,
      present: true,
    },
    {
      id: 'field-note',
      key: 'ct_etc',
      label: '비고',
      value: '합성 메모',
      secret: false,
      masked: false,
      present: true,
    },
  ],
};
const details = () => ({
  id: 'installation-fixture',
  imported: true,
  revision: 4,
  sections: ['installation', 'access', 'server', 'yeta', 'sap', 'settings', 'files'].map((id, index) => ({
    id,
    title: id,
    imported: true,
    rows: index === 0 ? [structuredClone(row)] : [],
  })),
});
const accessNote = () => ({
  id: '00000000-0000-4000-8000-000000000001',
  content: '  합성 접근 참고사항\n연락 전 확인 🔐  ',
  createdAt: '2026-09-10T01:02:03.004Z',
  masked: false,
});
const validNotes = (accessNotes: unknown) =>
  validateInstallationDetails({ ...details(), accessNotes }, 'installation-fixture');

test('retired access controls are hidden in display and editing while stored fields stay untouched', () => {
  const hidden = ['access_reqst_date', 'access_id', 'access_pwd'];
  const kept = ['access_reqst_enddate', 'access_url'];
  const original = {
    id: 'access' as const, title: '접근 정보', imported: true,
    rows: [{ ...structuredClone(row), fields: [
      ...structuredClone(row.fields),
      ...[...hidden, ...kept].map((key) => ({ ...row.fields[0], id: `retired-${key}`, key, label: key })),
    ] }],
  };
  const section = visibleInstallationSection(original);
  assert.deepEqual(
    section.rows[0].fields.map((field) => field.key),
    [...row.fields.map((field) => field.key), ...kept],
  );
  assert.equal(original.rows[0].fields.length, row.fields.length + hidden.length + kept.length);
  const patch = prepareInstallationRow(section.rows[0], row.title!, { ct_etc: '새 비고' }, [], []);
  assert.deepEqual(patch.values, { ct_etc: '새 비고' });
  assert.deepEqual(patch.removeFields, []);
  assert.equal(installationFieldTemplates.access.some(([key]) => hidden.includes(key)), false);
  const otherSection = { ...original, id: 'sap' as const };
  assert.equal(visibleInstallationSection(otherSection), otherSection);
});

test('workspace protection disabled displays secret-classified fields when the server clears masking', () => {
  assert.equal(installationFieldMasked({ secret: true, masked: false }, false), false);
  assert.equal(installationFieldMasked({ secret: true, masked: true }, false), true);
  assert.equal(installationFieldMasked({ secret: false, masked: true }, false), true);
});

test('pending policy checks hide sensitive fields until the current policy is confirmed', () => {
  assert.equal(installationFieldMasked({ secret: true, masked: false }, true), true);
  assert.equal(installationFieldMasked({ secret: false, masked: false }, true), false);
});

test('editing another field preserves masked credentials and omits unchanged display values', () => {
  const payload = prepareInstallationRow(
    row,
    '합성 설치 기록',
    { setup_year: '2026', ct_etc: '새 합성 메모' },
    [],
    [],
  );
  assert.deepEqual(payload.values, { ct_etc: '새 합성 메모' });
  assert.equal(Object.hasOwn(payload.values!, 'os_root_pwd'), false);
  assert.equal(JSON.stringify(payload).includes('••'), false);
});

test('a masked value is cleared only through an explicit field change', () => {
  assert.deepEqual(prepareInstallationRow(row, '합성 설치 기록', {}, [], []).values, {});
  assert.deepEqual(prepareInstallationRow(row, '합성 설치 기록', { os_root_pwd: '' }, [], []).values, {
    os_root_pwd: '',
  });
});

test('removing a field cannot accidentally send its staged replacement in the same request', () => {
  const payload = prepareInstallationRow(
    row,
    '합성 설치 기록',
    { os_root_pwd: 'synthetic-only-replacement' },
    ['os_root_pwd'],
    [],
  );
  assert.deepEqual(payload.values, {});
  assert.deepEqual(payload.removeFields, ['os_root_pwd']);
});

test('managed installation metadata remains editable while row, title, and field structure are protected', () => {
  const metadata: InstallationDetailRow = {
    ...structuredClone(row),
    title: '설치 정보',
    managed: 'metadata',
  };
  assert.equal(installationRowCanDelete(metadata), false);
  assert.equal(installationRowCanDelete(row), true);
  const payload = prepareInstallationRow(metadata, '설치 정보', { setup_year: '2027' }, [], []);
  // Metadata PATCH accepts values only; even an unchanged title would be rejected by the server.
  assert.deepEqual(payload, { values: { setup_year: '2027' } });
  assert.equal(Object.hasOwn(payload, 'title'), false);
  assert.equal(Object.hasOwn(payload, 'removeFields'), false);
  assert.equal(Object.hasOwn(payload, 'addFields'), false);
  assert.throws(() => prepareInstallationRow(metadata, '설치 정보', {}, [], []), /변경한 기본 정보/);
  assert.throws(
    () => prepareInstallationRow(metadata, '설치 정보', { setup_year: '2026' }, [], []),
    /변경한 기본 정보/,
  );
  assert.throws(() => prepareInstallationRow(metadata, '새 이름', {}, [], []), /항목 구성/);
  assert.throws(() => prepareInstallationRow(metadata, '설치 정보', {}, ['setup_year'], []), /항목 구성/);
  assert.throws(
    () =>
      prepareInstallationRow(metadata, '설치 정보', {}, [], [{ key: 'new_key', label: '추가', value: '' }]),
    /항목 구성/,
  );
});

test('managed metadata requires its current revision and rejects unknown management modes', () => {
  const managed = details();
  managed.sections[0].rows[0].managed = 'metadata';
  assert.equal(validateInstallationDetails(managed, managed.id), false);
  assert.equal(validateInstallationDetails({ ...managed, metadataRevision: '' }, managed.id), false);
  assert.equal(
    validateInstallationDetails({ ...managed, metadataRevision: 'fixture-revision' }, managed.id),
    true,
  );
  const invalid = { ...managed, metadataRevision: 'fixture-revision' };
  Object.assign(invalid.sections[0].rows[0], { managed: 'unknown' });
  assert.equal(validateInstallationDetails(invalid, managed.id), false);
});

test('an installation list refresh updates the selected metadata without reopening or reverting selection', () => {
  const original = { id: 'installation-one', serviceVersion: '2025' };
  const another = { id: 'installation-two', serviceVersion: '2025' };
  const updated = { ...original, serviceVersion: '2026', engineer: '합성 엔지니어' };
  const refreshed = [updated, another];
  assert.equal(refreshedInstallationSelection(original, refreshed), updated);
  // The state updater receives the selection at response time, including a close or a switch during the request.
  assert.equal(refreshedInstallationSelection(null, refreshed), null);
  assert.equal(refreshedInstallationSelection(another, refreshed), another);
  assert.equal(refreshedInstallationSelection(original, [another]), null);
});

test('new field validation prevents duplicates, reserved keys, overlong payloads, and empty records', () => {
  assert.throws(
    () =>
      prepareInstallationRow(row, '새 이름', {}, [], [{ key: 'setup_year', label: '중복', value: '2025' }]),
    /같은 키/,
  );
  for (const key of ['constructor', 'prototype', '__proto__'])
    assert.throws(
      () => prepareInstallationRow(undefined, '새 기록', {}, [], [{ key, label: '합성 항목', value: '' }]),
      /이름과 키/,
    );
  assert.throws(
    () =>
      prepareInstallationRow(
        undefined,
        '새 기록',
        {},
        [],
        [{ key: 'text', label: '합성 항목', value: 'x'.repeat(16385) }],
      ),
    /16,384/,
  );
  assert.throws(() => prepareInstallationRow(undefined, '새 기록', {}, [], []), /1~80/);
});

test('malformed or cross-installation details never replace the current seven-tab view', () => {
  assert.equal(validateInstallationDetails(details(), 'installation-fixture'), true);
  assert.equal(validateInstallationDetails(details(), 'other-installation'), false);
  assert.equal(validateInstallationDetails(null, 'installation-fixture'), false);
  assert.equal(
    validateInstallationDetails({ ...details(), revision: undefined }, 'installation-fixture'),
    false,
  );
  const malformed = details();
  malformed.sections[1] = malformed.sections[0];
  assert.equal(validateInstallationDetails(malformed, 'installation-fixture'), false);
  const duplicated = details();
  duplicated.sections[1].rows = [structuredClone(row)];
  assert.equal(validateInstallationDetails(duplicated, 'installation-fixture'), false);
});

test('access notes are optional for older detail responses and validation preserves the response', () => {
  const legacy = Object.freeze(details());
  assert.equal(validateInstallationDetails(legacy, legacy.id), true);
  assert.equal(Object.hasOwn(legacy, 'accessNotes'), false);
  assert.equal(validNotes(undefined), true);
  assert.equal(validNotes([]), true);

  const response = { ...details(), accessNotes: [accessNote()] };
  const original = structuredClone(response);
  Object.freeze(response.accessNotes[0]);
  assert.equal(validateInstallationDetails(response, response.id), true);
  assert.deepEqual(response, original);
});

test('access notes accept canonical UTC timestamps, UUID versions, and correctly masked content', () => {
  assert.equal(validNotes([{ ...accessNote(), updatedAt: '2026-09-10T01:02:04.000Z' }]), true);
  assert.equal(validNotes([{ ...accessNote(), createdAt: '2024-02-29T00:00:00.000Z' }]), true);
  assert.equal(validNotes([{ ...accessNote(), content: '••••••••', masked: true }]), true);
  assert.equal(validNotes([{ ...accessNote(), content: 'x'.repeat(16384) }]), true);
  for (const version of ['1', '2', '3', '4', '5', '6', '7', '8'])
    assert.equal(
      validNotes([{ ...accessNote(), id: `ABCDEFAB-ABCD-${version}000-A000-ABCDEFABCDEF` }]),
      true,
    );
});

test('access note collections reject invalid shapes, excess entries, and case-insensitive duplicate UUIDs', () => {
  for (const notes of [null, {}, '', 0, false, [null], [[]], ['note']])
    assert.equal(validNotes(notes), false);

  const thousand = Array.from({ length: 1000 }, (_, index) => ({
    ...accessNote(),
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
  }));
  assert.equal(validNotes(thousand), true);
  assert.equal(
    validNotes([...thousand, { ...accessNote(), id: '00000000-0000-4000-8000-00000000abcd' }]),
    false,
  );
  assert.equal(validNotes([accessNote(), accessNote()]), false);
  assert.equal(
    validNotes([
      { ...accessNote(), id: 'abcdefab-abcd-4000-a000-abcdefabcdef' },
      { ...accessNote(), id: 'ABCDEFAB-ABCD-4000-A000-ABCDEFABCDEF' },
    ]),
    false,
  );
});

test('access notes reject invalid UUIDs, content, or missing masking flags', () => {
  for (const id of [
    undefined,
    '',
    123,
    'note-fixture',
    '00000000-0000-0000-8000-000000000001',
    '00000000-0000-9000-8000-000000000001',
    '00000000-0000-4000-7000-000000000001',
    '00000000-0000-4000-8000-000000000001 ',
  ])
    assert.equal(validNotes([{ ...accessNote(), id }]), false);

  for (const content of [undefined, null, 1, [], '', ' \n\t ', 'x'.repeat(16385), 'a\0b', '\uD800', '\uDC00'])
    assert.equal(validNotes([{ ...accessNote(), content }]), false);
  for (const masked of [undefined, null, 0, 1, 'false', 'true'])
    assert.equal(validNotes([{ ...accessNote(), masked }]), false);
  assert.equal(validNotes([{ ...accessNote(), masked: true }]), false);
});

test('access note timestamps reject calendar rollover, offsets, and noncanonical server formats', () => {
  for (const timestamp of [
    undefined,
    null,
    123,
    '',
    'invalid',
    '2026-02-30T01:02:03.004Z',
    '2026-02-29T01:02:03.004Z',
    '2026-13-01T01:02:03.004Z',
    '2026-09-10T24:00:00.000Z',
    '2026-09-10T01:02:60.000Z',
    '2026-09-10T01:02:03Z',
    '2026-09-10T01:02:03.00Z',
    '2026-09-10T01:02:03.0000Z',
    '2026-09-10T01:02:03.004+00:00',
    '2026-09-10T10:02:03.004+09:00',
    '2026-09-10T01:02:03.004',
    '2026-09-10',
    '2026-09-10T01:02:03.004z',
    ' 2026-09-10T01:02:03.004Z',
    '+002026-09-10T01:02:03.004Z',
  ]) {
    assert.equal(validNotes([{ ...accessNote(), createdAt: timestamp }]), false, String(timestamp));
    // An omitted updatedAt is valid; every present timestamp has the same strict contract.
    if (timestamp !== undefined)
      assert.equal(validNotes([{ ...accessNote(), updatedAt: timestamp }]), false, String(timestamp));
  }
});

test('attachment delete accepts 204 without attempting to parse JSON', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal(
    await installationRequest('/records/installations/fixture/attachments/file', { method: 'DELETE' }),
    undefined,
  );
});

test('a download response arriving after policy or installation changes is discarded before browser file creation', async (context) => {
  let release!: (value: Response) => void;
  let current = true;
  context.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const pending = downloadInstallationFile(
    '/records/installations/fixture/configuration',
    'fixture.yts',
    { method: 'POST' },
    () => current,
  );
  current = false;
  release(
    new Response('synthetic.setting=fixture', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
  );
  // No window or document is installed in this test: stale content must not reach download creation.
  assert.equal(await pending, false);
});


test('boolean controls keep canonical values and do not coerce unknown or three-choice fields', () => {
  for (const value of ['예', 'Y', 'true', '1']) assert.equal(installationBooleanChoice('autoUpdate', value)?.checked, true);
  for (const value of ['아니오', 'N', 'false', '0']) assert.equal(installationBooleanChoice('ssl_apply_yn', value)?.checked, false);
  assert.equal(installationBooleanChoice('autoUpdate', '')?.no, 'false');
  assert.equal(installationBooleanChoice('setting_yn', '예')?.yes, 'Y');
  assert.equal(installationBooleanChoice('bonding_yn', 'Yes'), null);
  assert.equal(installationBooleanChoice('setting_yn', '별도 확인'), null);
  assert.equal(installationBooleanChoice('yeta_id', 'true'), null);
});

test('tab editing collects all rows and notes, omits masked and retired fields, and preserves untouched tabs', () => {
  const snapshot = details() as import('../src/installation-types.ts').InstallationDetails;
  snapshot.sections[1].rows = [structuredClone(row), { ...structuredClone(row), id: 'second', fields: row.fields.map(f => ({ ...f, id: 'second-' + f.id })) }];
  snapshot.sections[0].rows = [];
  snapshot.sections[1].rows[0].fields.push({ ...row.fields[0], id: 'retired', key: 'access_pwd' });
  snapshot.accessNotes = [accessNote()];
  const original = structuredClone(snapshot);
  const changes = prepareInstallationSection(snapshot, 'access', {
    values: { 'field-year': '2027', 'second-field-note': '두 번째 기록 수정', retired: 'must-not-send' },
    titles: { second: '수정한 제목' }, notes: { [accessNote().id]: '수정한 참고사항' },
  });
  assert.equal(changes.length, 3);
  assert.deepEqual(changes[0].body.values, { setup_year: '2027' });
  assert.deepEqual(changes[1].body.values, { ct_etc: '두 번째 기록 수정' });
  assert.equal(changes[1].body.title, '수정한 제목');
  assert.equal(changes[2].kind, 'note');
  assert.equal(JSON.stringify(changes).includes('••'), false);
  assert.equal(JSON.stringify(changes).includes('must-not-send'), false);
  assert.deepEqual(snapshot, original);
  assert.deepEqual(prepareInstallationSection(snapshot, 'sap', { values: { 'field-year': '2028' }, titles: {}, notes: {} }), []);
  assert.throws(() => prepareInstallationSection(snapshot, 'access', { values: { 'field-year': '2028' }, titles: {}, notes: { [accessNote().id]: ' ' } }));
});
