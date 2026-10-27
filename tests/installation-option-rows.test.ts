import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  InstallationAccessOriginPart,
  InstallationDetailField,
  InstallationDetailRow,
} from '../src/installation-types.ts';

register('./css-stub.mjs', import.meta.url);

function field(key: string, value = '값'): InstallationDetailField {
  return { id: key, key, label: key, value, secret: false, masked: false, present: true };
}

test('option rows render one cell per field and no pad cells', async () => {
  const { OptionTable } = await import('../src/InstallationDetails.tsx');
  const markup = renderToStaticMarkup(
    createElement(OptionTable, {
      sectionId: 'installation',
      policyPending: false,
      codeOptions: [],
      fields: [
        field('version'),
        field('setup_date'),
        field('patch_date'),
        field('engineer'),
        field('note', '메모'),
      ],
    }),
  );
  assert.equal(markup.includes('is-pad'), false);
  assert.equal(markup.includes('<dt></dt>'), false);
  const rows = markup.match(/class="installation-option-row(?: |")/g) ?? [];
  assert.equal(rows.length, 5);
  assert.equal(markup.includes('data-count'), false);
  assert.equal((markup.match(/class="installation-option-rows is-span"/g) ?? []).length, 1);

  const two = renderToStaticMarkup(
    createElement(OptionTable, {
      sectionId: 'installation',
      policyPending: false,
      codeOptions: [],
      fields: [field('system_code'), field('service_version')],
    }),
  );
  assert.equal((two.match(/class="installation-option-row(?: |")/g) ?? []).length, 2);
  assert.equal(two.includes('is-pad'), false);

  const single = renderToStaticMarkup(
    createElement(OptionTable, {
      sectionId: 'access',
      policyPending: false,
      codeOptions: [],
      fields: [field('external_ip', '203.0.113.10')],
    }),
  );
  assert.equal((single.match(/class="installation-option-row(?: |")/g) ?? []).length, 1);
  assert.equal(single.includes('is-pad'), false);
});

function rowRuns(markup: string) {
  return [...markup.matchAll(/<dl class="([^"]*)">([\s\S]*?)<\/dl>/g)].map((match) => ({
    span: match[1].includes('is-span'),
    rows: (match[2].match(/class="installation-option-row(?: |")/g) ?? []).length,
  }));
}

test('each compact run ends on its last pair and has no empty cells', async () => {
  const { OptionTable } = await import('../src/InstallationDetails.tsx');
  const markup = renderToStaticMarkup(
    createElement(OptionTable, {
      sectionId: 'installation',
      policyPending: false,
      codeOptions: [],
      fields: [field('version'), field('setup_date'), field('note', '메모'), field('engineer')],
    }),
  );
  assert.equal(markup.includes('is-pad'), false);
  assert.equal(markup.includes('<dt></dt>'), false);
  assert.deepEqual(rowRuns(markup), [
    { span: false, rows: 2 },
    { span: true, rows: 1 },
    { span: false, rows: 1 },
  ]);
  const four = renderToStaticMarkup(
    createElement(OptionTable, {
      sectionId: 'installation',
      policyPending: false,
      codeOptions: [],
      fields: [field('version'), field('setup_date'), field('patch_date'), field('engineer')],
    }),
  );
  assert.deepEqual(rowRuns(four), [{ span: false, rows: 4 }]);
  assert.equal(four.includes('is-pad'), false);
});

function originRow(
  part: InstallationAccessOriginPart,
  fields: InstallationDetailField[],
): InstallationDetailRow {
  return { id: part, origin: { group: 'a'.repeat(64), part }, fields };
}

