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

test('the access list shows exactly the five server columns and no end date', async () => {
  const source = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  const head = source.slice(
    source.indexOf('className="installation-data-table installation-access-list"'),
    source.indexOf('</thead>'),
  );
  for (const label of ['서버', '접근 유형', '도메인 URL', '외부 IP', '외부 PORT'])
    assert.match(head, new RegExp(`<th scope="col">\\{t\\('${label}'\\)\\}</th>`));
  // The end date column and the single connection-address column are both gone.
  assert.equal(head.includes("t('접근 종료일')"), false);
  assert.equal(head.includes("t('접속 주소')"), false);
  assert.equal((head.match(/<th scope="col">/g) ?? []).length, 5);
  const { accessListColumns } = await import('../src/installation-types.ts');
  assert.deepEqual(
    accessListColumns.map((column) => column.label),
    ['서버', '접근 유형', '도메인 URL', '외부 IP', '외부 PORT'],
  );
  // The detail and editor still carry the end date field itself.
  assert.match(source, /cardGroup\('period', '기간', 'access_reqst_date access_reqst_enddate'\)/);
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

test('the shared access remark is edited inside Edit information and saved on its own', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  // The separate entry is gone: the panel only reads, and points to the edit screen.
  assert.equal(view.includes("t('공통 정보 수정')"), false);
  assert.equal(view.includes('onEdit={() =>'), false);
  assert.match(view, /<h3>\{t\('설치 공통'\)\}<\/h3>/);
  assert.match(view, /t\('정보 수정에서 편집합니다\.'\)/);
  // The collapsible installation-wide remark lives at the bottom of the edit screen.
  assert.match(editor, /<details\s+className="installation-access-common-inline"/);
  assert.match(editor, /data-installation-common-section/);
  assert.match(editor, /t\('설치 전역 · 모든 서버에 공통'\)/);
  // The separate save button is gone: one «변경사항 저장» saves everything.
  assert.equal(editor.includes("'설치 공통 비고 저장'"), false);
  assert.equal(editor.includes('onSaveAccessCommon'), false);
  // The remark operation is appended last and targets the fresh response.
  assert.match(view, /changes\.push\(commonOperation\)/);
  assert.match(view, /prepareAccessCommonOperation\(/);
  assert.match(view, /case 'access-common':/);
  assert.match(view, /sendAccessCommon\(change\.draft, current, controller\.signal\)/);
  assert.match(view, /accessCommonDetails=\{visibleSectionEditing\.fullDetails/);
});

test('the access remark panel is already expanded when the edit screen mounts', async () => {
  const { InstallationAccessCommonSection } = await import('../src/InstallationSectionEditor.tsx');
  const rows: InstallationDetailRow[] = [
    {
      id: 'access-common',
      title: '설치 공통',
      fields: [{ ...field('common-etc', 'access_etc', '저장된 비고'), label: '접근 비고' }],
    },
  ];
  const markup = renderToStaticMarkup(
    createElement(InstallationAccessCommonSection, {
      rows,
      draft: { access_etc: '저장된 비고' },
      busy: false,
      policyPending: false,
      onChange: () => {},
    }),
  );
  // A collapsed <details> renders only its summary, which is what hid the remark on entry.
  const detailsTag = markup.slice(0, markup.indexOf('>') + 1);
  assert.match(detailsTag, /<details[^>]*\bopen\b/);
  assert.equal(markup.includes('설치 전역 · 모든 서버에 공통'), true);
  // The editor is usable straight away: the textarea and its value are rendered, not hidden.
  assert.match(markup, /<textarea/);
  assert.match(markup, /저장된 비고/);
  assert.match(markup, /설치 전체에 적용됩니다/);
});

test('the access remark panel can still be collapsed and reopened by the user', () => {
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  // The open state is bound, not forced, so the native summary still toggles it.
  assert.match(editor, /const \[open, setOpen\] = useState\(true\)/);
  assert.match(editor, /open=\{open\}/);
  assert.match(editor, /setOpen\(event\.currentTarget\.open\)/);
});

test('the end date stays editable in the detail and the editor, only the list column left', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  const labels = readFileSync(new URL('../src/installation-labels.ts', import.meta.url), 'utf8');
  // Detail card still groups the end date with the request dates.
  assert.match(view, /cardGroup\('period', '기간', 'access_reqst_date access_reqst_enddate'\)/);
  // The editor menu still lets the field be reached, under the renamed access remark group.
  assert.match(
    readFileSync(new URL('../src/installation-editor.ts', import.meta.url), 'utf8'),
    /group\('notes', '접근 비고', 'access_etc'\)/,
  );
  // The list column definition is the only place the end date was dropped.
  const { accessListColumns } = await import('../src/installation-types.ts');
  assert.equal(
    accessListColumns.some((column) => column.key === 'access_reqst_enddate'),
    false,
  );
  assert.equal(labels.includes("'access_reqst_enddate'"), false);
});

test('the installation-wide remark editor is as large as the other access fields', async () => {
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/installation-details.css', import.meta.url), 'utf8');
  // Six rows by default, sixteen when expanded, matching the other long field editors.
  assert.match(editor, /rows=\{expanded \? 16 : 6\}/);
  assert.match(editor, /t\('크게 편집'\)/);
  assert.match(editor, /'\{0\} \/ 16,384자\{1\}'/);
  assert.match(editor, /installation-access-common-textarea/);
  // The shared remark keeps the same field chrome (heading + counter) as other fields.
  assert.match(editor, /installation-inline-edit-field-heading/);
  assert.match(
    css,
    /\.installation-inline-editor \.installation-access-common-textarea,[\s\S]*?min-height: 260px;/,
  );
  assert.match(css, /\.installation-access-common-textarea \{[^}]*max-height: none;/s);
  assert.match(css, /\.installation-access-common-textarea \{[^}]*resize: vertical;/s);
  // It is no longer the small default textarea.
  assert.equal(
    /\.installation-access-common-inline-body textarea \{[^}]*min-height: 84px;/s.test(css),
    false,
  );
});

test('the merged save keeps the unscoped seed and the legacy in-place target', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  // Seeding still reads the unscoped details.
  assert.match(view, /accessCommonDetails=\{visibleSectionEditing\.fullDetails/);
  // The target is recomputed from the latest response on every save, for slot / legacy / create.
  assert.match(view, /accessCommonSaveTarget\(rows\)/);
  assert.match(view, /target\.kind === 'create'/);
  assert.match(view, /const rows = latest\.sections\.find/);
  // The remark is part of the one save plan, not a second button.
  assert.match(editor, /commonDirty \? 1 : 0/);
  assert.match(editor, /accessCommon: commonDraft/);
});

test('the server display name is edited once at the top of the access edit form', async () => {
  const source = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/installation-details.css', import.meta.url), 'utf8');
  // One server-level block, placed before the group layout.
  assert.match(source, /data-access-server-name/);
  assert.match(source, /t\('이 서버의 모든 항목에 함께 적용됩니다\.'\)/);
  const nameAt = source.indexOf('data-access-server-name');
  const layoutAt = source.indexOf('className="installation-group-layout"');
  assert.ok(nameAt > 0 && layoutAt > nameAt, 'display name block must sit above the group layout');
  // The per-row inputs are gone, so the name is not repeated for each part row.
  assert.equal((source.match(/\{t\('표시명'\)\}/g) ?? []).length, 1);
  assert.match(css, /\.installation-access-server-name \{/);
});

test('moving the display name keeps its save path and the shared-remark regressions', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/installation-client.ts', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  // displayName still travels as its own payload field, not as the stored title.
  assert.match(client, /displayName: normalizedDisplayName/);
  assert.match(view, /accessCommonDetails=\{visibleSectionEditing\.fullDetails/);
  assert.match(view, /accessCommonSaveTarget\(rows\)/);
  // The shared remark editor stays large.
  assert.match(editor, /rows=\{expanded \? 16 : 6\}/);
  assert.match(
    readFileSync(new URL('../src/installation-details.css', import.meta.url), 'utf8'),
    /min-height: 260px;/,
  );
});

test('the blue inset bar is gone from changed fields but their change state stays', () => {
  const css = readFileSync(new URL('../src/installation-editor.css', import.meta.url), 'utf8');
  const wrapper = css.slice(
    css.indexOf('.installation-group-content .installation-inline-edit-field {'),
    css.indexOf('.installation-group-content .installation-section-edit-title'),
  );
  // The wrapper resets both the bar and the rounded card in the base and changed states.
  assert.match(wrapper, /box-shadow: none;/);
  assert.match(wrapper, /border-radius: 0;/);
  assert.equal(wrapper.includes('inset 3px 0'), false);
  const changed = wrapper.slice(wrapper.indexOf('.is-changed'));
  assert.match(changed, /box-shadow: none;/);
  assert.match(changed, /border-radius: 0;/);
  assert.equal(changed.includes('inset 3px 0'), false);
  // The change is still visible through the input border and the badge.
  assert.match(wrapper, /\.is-changed input,[\s\S]*border-color:/);
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /t\(changed \? '변경됨' : '변경 예정'\)|'변경됨'/);
});

test('the shared remark joins the one save plan as its last operation', async () => {
  const client = readFileSync(new URL('../src/installation-client.ts', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  // The draft type carries the shared remark, so the save plan can pick it up.
  assert.match(client, /accessCommon\?: Record<string, string>/);
  assert.match(client, /kind: 'access-common'; draft: Record<string, string>/);
  // Appended after every row and note operation.
  const pushAt = view.indexOf('changes.push(commonOperation)');
  const prepareAt = view.indexOf('prepareInstallationSectionOperations(');
  assert.ok(prepareAt > 0 && pushAt > prepareAt);
  // A remark-only edit still enables the one save button and counts as a change.
  assert.match(editor, /\(commonDirty \? 1 : 0\)/);
  assert.match(editor, /useInstallationDirty\(count > 0 \|\| commonDirty\)/);
  // Partial failure and uncertain retry reuse the same plan path.
  assert.match(view, /일부 기록은 저장되었습니다/);
  assert.match(view, /return \{ uncertain: flow\.failure\.operation, confirmedDetails: flow\.latest \}/);
});

test('the group body can never paint an inset change bar for any field wrapper', () => {
  const css = readFileSync(new URL('../src/installation-editor.css', import.meta.url), 'utf8');
  const base = css.slice(
    css.indexOf(
      '.installation-group-content .installation-inline-edit-fields > .installation-inline-edit-field',
    ),
    css.indexOf('.installation-group-content .is-changed input'),
  );
  // Both the base and the changed state reset every bar source on the wrapper.
  assert.match(base, /box-shadow: none;/);
  assert.match(base, /border-radius: 0;/);
  assert.equal(/inset\s+\d/.test(base), false);
  assert.equal(base.includes('border-left:'), false);
  // The selector is stronger than the card rule in installation-record-editor.css, so load order
  // alone cannot bring the bar back.
  assert.match(base, /\.installation-inline-edit-fields > \.installation-inline-edit-field/);
  // Pseudo elements of the wrapper are neutralised too.
  assert.match(base, /::before[\s\S]*box-shadow: none;/);
  assert.match(base, /::after[\s\S]*box-shadow: none;/);
  // The change is still shown by the input border and the badge.
  assert.match(css, /\.installation-group-content \.is-changed input,[\s\S]*border-color:/);
});

test('a shared-remark-only change is listed in the review pane', async () => {
  const editor = readFileSync(new URL('../src/InstallationSectionEditor.tsx', import.meta.url), 'utf8');
  assert.match(editor, /\{sectionId === 'access' && commonDirty && \(/);
  assert.match(editor, /t\('접근 비고'\)\}\s*<\/dt>/);
  assert.match(editor, /t\('변경 예정'\)/);
});
