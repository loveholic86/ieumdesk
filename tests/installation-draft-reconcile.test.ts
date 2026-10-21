import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitLatestInstallationDraft,
  installationNoteReviewEntries,
  installationReviewValue,
  reconcileCommittedInstallationDraft,
} from '../src/installation-draft-reconcile.ts';
import type { InstallationDetails } from '../src/installation-types.ts';
import {
  prepareInstallationSectionOperations,
  type InstallationSectionDraft,
  type InstallationSectionOperation,
} from '../src/installation-client.ts';
import { runInstallationSavePlan } from '../src/installation-save-flow.ts';

const noteId = '00000000-0000-4000-8000-000000000001';
const field = (id: string, key: string, value: string, masked = false) => ({
  id,
  key,
  label: key,
  value,
  secret: key.includes('pwd'),
  masked,
  present: value !== '',
});
const details = (
  rows: InstallationDetails['sections'][number]['rows'] = [],
  accessNotes: NonNullable<InstallationDetails['accessNotes']> = [],
): InstallationDetails => ({
  id: 'synthetic',
  imported: true,
  revision: 1,
  sections: [
    { id: 'installation', title: '설치', imported: true, rows: [] },
    { id: 'access', title: '접근', imported: true, rows: [] },
    { id: 'server', title: '서버', imported: true, rows },
    { id: 'yeta', title: 'YETA', imported: true, rows: [] },
    { id: 'sap', title: 'SAP', imported: true, rows: [] },
    { id: 'settings', title: '설정', imported: true, rows: [] },
    { id: 'files', title: '파일', imported: true, rows: [] },
  ],
  accessNotes,
});

test('confirmed row updates clear only the submitted snapshot and retain later value/title edits', () => {
  const before = details([
    { id: 'row-1', title: '원래 이름', fields: [field('field-1', 'hostname', 'old')] },
  ]);
  const after = details([{ id: 'row-1', title: '제출 이름', fields: [field('field-1', 'hostname', 'A')] }]);
  const operation: InstallationSectionOperation = {
    kind: 'row-update',
    id: 'row-1',
    addFieldLocalIds: [],
    body: { title: '제출 이름', values: { hostname: 'A' } },
  };
  const current: InstallationSectionDraft = {
    values: { 'field-1': 'B' },
    titles: { 'row-1': '후속 이름' },
    notes: {},
  };
  assert.deepEqual(reconcileCommittedInstallationDraft(current, operation, before, after), {
    ...current,
    values: { 'field-1': 'B' },
    titles: { 'row-1': '후속 이름' },
    addedRows: [],
    removedRows: [],
    addedFields: {},
    removedFields: {},
    addedNotes: [],
    removedNotes: [],
  });
  const sameSnapshot = reconcileCommittedInstallationDraft(
    { ...current, values: { 'field-1': 'A' }, titles: { 'row-1': '제출 이름' } },
    operation,
    before,
    after,
  );
  assert.deepEqual(sameSnapshot.values, {});
  assert.deepEqual(sameSnapshot.titles, {});
});

test('React commit callback reads the latest draft ref after the submitted value changes in flight', () => {
  const before = details([
    { id: 'row-1', title: '원래 이름', fields: [field('field-1', 'hostname', 'old')] },
  ]);
  const after = details([{ id: 'row-1', title: '서버 A', fields: [field('field-1', 'hostname', 'A')] }]);
  const operation: InstallationSectionOperation = {
    kind: 'row-update',
    id: 'row-1',
    addFieldLocalIds: [],
    body: { title: '서버 A', values: { hostname: 'A' } },
  };
  const draftRef = { current: { values: { 'field-1': 'A' }, titles: { 'row-1': '서버 A' }, notes: {} } };
  // Mirrors a second React render after the request snapshot was sent, before its response arrives.
  draftRef.current = { values: { 'field-1': 'B' }, titles: { 'row-1': '서버 B' }, notes: {} };
  const committed = commitLatestInstallationDraft(draftRef, operation, before, after);
  assert.equal(draftRef.current.values['field-1'], 'B');
  assert.equal(draftRef.current.titles['row-1'], '서버 B');
  assert.equal(committed.values['field-1'], 'B');
  assert.equal(committed.titles['row-1'], '서버 B');
});