test('an origin group reads as one server and keeps its VPN on the server', async () => {
  const { accessInstallationCommon, accessRecordItems, accessServerFields } =
    await import('../src/installation-client.ts');
  const address = originRow('address', [
    field('domainurl', 'legacy.example'),
    field('external_ip', '203.0.113.10'),
    field('ssl_apply_yn', '예'),
    { ...field('ssh_port', ''), present: false },
  ]);
  const vpn = originRow('vpn', [
    field('vpnsv_ip', '203.0.113.20'),
    field('vpnsv_id', 'ops'),
    field('vpnsv_pwd', '값'),
  ]);
  const access = originRow('access', [
    field('access_type', '원격'),
    field('access_url', 'https://example.test/gate'),
    field('rootpath', '/var/app'),
    field('access_reqst_enddate', '2026-12-31'),
    field('access_etc', '남김'),
  ]);
  const before = address.fields.map((item) => item.key);
  const items = accessRecordItems([address, vpn, access]);
  assert.deepEqual(
    before,
    address.fields.map((item) => item.key),
  );
  assert.equal(items.length, 1);
  assert.deepEqual(
    accessServerFields(items[0]?.rows ?? []).map((item) => item.key),
    [
      'domainurl',
      'external_ip',
      'ssl_apply_yn',
      'ssh_port',
      'vpnsv_ip',
      'vpnsv_id',
      'vpnsv_pwd',
      'access_type',
      'access_url',
      'rootpath',
      'access_reqst_enddate',
    ],
  );
  const common = accessInstallationCommon([address, vpn, access]);
  assert.equal(common.etc?.value, '남김');
  assert.equal(
    access.fields.some((item) => item.key === 'access_etc'),
    true,
  );
});

test('a card shares one label column and the copy button follows the value', async () => {
  const css = readFileSync(new URL('../src/installation-details.css', import.meta.url), 'utf8');
  const card = css.slice(css.indexOf('.installation-option-b .installation-kv'));
  assert.match(card, /\.installation-option-b \.installation-kv \{[^}]*--kv-label: 118px;/s);
  assert.match(card, /grid-template-columns: subgrid;/);
  assert.match(
    card,
    /grid-template-columns:\s*var\(--kv-label\)\s*minmax\(\s*0,\s*1fr\s*\)\s*var\(--kv-label\)\s*minmax\(\s*0,\s*1fr\s*\)\s*var\(--kv-label\)\s*minmax\(\s*0,\s*1fr\s*\);/s,
  );
  assert.equal(card.includes('minmax(118px, max-content)'), false);
  assert.equal(card.includes('auto !important'), false);
  const { OptionTable } = await import('../src/InstallationDetails.tsx');
  const markup = renderToStaticMarkup(
    createElement(OptionTable, {
      sectionId: 'access',
      policyPending: false,
      codeOptions: [],
      fields: [
        field('external_ip', '203.0.113.10'),
        field('ssh_port', '22'),
        field('access_etc', '첫째 줄\n둘째 줄'),
      ],
    }),
  );
  assert.equal((markup.match(/class="installation-kv"/g) ?? []).length, 1);
  const copied = markup.slice(markup.indexOf('external_ip'), markup.indexOf('ssh_port'));
  const valueAt = copied.indexOf('installation-field-value');
  const buttonAt = copied.indexOf('installation-copy-button');
  assert.ok(valueAt >= 0 && buttonAt > valueAt);
  const plain = markup.slice(markup.indexOf('ssh_port'), markup.indexOf('access_etc'));
  assert.equal(plain.includes('installation-copy-button'), false);
  assert.match(markup, /<dt><span>access_etc<\/span><\/dt>/);
});

