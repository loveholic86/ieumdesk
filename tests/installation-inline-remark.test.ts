import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  inlineRemarkDirty,
  inlineRemarkKeyAction,
  inlineRemarkMasked,
  inlineRemarkMaxLength,
  inlineRemarkMultiline,
  inlineRemarkPreview,
  inlineRemarkReduce,
  installationInlineRemarkField,
  installationInlineRemarkPlan,
} from '../src/installation-inline-remark.ts';
import { accessCommonRowId } from '../src/installation-types.ts';
import type { InstallationDetailField, InstallationDetailRow } from '../src/installation-types.ts';

register('./css-stub.mjs', import.meta.url);

function field(
  id: string,
  key: string,
  value: string,
  extra: Partial<InstallationDetailField> = {},
): InstallationDetailField {
  return { id, key, label: key, value, secret: false, masked: false, present: Boolean(value), ...extra };
}

const row = (id: string, fields: InstallationDetailField[], extra = {}): InstallationDetailRow => ({
  id,
  title: id,
  fields,
  ...extra,
});

function detailsFixture(installationRows: InstallationDetailRow[], accessRows: InstallationDetailRow[] = []) {
  return {
    id: 'fixture',
    imported: false,
    revision: 7,
    metadataRevision: 'a'.repeat(64),
    sections: (
      [
        ['installation', installationRows],
        ['access', accessRows],
        ['server', []],
        ['yeta', []],
        ['sap', []],
        ['settings', []],
        ['files', []],
      ] as const
    ).map(([id, rows]) => ({ id, title: id, imported: false, rows })),
  };
}

test('only the four phase-1 remark keys are inline editable, and only in their own tab', () => {
  for (const key of ['note', 'ct_etc', 'setup_etc'])
    assert.equal(installationInlineRemarkField('installation', { key }), true, key);
  // 접근 비고 belongs to the access tab's shared slot, never to a server row or the installation tab.
  assert.equal(installationInlineRemarkField('access', { key: 'access_etc' }), true);
  assert.equal(installationInlineRemarkField('installation', { key: 'access_etc' }), false);
  // Everything outside phase 1 stays in the full 「정보 수정」 form.
  for (const key of ['domain', 'domainurl', 'external_ip', 'hostname', 'systemCode', 'access_type'])
    for (const section of ['installation', 'access'] as const)
      assert.equal(installationInlineRemarkField(section, { key }), false, `${section}:${key}`);
  // A remark-shaped key in another tab is not part of this phase either.
  for (const key of ['os_login_etc', 'setting_etc', 'etc'])
    for (const section of ['access', 'sap', 'settings', 'server'] as const)
      assert.equal(installationInlineRemarkField(section, { key }), false, `${section}:${key}`);
  // Masked/secret fields are excluded by key, so a secret can never ride in on this path.
  assert.equal(installationInlineRemarkField('access', { key: 'os_root_pwd' }), false);
});

test('the key contract follows Park/Chakra: Esc cancels, Enter saves a line, ⌘/Ctrl+Enter saves a textarea', () => {
  const base = { multiline: false, modifier: false, composing: false };
  assert.equal(inlineRemarkKeyAction({ ...base, key: 'Escape' }), 'cancel');
  assert.equal(inlineRemarkKeyAction({ ...base, key: 'Enter' }), 'commit');
  assert.equal(inlineRemarkKeyAction({ ...base, key: 'Enter', multiline: true }), 'newline');
  assert.equal(inlineRemarkKeyAction({ ...base, key: 'Enter', multiline: true, modifier: true }), 'commit');
  // Other keys, and every IME composition, are left to the browser.
  assert.equal(inlineRemarkKeyAction({ ...base, key: 'a' }), 'ignore');
  assert.equal(inlineRemarkKeyAction({ ...base, key: 'Enter', composing: true }), 'ignore');
  assert.equal(inlineRemarkKeyAction({ ...base, key: 'Escape', composing: true }), 'ignore');
  assert.equal(inlineRemarkKeyAction({ ...base, key: 'Enter', multiline: true, composing: true }), 'ignore');
});

