import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accessInstallationCommon,
  accessRecordItems,
  accessServerFields,
  accessServerTitle,
  installationAccessEditingDetails,
  installationDetailsForAccessEdit,
  prepareInstallationSectionOperations,
  visibleInstallationSection,
} from '../src/installation-client.ts';
import type {
  InstallationAccessOriginPart,
  InstallationDetailField,
  InstallationDetailRow,
  InstallationDetails,
} from '../src/installation-types.ts';

const group = 'ab'.repeat(32);

function field(id: string, key: string, value: string, masked = false): InstallationDetailField {
  return { id, key, label: key, value, secret: masked, masked, present: value.length > 0 };
}

function originRow(
  part: InstallationAccessOriginPart,
  fields: InstallationDetailField[],
): InstallationDetailRow {
  return {
    id: `origin-${part}`,
    title: `이관 원본 ${part}`,
    origin: { group, part },
    fields,
  };
}

function details(rows: InstallationDetailRow[]): InstallationDetails {
  return {
    id: 'fixture',
    imported: true,
    revision: 4,
    sections: [{ id: 'access', title: '접근 정보', imported: true, rows }],
  };
}

const address = originRow('address', [field('url', 'access_url', 'https://legacy.example/gate')]);
const vpn = originRow('vpn', [
  field('vpn-user', 'vpnsv_id', 'kept-user'),
  field('vpn-host', 'vpnsv_ip', '203.0.113.20'),
  field('vpn-secret', 'vpnsv_pwd', '••••••••', true),
]);
const access = originRow('access', [field('end', 'access_reqst_enddate', '2026-12-31')]);
const current = {
  id: 'current-row',
  title: '단일 접속',
  fields: [field('current-url', 'access_url', 'https://current.example')],
} satisfies InstallationDetailRow;

test('one changed origin part patches only that row and omits its title', () => {
  const operations = prepareInstallationSectionOperations(
    details([address, vpn, access, current]),
    'access',
    {
      values: { 'vpn-user': 'next-user', 'vpn-host': '203.0.113.20' },
      titles: {
        [address.id]: '다른 Address 이름',
        [vpn.id]: '다른 VPN 이름',
        [access.id]: access.title!,
        [current.id]: current.title!,
      },
      notes: {},
    },
  );
  assert.equal(operations.length, 1);
  assert.equal(operations[0].kind, 'row-update');
  if (operations[0].kind !== 'row-update') return;
  assert.equal(operations[0].id, vpn.id);
  assert.equal(vpn.origin?.group, group);
  assert.equal(vpn.origin?.part, 'vpn');
  assert.equal('title' in operations[0].body, false);
  assert.deepEqual(operations[0].body.values, { vpnsv_id: 'next-user' });
  assert.deepEqual(operations[0].body.removeFields, []);
  assert.deepEqual(operations[0].body.addFields, []);
});

test('an origin title change and untouched rows produce no patch', () => {
  const operations = prepareInstallationSectionOperations(details([address, vpn, access]), 'access', {
    values: {},
    titles: { [vpn.id]: '읽기 전용 구분명은 저장하지 않음' },
    notes: {},
  });
  assert.deepEqual(operations, []);
});

test('a metadata row rejects a title change and a masked secret stays out until replaced', () => {
  const metadata: InstallationDetailRow = {
    id: 'meta',
    title: '설치 기본 정보',
    managed: 'metadata',
    fields: [field('code', 'systemCode', 'DEMO')],
  };
  assert.throws(
    () =>
      prepareInstallationSectionOperations(
        {
          id: 'fixture',
          imported: false,
          revision: 1,
          metadataRevision: 'c'.repeat(64),
          sections: [{ id: 'installation', title: '설치', imported: false, rows: [metadata] }],
        },
        'installation',
        { values: {}, titles: { meta: '다른 이름' }, notes: {} },
      ),
    /이름과 항목 구성은 변경할 수 없습니다/,
  );
  const untouchedSecret = prepareInstallationSectionOperations(details([vpn]), 'access', {
    values: {},
    titles: {},
    notes: {},
  });
  assert.deepEqual(untouchedSecret, []);
});