test('acknowledged custom-field creation maps a later value edit onto the returned server field ID', () => {
  const before = details([{ id: 'row-1', title: '서버', fields: [] }]);
  const after = details([
    { id: 'row-1', title: '서버', fields: [field('server-field-id', 'custom_password', '••••••••', true)] },
  ]);
  const operation: InstallationSectionOperation = {
    kind: 'row-update',
    id: 'row-1',
    addFieldLocalIds: ['local-field'],
    body: {
      title: '서버',
      values: {},
      removeFields: [],
      addFields: [{ key: 'custom_password', label: '비밀', value: 'A' }],
    },
  };
  const current: InstallationSectionDraft = {
    values: {},
    titles: {},
    notes: {},
    addedFields: { 'row-1': [{ localId: 'local-field', key: 'custom_password', label: '비밀', value: 'B' }] },
  };
  const result = reconcileCommittedInstallationDraft(current, operation, before, after);
  assert.deepEqual(result.addedFields?.['row-1'], []);
  assert.equal(result.values['server-field-id'], 'B');
});

test('multiple confirmed field additions stay cleared when a later note fails and retry saves only that note', async () => {
  const before = details([{ id: 'row-1', title: '접근', fields: [] }]);
  const afterFields = details([
    {
      id: 'row-1',
      title: '접근',
      fields: [
        field('field-a', 'custom_a', '••••••••', true),
        field('field-b', 'custom_b', '••••••••', true),
      ],
    },
  ]);
  const afterNoteOne = details(afterFields.sections[2].rows, [
    { id: noteId, content: '••••••••', masked: true, createdAt: '2026-10-20T00:00:00.000Z' },
  ]);
  const afterNoteTwo = details(afterFields.sections[2].rows, [
    ...afterNoteOne.accessNotes!,
    {
      id: '00000000-0000-4000-8000-000000000002',
      content: '••••••••',
      masked: true,
      createdAt: '2026-10-20T00:00:01.000Z',
    },
  ]);
  const fieldOperation: InstallationSectionOperation = {
    kind: 'row-update',
    id: 'row-1',
    addFieldLocalIds: ['local-a', 'local-b'],
    body: {
      title: '접근',
      values: {},
      removeFields: [],
      addFields: [
        { key: 'custom_a', label: '필드 A', value: 'A' },
        { key: 'custom_b', label: '필드 B', value: 'B' },
      ],
    },
  };
  const noteOne: InstallationSectionOperation = {
    kind: 'note-create',
    localId: 'note-one',
    content: '노트 1',
  };
  const noteTwo: InstallationSectionOperation = {
    kind: 'note-create',
    localId: 'note-two',
    content: '노트 2',
  };
  const draftRef = {
    current: {
      values: {},
      titles: {},
      notes: {},
      addedFields: {
        'row-1': [
          { localId: 'local-a', key: 'custom_a', label: '필드 A', value: 'A' },
          { localId: 'local-b', key: 'custom_b', label: '필드 B', value: 'B' },
        ],
      },
      addedNotes: [
        { localId: 'note-one', content: '노트 1' },
        { localId: 'note-two', content: '노트 2' },
      ],
    } satisfies InstallationSectionDraft,
  };
  const calls: InstallationSectionOperation[] = [];
  const partial = await runInstallationSavePlan(
    [fieldOperation, noteOne, noteTwo],
    before,
    async (operation) => {
      calls.push(operation);
      if (operation === fieldOperation) return afterFields;
      if (operation === noteOne) return afterNoteOne;
      throw new Error('synthetic second-note conflict');
    },
    (operation, latest, previous) => {
      commitLatestInstallationDraft(draftRef, operation, previous, latest);
    },
    () => false,
  );
  assert.equal(partial.saved, 2);
  assert.equal(partial.failure?.operation, noteTwo);
  assert.deepEqual(draftRef.current.addedFields?.['row-1'], []);
  assert.deepEqual(draftRef.current.addedNotes, [{ localId: 'note-two', content: '노트 2' }]);
  assert.deepEqual(prepareInstallationSectionOperations(partial.latest, 'server', draftRef.current), []);

  const retry = prepareInstallationSectionOperations(partial.latest, 'access', draftRef.current);
  assert.deepEqual(retry, [noteTwo]);
  const retried = await runInstallationSavePlan(
    retry,
    partial.latest,
    async (operation) => {
      calls.push(operation);
      return afterNoteTwo;
    },
    (operation, latest, previous) => {
      commitLatestInstallationDraft(draftRef, operation, previous, latest);
    },
    () => false,
  );
  assert.deepEqual(calls, [fieldOperation, noteOne, noteTwo, noteTwo]);
  assert.equal(retried.saved, 1);
  assert.deepEqual(draftRef.current.addedFields?.['row-1'], []);
  assert.deepEqual(draftRef.current.addedNotes, []);
});