test('Escape reverts to the text the session opened with and never sends an API call', () => {
  let state = inlineRemarkPreview('기존 비고');
  state = inlineRemarkReduce(state, { type: 'open', baseline: state.baseline }).state;
  assert.equal(state.phase, 'editing');
  assert.equal(state.draft, '기존 비고');
  state = inlineRemarkReduce(state, { type: 'input', draft: '지우고 새로 쓴 비고' }).state;
  const escaped = inlineRemarkReduce(state, { type: 'escape' });
  assert.equal(escaped.send, undefined);
  assert.equal(escaped.state.phase, 'preview');
  assert.equal(escaped.state.draft, '기존 비고');
  // The blur that the browser fires after Escape is swallowed, so nothing is sent later either.
  assert.equal(inlineRemarkReduce(escaped.state, { type: 'confirm', stored: '기존 비고' }).send, undefined);
});

test('Enter and blur send exactly one value, and a repeat cannot send a second request', () => {
  const opened = inlineRemarkReduce(inlineRemarkPreview('기존 비고'), {
    type: 'open',
    baseline: '기존 비고',
  }).state;
  const typed = inlineRemarkReduce(opened, { type: 'input', draft: '  줄바꿈\n비고  ' }).state;
  // Whitespace is the user's text: the draft is sent verbatim, never trimmed behind their back.
  const committed = inlineRemarkReduce(typed, { type: 'confirm', stored: '기존 비고' });
  assert.equal(committed.send, '  줄바꿈\n비고  ');
  assert.equal(committed.state.phase, 'saving');
  // Enter and the trailing blur both arrive; only the first one may send.
  assert.equal(inlineRemarkReduce(committed.state, { type: 'confirm', stored: '기존 비고' }).send, undefined);
  assert.equal(inlineRemarkReduce(committed.state, { type: 'settled' }).state.phase, 'preview');
});

test('a blur with no change closes without a request, and an empty draft is a real change', () => {
  const opened = inlineRemarkReduce(inlineRemarkPreview('기존 비고'), {
    type: 'open',
    baseline: '기존 비고',
  }).state;
  const unchanged = inlineRemarkReduce(opened, { type: 'confirm', stored: '기존 비고' });
  assert.equal(unchanged.send, undefined);
  assert.equal(unchanged.state.phase, 'preview');
  // Remarks may be cleared on purpose.
  const cleared = inlineRemarkReduce(opened, { type: 'input', draft: '' });
  assert.equal(inlineRemarkReduce(cleared.state, { type: 'confirm', stored: '기존 비고' }).send, '');
});

test('a protected remark keeps its stored value unless something is typed', () => {
  const opened = inlineRemarkReduce(inlineRemarkPreview('', true), {
    type: 'open',
    baseline: '',
    masked: true,
  }).state;
  // The mask is not text, so an untouched protected field is never rewritten with an empty string.
  assert.equal(inlineRemarkReduce(opened, { type: 'confirm', stored: '••••••••' }).send, undefined);
  const typed = inlineRemarkReduce(opened, { type: 'input', draft: '새 보호 비고' }).state;
  assert.equal(inlineRemarkReduce(typed, { type: 'confirm', stored: '••••••••' }).send, '새 보호 비고');
});

test('only one session can be open, and a saving session cannot be reopened', () => {
  const opened = inlineRemarkReduce(inlineRemarkPreview('기존'), { type: 'open', baseline: '기존' }).state;
  // A second field asking to open while this one edits must not silently replace the draft.
  const second = inlineRemarkReduce(opened, { type: 'open', baseline: '다른 값' });
  assert.equal(second.state, opened);
  const saving = inlineRemarkReduce(
    inlineRemarkReduce(opened, { type: 'input', draft: '저장할 값' }).state,
    { type: 'confirm', stored: '기존' },
  ).state;
  assert.equal(inlineRemarkReduce(saving, { type: 'open', baseline: '다른 값' }).state, saving);
  // Typing during a save cannot alter the value already sent.
  assert.equal(inlineRemarkReduce(saving, { type: 'input', draft: '늦은 입력' }).state, saving);
});

test('a blur without a change never saves, and an empty draft clears only an unprotected remark', () => {
  const stored = field('f-note', 'note', '기존 비고');
  assert.equal(inlineRemarkDirty(stored, '기존 비고', false), false);
  assert.equal(inlineRemarkDirty(stored, '고친 비고', false), true);
  // Remarks may be emptied on purpose.
  assert.equal(inlineRemarkDirty(stored, '', false), true);
  // A protected value is never compared against the mask: blank keeps it, any text replaces it.
  const masked = { ...stored, masked: true, secret: true };
  assert.equal(inlineRemarkMasked(masked, false), true);
  assert.equal(inlineRemarkDirty(masked, '', false), false);
  assert.equal(inlineRemarkDirty(masked, '새 값', false), true);
  // A pending protection policy behaves like a masked secret until it resolves.
  assert.equal(inlineRemarkDirty({ ...stored, secret: true }, '', true), false);
});