test('selected access edit keeps one normal record or one migrated group', () => {
  const full = details([address, vpn, access, current]);
  const normal = installationDetailsForAccessEdit(full, current.id);
  assert.deepEqual(
    normal.sections[0].rows.map((row) => row.id),
    [current.id],
  );
  const migrated = installationDetailsForAccessEdit(full, group);
  assert.deepEqual(
    migrated.sections[0].rows.map((row) => row.origin?.part),
    ['address', 'access'],
  );
  const otherGroup = 'cd'.repeat(32);
  const otherVpn = originRow('vpn', [field('other-vpn', 'vpnsv_ip', '198.51.100.8')]);
  otherVpn.id = 'other-vpn-row';
  otherVpn.origin = { group: otherGroup, part: 'vpn' };
  const twoGroups = installationDetailsForAccessEdit(details([address, vpn, access, otherVpn]), group);
  assert.deepEqual(
    twoGroups.sections[0].rows.map((row) => row.id),
    [address.id, access.id],
  );
  const alone = details([address, vpn, access]);
  assert.deepEqual(
    installationDetailsForAccessEdit(alone, group).sections[0].rows.map((row) => row.id),
    [address.id, access.id],
  );
  const installation = {
    id: 'install-row',
    title: '설치',
    fields: [field('code', 'systemCode', 'DEMO')],
  } satisfies InstallationDetailRow;
  const withInstallation: InstallationDetails = {
    ...full,
    sections: [
      { id: 'installation', title: '설치', imported: false, rows: [installation] },
      ...full.sections,
    ],
  };
  const scoped = installationDetailsForAccessEdit(withInstallation, current.id);
  assert.equal(scoped.sections[0], withInstallation.sections[0]);
  assert.deepEqual(
    scoped.sections[1].rows.map((row) => row.id),
    [current.id],
  );
  const created = { id: 'created-row', title: '추가 기록', fields: [field('created', 'domainurl', '')] };
  const duringEdit = installationAccessEditingDetails(
    {
      ...full,
      sections: [{ ...full.sections[0], rows: [...full.sections[0].rows, created] }],
    },
    [current.id],
    full.sections[0].rows.map((row) => row.id),
  );
  assert.deepEqual(
    duringEdit.sections[0].rows.map((row) => row.id),
    [current.id, created.id],
  );
});

test('saving a selection patches only that selection changed rows', () => {
  const full = details([address, vpn, access, current]);
  const normal = prepareInstallationSectionOperations(
    installationDetailsForAccessEdit(full, current.id),
    'access',
    { values: { 'current-url': 'https://next.example', 'vpn-user': 'ignored' }, titles: {}, notes: {} },
  );
  assert.equal(normal.length, 1);
  assert.equal(normal[0].kind, 'row-update');
  if (normal[0].kind !== 'row-update') return;
  assert.equal(normal[0].id, current.id);
  assert.deepEqual(normal[0].body.values, { access_url: 'https://next.example' });

  const migrated = prepareInstallationSectionOperations(
    installationDetailsForAccessEdit(full, group),
    'access',
    {
      values: { 'vpn-user': 'next-user', end: '2027-01-31', 'current-url': 'https://ignored.example' },
      titles: { [vpn.id]: '읽기 전용', [address.id]: '읽기 전용' },
      notes: {},
    },
  );
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].kind, 'row-update');
  if (migrated[0].kind !== 'row-update') return;
  assert.equal(migrated[0].id, access.id);
  assert.equal('title' in migrated[0].body, false);
  assert.deepEqual(migrated[0].body.values, { access_reqst_enddate: '2027-01-31' });

  const bothParts = prepareInstallationSectionOperations(
    installationDetailsForAccessEdit(full, group),
    'access',
    {
      values: { url: 'https://legacy.example/next', 'vpn-host': '198.51.100.20' },
      titles: {},
      notes: {},
    },
  );
  assert.deepEqual(
    bothParts.map((operation) => (operation.kind === 'row-update' ? operation.id : operation.kind)),
    [address.id],
  );
  assert.equal(
    bothParts.every((operation) => operation.kind === 'row-update' && !('title' in operation.body)),
    true,
  );

  const wholeInstallation = prepareInstallationSectionOperations(
    {
      id: 'fixture',
      imported: false,
      revision: 1,
      sections: [
        {
          id: 'installation',
          title: '설치',
          imported: false,
          rows: [{ id: 'install-row', title: '설치', fields: [field('code', 'systemCode', 'DEMO')] }],
        },
        full.sections[0],
      ],
    },
    'installation',
    { values: { code: 'NEXT' }, titles: {}, notes: {} },
  );
  assert.equal(wholeInstallation.length, 1);
  if (wholeInstallation[0].kind !== 'row-update') return;
  assert.equal(wholeInstallation[0].id, 'install-row');
  assert.deepEqual(wholeInstallation[0].body.values, { systemCode: 'NEXT' });
});

