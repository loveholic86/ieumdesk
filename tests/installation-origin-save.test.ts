import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareInstallationSectionOperations } from '../src/installation-client.ts';
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

test('installation detail keeps one footer edit entry and no per-record edit mode', () => {
  const source = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes("mode: 'edit'"), false);
  assert.equal(source.includes("t('{0} 수정'"), false);
  assert.equal(source.includes("t('정보 수정')"), true);
  assert.equal(
    source.includes('setSectionEditing({ scopeKey, sectionId: tab, details: visibleDetails })'),
    true,
  );
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  assert.equal(editor.includes('accessOriginGroupLabel(row)'), true);
  assert.equal(editor.includes("t('{0} 수정', [t(label)])"), false);
});