test('protected vpn and note locks stay 12px outside option-b', async () => {
  const { OptionTable } = await import('../src/InstallationDetails.tsx');
  const markup = renderToStaticMarkup(
    createElement(OptionTable, {
      sectionId: 'access',
      policyPending: false,
      codeOptions: [],
      fields: [
        { ...field('vpnsv_ip', '203.0.113.20'), label: 'VPN 서버 IP', secret: true },
        { ...field('access_etc', '공통 비고'), label: '접근 비고', secret: true },
      ],
    }),
  );
  assert.equal(markup.includes('installation-option-b'), false);
  const locks = markup.match(/<svg class="installation-lock"[^>]*>/g) ?? [];
  assert.equal(locks.length, 2);
  for (const lock of locks) {
    assert.match(lock, /\bwidth="12"/);
    assert.match(lock, /\bheight="12"/);
  }
  const css = readFileSync(new URL('../src/installation-details.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /\.installation-access-common \.installation-lock \{[^}]*width:\s*12px;[^}]*height:\s*12px;/s,
  );
  const source = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  assert.match(source, /installation-data-card installation-option-b installation-access-common/);
  const browserAt = source.indexOf('className="installation-access-browser"');
  const panelAt = source.indexOf('<AccessCommonPanel');
  assert.ok(browserAt > 0 && panelAt > browserAt);
});

test('the access list shows domain URL, external IP, and external port columns', async () => {
  const source = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  const head = source.slice(
    source.indexOf('className="installation-data-table installation-access-list"'),
    source.indexOf('</thead>'),
  );
  for (const label of ['도메인 URL', '외부 IP', '외부 PORT', '접근 종료일'])
    assert.match(head, new RegExp(`<th scope="col">\\{t\\('${label}'\\)\\}</th>`));
  // The single connection-address column is gone.
  assert.equal(head.includes("t('접속 주소')"), false);
  assert.equal((head.match(/<th scope="col">/g) ?? []).length, 6);
  const { accessColumnField } = await import('../src/installation-client.ts');
  const rows: InstallationDetailRow[] = [
    {
      id: 'address-row',
      title: '접속 주소',
      fields: [
        field('domainurl', 'https://demo.example'),
        field('external_ip', '203.0.113.10'),
        field('ssh_port', '2222'),
      ],
    },
  ];
  assert.equal(accessColumnField(rows, 'domainurl')?.value, 'https://demo.example');
  assert.equal(accessColumnField(rows, 'external_ip')?.value, '203.0.113.10');
  assert.equal(accessColumnField(rows, 'ssh_port')?.value, '2222');
});

test('an empty access_url never hides a filled domain URL', async () => {
  const { accessColumnField } = await import('../src/installation-client.ts');
  const rows: InstallationDetailRow[] = [
    {
      id: 'address-row',
      title: '접속 주소',
      fields: [
        { ...field('empty-url', ''), present: false },
        field('domainurl', 'https://demo.example'),
        field('external_ip', '203.0.113.10'),
      ],
    },
    {
      id: 'access-row',
      title: '접근 정보',
      fields: [{ ...field('empty-access-url', ''), present: false }],
    },
  ];
  assert.equal(accessColumnField(rows, 'access_url'), undefined);
  assert.equal(accessColumnField(rows, 'domainurl')?.value, 'https://demo.example');
  assert.equal(accessColumnField(rows, 'external_ip')?.value, '203.0.113.10');
  // A masked value is a real value: it is shown as protected, not treated as empty.
  const masked: InstallationDetailRow = {
    id: 'masked-row',
    fields: [{ ...field('masked-url', '••••••••'), masked: true }],
  };
  assert.equal(accessColumnField([masked], 'masked-url')?.masked, true);
});

test('a server display name is stored apart from the part titles that group it', async () => {
  const { accessRecordLabel, accessRecordItems, accessServerFields } =
    await import('../src/installation-client.ts');
  const rows: InstallationDetailRow[] = [
    {
      id: 'address-row',
      title: '접속 주소',
      serverId: 'a'.repeat(32),
      displayName: '운영 1호기',
      fields: [field('domainurl', 'https://demo.example')],
    },
    {
      id: 'vpn-row',
      title: 'VPN',
      serverId: 'a'.repeat(32),
      displayName: '운영 1호기',
      fields: [field('vpnsv_ip', '203.0.113.20')],
    },
    {
      id: 'access-row',
      title: '접근 정보',
      serverId: 'a'.repeat(32),
      displayName: '운영 1호기',
      fields: [field('access_type', '원격')],
    },
  ];
  const items = accessRecordItems(rows);
  assert.equal(items.length, 1);
  assert.equal(accessRecordLabel(items[0].rows, '서버 1'), '운영 1호기');
  // The grouping titles are untouched, so display name editing cannot break the link.
  assert.deepEqual(
    items[0].rows.map((row) => row.title),
    ['접속 주소', 'VPN', '접근 정보'],
  );
  assert.deepEqual(
    accessServerFields(items[0].rows).map((item) => item.key),
    ['domainurl', 'vpnsv_ip', 'access_type'],
  );
  assert.equal(accessRecordLabel([{ id: 'bare' }], '서버 2'), '서버 2');
});