test('remarks always use a textarea, and `note` keeps the record field limit', () => {
  for (const key of ['note', 'ct_etc', 'setup_etc', 'access_etc'])
    assert.equal(inlineRemarkMultiline({ key }), true, key);
  assert.equal(inlineRemarkMultiline({ key: 'domain' }), false);
  assert.equal(inlineRemarkMaxLength({ key: 'note' }), 10_000);
  assert.equal(inlineRemarkMaxLength({ key: 'access_etc' }), 16_384);
});

test('the plan sends exactly one key on the row that actually holds it', () => {
  const note = field('f-note', 'note', '기존 비고');
  const metadata = row('metadata-row', [note, field('f-code', 'systemCode', 'DEMO')], {
    managed: 'metadata' as const,
  });
  const etc = field('f-ct', 'ct_etc', '고객사 비고');
  const plain = row('workspace-row-1', [etc]);
  const details = detailsFixture([metadata, plain]);

  // A managed metadata row is saved through the metadata path with its own fingerprint.
  assert.deepEqual(installationInlineRemarkPlan(details, 'installation', note, '새 비고', false), {
    kind: 'metadata',
    rowId: 'metadata-row',
    values: { note: '새 비고' },
  });
  // An ordinary workspace row keeps the plain row PATCH, and the payload carries only that key.
  assert.deepEqual(installationInlineRemarkPlan(details, 'installation', etc, '새 고객사 비고', false), {
    kind: 'row',
    rowId: 'workspace-row-1',
    values: { ct_etc: '새 고객사 비고' },
  });
  // An unchanged draft is not a save, so a blur on the same text sends nothing.
  assert.equal(installationInlineRemarkPlan(details, 'installation', note, '기존 비고', false), undefined);
  // A field this phase does not cover is refused even when a caller asks for it.
  const domain = field('f-domain', 'domain', 'service.example.com');
  assert.equal(installationInlineRemarkPlan(details, 'installation', domain, 'other.example.com', false), undefined);
});

test('접근 비고 always targets the installation-wide slot, never a server row', () => {
  const etc = field('f-access-etc', 'access_etc', '저장된 접근 비고');
  const serverRow = row('workspace-row-server', [etc]);
  const sharedRow = row(accessCommonRowId, [field('f-common', 'access_etc', '공통 비고')]);
  const details = detailsFixture([], [serverRow, sharedRow]);

  // The shared slot exists: the write lands there even though the field came from a server row.
  assert.deepEqual(installationInlineRemarkPlan(details, 'access', etc, '고친 공통 비고', false), {
    kind: 'row',
    rowId: accessCommonRowId,
    values: { access_etc: '고친 공통 비고' },
  });

  // No slot yet but a legacy server row already holds the remark: update it in place, never re-create.
  const legacyOnly = detailsFixture([], [serverRow]);
  assert.deepEqual(installationInlineRemarkPlan(legacyOnly, 'access', etc, '고친 공통 비고', false), {
    kind: 'row',
    rowId: 'workspace-row-server',
    values: { access_etc: '고친 공통 비고' },
  });

  // Nothing stored anywhere: the first save creates the shared row instead of touching a server.
  const emptyDetails = detailsFixture([], [row('workspace-row-server', [field('f-ip', 'vpnsv_ip', '203.0.113.20')])]);
  assert.deepEqual(
    installationInlineRemarkPlan(emptyDetails, 'access', field('f-new', 'access_etc', ''), '첫 공통 비고', false),
    {
      kind: 'access-common-create',
      title: '설치 공통',
      fields: [{ key: 'access_etc', label: '접근 비고', value: '첫 공통 비고' }],
    },
  );
});