test('installation detail keeps one footer edit entry and no per-record edit mode', () => {
  const source = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes("mode: 'edit'"), false);
  assert.equal(source.includes("t('{0} 수정'"), false);
  assert.equal(source.includes("t('정보 수정')"), true);
  assert.equal(
    source.includes('setSectionEditing({ scopeKey, sectionId: tab, details: visibleDetails })'),
    true,
  );
  assert.equal(source.includes('installationDetailsForAccessEdit'), true);
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  assert.equal(editor.includes('accessOriginGroupLabel(row)'), false);
  assert.equal(editor.includes('기존 접근 정보'), false);
  assert.equal(source.includes('기존 접근 정보'), false);
  assert.equal(source.includes('서버 추가'), true);
  assert.equal(source.includes('accessInstallationCommon'), true);
  assert.equal(editor.includes("t('{0} 수정', [t(label)])"), false);
  assert.equal(editor.includes('matches(field, Boolean(row.origin))'), false);
  assert.equal(editor.includes('installationEditorGroupVisible'), true);
});

test('retired access controls stay stored and leave the visible section', () => {
  const section = {
    id: 'access' as const,
    title: '접근 정보',
    imported: false,
    rows: [
      {
        id: 'row-1',
        title: '접근',
        fields: [
          field('url', 'domainurl', 'https://demo.example'),
          field('login', 'access_id', 'kept-id'),
          field('secret', 'access_pwd', 'kept-secret'),
          field('requested', 'access_reqst_date', '2026-01-01'),
          field('gate', 'access_url', 'https://demo.example/gate'),
        ],
      },
    ],
  };
  const visible = visibleInstallationSection(section);
  assert.deepEqual(
    visible.rows[0]?.fields.map((item) => item.key),
    ['domainurl', 'access_url'],
  );
  const listed = accessRecordItems(section.rows);
  assert.deepEqual(
    listed[0]?.rows[0]?.fields.map((item) => item.key),
    ['domainurl', 'access_url'],
  );
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  assert.match(view, /access_type access_url domainurl access_id access_pwd/);
  assert.match(view, /access_reqst_date access_reqst_enddate/);
  assert.deepEqual(
    section.rows[0]?.fields.map((item) => item.key),
    ['domainurl', 'access_id', 'access_pwd', 'access_reqst_date', 'access_url'],
  );
  const retiredOnly = visibleInstallationSection({
    ...section,
    rows: [
      {
        ...section.rows[0],
        fields: section.rows[0].fields.filter(
          (item) => item.key !== 'domainurl' && item.key !== 'access_url',
        ),
      },
    ],
  });
  assert.deepEqual(retiredOnly.rows, []);
  assert.deepEqual(
    accessRecordItems([
      {
        ...section.rows[0],
        fields: section.rows[0].fields.filter(
          (item) => item.key !== 'domainurl' && item.key !== 'access_url',
        ),
      },
    ]),
    [],
  );
  const server = { id: 'server' as const, title: '서버', imported: false, rows: section.rows };
  assert.equal(visibleInstallationSection(server), server);
});

test('an origin group reads as one server and lifts VPN without rewriting rows', () => {
  const rows = [address, vpn, access];
  const items = accessRecordItems(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, group);
  assert.equal(items[0]?.index, 1);
  assert.equal(accessServerTitle(items[0]?.rows ?? []), '');
  assert.deepEqual(
    accessServerFields(items[0]?.rows ?? []).map((item) => item.key),
    ['access_url', 'access_reqst_enddate'],
  );
  const common = accessInstallationCommon(rows);
  assert.deepEqual(
    common.vpn.map((item) => item.key),
    ['vpnsv_ip', 'vpnsv_id', 'vpnsv_pwd'],
  );
  assert.equal(common.held.length, 0);
  assert.equal(common.etc, undefined);
  assert.deepEqual(
    rows.map((row) => row.origin?.part),
    ['address', 'vpn', 'access'],
  );
});

