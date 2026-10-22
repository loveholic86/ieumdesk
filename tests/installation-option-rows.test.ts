import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InstallationDetailField } from '../src/installation-types.ts';

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