test('an inline edit is offered in the read card and replaces the 「정보 수정」 hint', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  const editable = readFileSync(new URL('../src/InstallationEditable.tsx', import.meta.url), 'utf8');
  // The card renders the Editable from the shared context, so one screen has one open session.
  assert.match(view, /useInstallationInlineRemark\(\)/);
  assert.match(view, /<InstallationEditable/);
  assert.match(view, /installationInlineRemarkField\(sectionId, field\)/);
  assert.match(view, /<InstallationInlineRemarkProvider value=\{inlineRemarks\}>/);
  // Only one field id can be open at a time, and it is cleared on scope changes.
  assert.match(view, /openFieldId: editingActive \|\| policyPending \? '' : inlineFieldId/);
  assert.match(view, /setInlineFieldId\(''\)/);
  // The hint that pushed the user into the full form is gone.
  assert.equal(view.includes("'정보 수정에서 편집합니다.'"), false);
  // The full form is still reachable: it is a parallel path, never replaced.
  assert.match(view, /t\('정보 수정'\)/);
  assert.match(view, /InstallationSectionEditor/);
  // A preview is a real button with the field label, and the input carries the edit label.
  assert.match(editable, /aria-label=\{t\('\{0\} 수정', \[label\]\)\}/);
  assert.match(editable, /'aria-label': t\('\{0\} 편집', \[label\]\)/);
  // Esc must stop at the field: the dialog closes on Escape too.
  assert.match(editable, /event\.stopPropagation\(\)/);
});

test('a section editor being open turns inline editing off for its tab', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  // The permission flag is withdrawn while any edit surface is open, so a second draft cannot fight it.
  assert.match(view, /canEdit: canManage && !editingActive && !policyPending && Boolean\(visibleDetails\)/);
  assert.match(view, /openFieldId: editingActive \|\| policyPending \? '' : inlineFieldId/);
});

test('the preview renders read-only text without a button when the provider is absent', async () => {
  const { default: InstallationEditable } = await import('../src/InstallationEditable.tsx');
  const markup = renderToStaticMarkup(
    createElement(InstallationEditable, {
      field: field('f-access', 'access_etc', '저장된 접근 비고'),
      sectionId: 'access' as const,
      label: '접근 비고',
      masked: false,
    }),
  );
  // No provider means no write permission path: the value is plain text, never an interactive control.
  assert.equal(markup.includes('<button'), false);
  assert.match(markup, /is-readonly/);
  assert.match(markup, /저장된 접근 비고/);
  assert.equal(markup.includes('설치 정보 탭'), false);
});

test('the access remark panel shows a clickable remark even before one is stored', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  // The shared panel no longer hides the field when empty: adding the first remark must be possible.
  assert.match(view, /const field: InstallationDetailField = common\.etc \?\? \{/);
  assert.match(view, /<OptionTable\s+fields=\{\[field\]\}/);
});

test('queued inline saves send the revision the previous save returned', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  // One queue owns both the tail promise and the details, so a save cannot read a stale closure.
  assert.match(view, /const inlineQueue = useRef<\{ tail: Promise<void>; details: VersionedDetails \| null \}>/);
  assert.match(view, /const latest = inlineQueue\.current\.details;/);
  // The returned details replace the queued baseline, so the next save is not a stale write.
  assert.match(view, /inlineQueue\.current\.details = result;/);
  // A newer render may only move the baseline forward, never back to an already-used revision.
  assert.match(view, /inlineQueue\.current\.details\.revision <= visibleDetails\.revision/);
  // Saves are chained, not dropped, so a handover mid-save still commits the first remark.
  assert.match(view, /const queued = inlineQueue\.current\.tail\.then\(send, send\);/);
  assert.match(view, /inlineQueue\.current\.tail = queued\.then\(/);
});

test('a stale revision tells the user and re-reads instead of resending', async () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../src/installation-api.ts', import.meta.url), 'utf8');
  // The API error exposes the server code so a conflict is distinguishable from any other rejection.
  assert.match(api, /readonly code\?: string/);
  assert.match(api, /return this\.code === 'INSTALLATION_REVISION_CONFLICT';/);
  assert.match(api, /typeof value === 'string'\) code = value;/);
  // The card re-reads and keeps the draft off screen; the request is never repeated automatically.
  assert.match(view, /reason\.staleRevision/);
  assert.match(view, /다른 작업에서 설치 정보가 변경되어 최신 내용을 다시 불러왔습니다\./);
  assert.match(view, /setRetry\(\(value\) => value \+ 1\);/);
});
