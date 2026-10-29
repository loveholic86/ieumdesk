import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installationFieldLabel, installationFieldValue } from '../src/installation-labels.ts';
import { installationFieldGroup, installationEditorGroups } from '../src/installation-editor.ts';
import type { InstallationDetailField } from '../src/installation-types.ts';

const field = (key: string, label: string, value = ''): InstallationDetailField => ({
  id: key,
  key,
  label,
  value,
  secret: false,
  masked: false,
  present: Boolean(value),
});

test('the installation access type and domain read as 「접근 방식」 and 「서비스 도메인」, not the access-tab labels', () => {
  assert.equal(installationFieldLabel(field('accessType', '접근 방식')), '접근 방식');
  assert.equal(installationFieldLabel(field('domain', '서비스 도메인')), '서비스 도메인');
  // The access tab keeps its own, different labels.
  assert.equal(installationFieldLabel(field('access_type', '접근 유형')), '접근 유형');
  assert.equal(installationFieldLabel(field('domainurl', '도메인 URL')), '도메인 URL');
  // 「설치 접근 방식」 is explicitly not the chosen label.
  assert.notEqual(installationFieldLabel(field('accessType', '접근 방식')), '설치 접근 방식');
});

test('a record saved with the old label still shows the current one; a custom label stays as written', () => {
  // A workspace row carries the label it was saved with.
  assert.equal(installationFieldLabel(field('accessType', '접근 유형')), '접근 방식');
  assert.equal(installationFieldLabel(field('domain', '도메인')), '서비스 도메인');
  // Choice values stay translated for a field recognised by either label.
  assert.equal(installationFieldValue(field('accessType', '접근 유형', 'VPN/VDI')), 'VPN/VDI');
  // A genuinely custom label is never rewritten.
  assert.equal(installationFieldLabel(field('accessType', '현장 접근 방식')), '현장 접근 방식');
  assert.equal(installationFieldLabel(field('domain', '고객 도메인')), '고객 도메인');
  // Retired labels only apply to the key they belonged to.
  assert.equal(installationFieldLabel(field('domainurl', '도메인')), '도메인');
});

test('the installation and access remark groups are named apart in both menus', () => {
  assert.equal(installationFieldGroup('installation', 'note').title, '설치 정보 비고');
  assert.equal(installationFieldGroup('installation', 'ct_etc').title, '설치 정보 비고');
  assert.equal(installationFieldGroup('installation', 'setup_etc').title, '설치 정보 비고');
  assert.equal(installationFieldGroup('access', 'access_etc').title, '접근 비고');
  // The retired combined title is gone from the editor menu.
  const titles = [
    ...installationEditorGroups('installation', ['note', 'ct_etc', 'setup_etc']),
    ...installationEditorGroups('access', ['access_etc']),
  ].map((group) => group.title);
  assert.deepEqual(
    titles.filter((title) => title.includes('비고')),
    ['설치 정보 비고', '접근 비고'],
  );
  assert.equal(titles.includes('비고·참고사항'), false);
  assert.equal(titles.includes('비고'), false);
});

test('the read cards name the same remark groups and keep the access/installation split', () => {
  const view = readFileSync(new URL('../src/InstallationDetails.tsx', import.meta.url), 'utf8');
  assert.match(view, /cardGroup\('notes', '설치 정보 비고', 'note ct_etc setup_etc'\)/);
  assert.match(view, /cardGroup\('notes', '접근 비고', 'access_etc'\)/);
  // A bare 「비고」 group title would reintroduce the confusion the rename removed.
  assert.equal(/cardGroup\('notes', '비고'/.test(view), false);
  // Read-card access group titles match the edit menus instead of using one-word variants.
  for (const title of ['연결 정보', 'SSL 설정', 'VPN 계정']) assert.ok(view.includes(`'${title}'`), title);
});

test('every label the rename introduced has an English translation', () => {
  const english = readFileSync(new URL('../src/locales/en.ts', import.meta.url), 'utf8');
  for (const key of [
    '설치 정보 비고',
    '접근 비고',
    '접근 방식',
    '서비스 도메인',
    '연결 정보',
    'SSL 설정',
    'VPN 계정',
  ])
    assert.ok(english.includes(`'${key}':`) || english.includes(`${key}:`), key);
  // The retired combined group title no longer needs a translation.
  assert.equal(english.includes('비고·참고사항'), false);
});