test('adjacent address and access rows without an origin stay separate servers', () => {
  const addressOnly = {
    id: 'near-address',
    title: '접속 주소',
    fields: [field('domain', 'domainurl', 'https://a.example')],
  } satisfies InstallationDetailRow;
  const accessOnly = {
    id: 'near-access',
    title: '접근 정보',
    fields: [field('kind', 'access_type', '원격'), field('note', 'access_etc', '첫째 비고')],
  } satisfies InstallationDetailRow;
  const items = accessRecordItems([addressOnly, accessOnly]);
  assert.deepEqual(
    items.map((item) => item.id),
    ['near-address', 'near-access'],
  );
  assert.deepEqual(
    accessServerFields(items[1]?.rows ?? []).map((item) => item.key),
    ['access_type'],
  );
  assert.equal(accessInstallationCommon([addressOnly, accessOnly]).etc?.value, '첫째 비고');
  assert.equal(
    accessOnly.fields.some((item) => item.key === 'access_etc'),
    true,
  );
});

test('conflicting VPN rows are held and the first access remark is the shared candidate', () => {
  const first = {
    id: 'vpn-a',
    title: 'VPN A',
    fields: [field('ip-a', 'vpnsv_ip', '203.0.113.10')],
  } satisfies InstallationDetailRow;
  const second = {
    id: 'vpn-b',
    title: 'VPN B',
    fields: [field('ip-b', 'vpnsv_ip', '203.0.113.11')],
  } satisfies InstallationDetailRow;
  const etcA = {
    id: 'etc-a',
    title: '운영',
    fields: [field('etc-a', 'access_etc', '첫째'), field('domain', 'domainurl', 'https://a.example')],
  } satisfies InstallationDetailRow;
  const etcB = {
    id: 'etc-b',
    title: '검증',
    fields: [field('etc-b', 'access_etc', '둘째'), field('domain-b', 'domainurl', 'https://b.example')],
  } satisfies InstallationDetailRow;
  const rows = [first, second, etcA, etcB];
  assert.deepEqual(
    accessRecordItems(rows).map((item) => item.id),
    ['etc-a', 'etc-b'],
  );
  const common = accessInstallationCommon(rows);
  assert.equal(common.vpn.length, 0);
  assert.deepEqual(
    common.held.map((item) => item.id),
    ['vpn-a', 'vpn-b'],
  );
  assert.equal(common.etc?.value, '첫째');
  assert.equal(
    etcB.fields.some((item) => item.key === 'access_etc'),
    true,
  );
});

test('matching VPN rows keep the first value and an explicit common slot wins', () => {
  const first = {
    id: 'vpn-a',
    title: 'VPN A',
    fields: [field('ip-a', 'vpnsv_ip', '203.0.113.10'), field('user-a', 'vpnsv_id', 'ops')],
  } satisfies InstallationDetailRow;
  const second = {
    id: 'vpn-b',
    title: 'VPN B',
    fields: [field('ip-b', 'vpnsv_ip', '203.0.113.10'), field('user-b', 'vpnsv_id', 'ops')],
  } satisfies InstallationDetailRow;
  const agreed = accessInstallationCommon([first, second]);
  assert.equal(agreed.vpn.find((item) => item.key === 'vpnsv_ip')?.id, 'ip-a');
  assert.equal(agreed.held.length, 0);
  const slot = {
    id: 'access-common',
    title: '설치 공통',
    fields: [field('slot-ip', 'vpnsv_ip', '198.51.100.8')],
  } satisfies InstallationDetailRow;
  const explicit = accessInstallationCommon([first, slot]);
  assert.equal(explicit.vpn.find((item) => item.key === 'vpnsv_ip')?.value, '198.51.100.8');
  assert.equal(explicit.held.length, 0);
  assert.equal(accessRecordItems([first, second, slot]).length, 0);
});