test('a confirmed row deletion is cleared before a later operation fails, so retry does not delete twice', async () => {
  const before = details([{ id: 'row-1', title: '접근', fields: [field('field-1', 'hostname', 'host')] }]);
  const afterDelete = details();
  const deletion: InstallationSectionOperation = { kind: 'row-delete', id: 'row-1' };
  const laterFailure: InstallationSectionOperation = {
    kind: 'note-create',
    localId: 'note-local',
    content: '보류 노트',
  };
  const draftRef = {
    current: { values: {}, titles: {}, notes: {}, removedRows: ['row-1'] } satisfies InstallationSectionDraft,
  };
  const partial = await runInstallationSavePlan(
    [deletion, laterFailure],
    before,
    async (operation) => {
      if (operation === deletion) return afterDelete;
      throw new Error('synthetic later failure');
    },
    (operation, latest, previous) => {
      commitLatestInstallationDraft(draftRef, operation, previous, latest);
    },
    () => false,
  );
  assert.equal(partial.saved, 1);
  assert.equal(partial.failure?.operation, laterFailure);
  assert.deepEqual(draftRef.current.removedRows, []);
  assert.deepEqual(prepareInstallationSectionOperations(partial.latest, 'server', draftRef.current), []);
});

test('uncertain row creation maps changed fields and deletion intent to the real row ID', () => {
  const before = details();
  const after = details([
    {
      id: 'real-row-id',
      title: '서버',
      fields: [field('real-host', 'hostname', 'old'), field('real-pwd', 'yeta_pwd', '••••••••', true)],
    },
  ]);
  const operation: InstallationSectionOperation = {
    kind: 'row-create',
    localId: 'local-row',
    fieldLocalIds: ['field-host', 'field-pwd'],
    body: {
      sectionId: 'server',
      title: '서버',
      fields: [
        { key: 'hostname', label: '호스트', value: 'old' },
        { key: 'yeta_pwd', label: '비밀번호', value: 'SYNTHETIC-A' },
      ],
    },
  };
  const changed: InstallationSectionDraft = {
    values: {},
    titles: {},
    notes: {},
    addedRows: [
      {
        localId: 'local-row',
        title: '서버 B',
        fields: [
          { localId: 'field-host', key: 'hostname', label: '호스트', value: 'new' },
          { localId: 'field-pwd', key: 'yeta_pwd', label: '비밀번호', value: 'SYNTHETIC-B' },
        ],
      },
    ],
  };
  const result = reconcileCommittedInstallationDraft(changed, operation, before, after);
  assert.deepEqual(result.addedRows, []);
  assert.equal(result.titles['real-row-id'], '서버 B');
  assert.equal(result.values['real-host'], 'new');
  assert.equal(result.values['real-pwd'], 'SYNTHETIC-B');

  const deleted = reconcileCommittedInstallationDraft(
    { ...changed, addedRows: [] },
    operation,
    before,
    after,
  );
  assert.deepEqual(deleted.removedRows, ['real-row-id']);
});

test('uncertain note creation maps a later edit or deletion to the returned UUID', () => {
  const before = details([], []);
  const after = details(
    [],
    [{ id: noteId, content: '••••••••', masked: true, createdAt: '2026-10-20T00:00:00.000Z' }],
  );
  const operation: InstallationSectionOperation = {
    kind: 'note-create',
    localId: 'local-note',
    content: 'SYNTHETIC-A',
  };
  const edited = reconcileCommittedInstallationDraft(
    {
      values: {},
      titles: {},
      notes: {},
      addedNotes: [{ localId: 'local-note', content: 'SYNTHETIC-B' }],
    },
    operation,
    before,
    after,
  );
  assert.deepEqual(edited.addedNotes, []);
  assert.equal(edited.notes[noteId], 'SYNTHETIC-B');
  const deleted = reconcileCommittedInstallationDraft(
    { values: {}, titles: {}, notes: {}, addedNotes: [] },
    operation,
    before,
    after,
  );
  assert.deepEqual(deleted.removedNotes, [noteId]);
});

test('protected review values are suppressed and note deletion labels keep their original row numbers', () => {
  assert.equal(installationReviewValue('SYNTHETIC-SECRET', true), undefined);
  assert.equal(installationReviewValue('SYNTHETIC-PLAIN', false), 'SYNTHETIC-PLAIN');
  const notes = [
    { id: noteId, content: '••••••••', masked: true, createdAt: '2026-10-20T00:00:00.000Z' },
    {
      id: '00000000-0000-4000-8000-000000000002',
      content: '••••••••',
      masked: true,
      createdAt: '2026-10-20T00:00:01.000Z',
    },
  ];
  const entries = installationNoteReviewEntries(notes, [notes[1].id]);
  assert.equal(entries[0].index, 1);
  assert.equal(entries[0].note.id, notes[1].id);
});
