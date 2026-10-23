import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InstallationAccessOriginPart, InstallationDetailField, InstallationDetailRow } from '../src/installation-types.ts';

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
      fields: [field('version'), field('setup_date'), field('patch_date'), field('engineer'), field('note', '메모')],
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

function originRow(part: InstallationAccessOriginPart, fields: InstallationDetailField[]): InstallationDetailRow {
  return { id: part, origin: { group: 'a'.repeat(64), part }, fields };
}

test('migrated access view packs Address and VPN together and keeps wide rows last', async () => {
  const { migratedAccessViewBlocks } = await import('../src/InstallationDetails.tsx');
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
  ]);
  const before = address.fields.map((item) => item.key);
  const blocks = migratedAccessViewBlocks([address, vpn, access], false);
  assert.deepEqual(before, address.fields.map((item) => item.key));
  assert.deepEqual(
    blocks.map((block) => block.titles),
    [['Address', 'VPN'], ['접근 정보']],
  );
  assert.deepEqual(
    blocks[0].fields.map((item) => item.key),
    ['external_ip', 'ssl_apply_yn', 'vpnsv_ip', 'vpnsv_id', 'vpnsv_pwd', 'domainurl'],
  );
  assert.deepEqual(
    blocks[1].fields.map((item) => item.key),
    ['access_type', 'access_reqst_enddate', 'access_url', 'rootpath'],
  );
  assert.deepEqual(
    migratedAccessViewBlocks([address], true)[0].fields.map((item) => item.key),
    ['ssh_port', 'external_ip', 'ssl_apply_yn', 'domainurl'],
  );
});
