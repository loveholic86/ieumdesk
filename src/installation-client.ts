import type {
  InstallationDetails,
  InstallationDetailField,
  InstallationDetailRow,
  InstallationDetailSection,
  InstallationSectionId,
} from './installation-types';

/** Only yes/no fields qualify. Unknown/third-choice values remain editable without coercion. */
export function installationBooleanChoice(key: string, value: string) {
  if (key === 'bonding_yn') return null; // This field also supports E (other).
  if (key !== 'autoUpdate' && !key.endsWith('_yn')) return null;
  const normalized = value.trim().toLowerCase();
  if (!['', 'y', 'n', 'yes', 'no', 'true', 'false', '1', '0', '예', '아니오'].includes(normalized))
    return null;
  const checked = ['y', 'yes', 'true', '1', '예'].includes(normalized);
  // Built-in flags accept canonical Y/N; primary metadata uses typed boolean text.
  return { checked, yes: key === 'autoUpdate' ? 'true' : 'Y', no: key === 'autoUpdate' ? 'false' : 'N' };
}

export function installationComparableValue(
  field: Pick<InstallationDetailField, 'key' | 'value' | 'optionValue'>,
) {
  if (field.optionValue !== undefined) return field.optionValue;
  if (!field.value.trim()) return '';
  const choice = installationBooleanChoice(field.key, field.value);
  return choice ? (choice.checked ? choice.yes : choice.no) : field.value;
}

export type InstallationSectionDraft = {
  values: Record<string, string>;
  titles: Record<string, string>;
  notes: Record<string, string>;
  addedRows?: Array<{
    localId: string;
    title: string;
    fields: Array<NewInstallationField & { localId?: string }>;
  }>;
  removedRows?: string[];
  addedFields?: Record<string, Array<{ localId: string; key: string; label: string; value: string }>>;
  removedFields?: Record<string, string[]>;
  addedNotes?: Array<{ localId: string; content: string }>;
  removedNotes?: string[];
};
export type InstallationSectionChange = {
  kind: 'row' | 'note';
  id: string;
  body: RowDraftPayload | { content: string };
  metadata: boolean;
  fieldIds: string[];
};

export type InstallationSectionOperation =
  | {
      kind: 'row-create';
      localId: string;
      fieldLocalIds: string[];
      body: { sectionId: InstallationSectionId; title: string; fields: NewInstallationField[] };
    }
  | { kind: 'row-update'; id: string; body: RowDraftPayload; addFieldLocalIds: string[]; metadata?: boolean }
  | { kind: 'row-delete'; id: string }
  | { kind: 'note-create'; localId: string; content: string }
  | { kind: 'note-update'; id: string; content: string }
  | { kind: 'note-delete'; id: string };

const validLongText = (value: string) =>
  value.trim().length > 0 &&
  value.length <= 16384 &&
  !value.includes('\0') &&
  !/[\uD800-\uDFFF]/u.test(value);

/** Build a validated, ordered save plan for the existing section editor. */
export function prepareInstallationSectionOperations(
  details: InstallationDetails,
  sectionId: InstallationSectionId,
  draft: InstallationSectionDraft,
): InstallationSectionOperation[] {
  const section = details.sections.find((item) => item.id === sectionId);
  if (!section) throw new Error('설치 상세 정보를 다시 불러와 주세요.');
  const visible = visibleInstallationSection(section);
  const removedRows = new Set(draft.removedRows ?? []);
  const operations: InstallationSectionOperation[] = [];
  for (const row of visible.rows) {
    const additions = draft.addedFields?.[row.id] ?? [];
    const removed = draft.removedFields?.[row.id] ?? [];
    const draftedTitle = draft.titles[row.id];
    if (
      row.managed === 'metadata' &&
      (removedRows.has(row.id) ||
        removed.length > 0 ||
        additions.length > 0 ||
        (draftedTitle !== undefined && draftedTitle !== (row.title ?? section.title)))
    )
      throw new Error('기본 정보의 이름과 항목 구성은 변경할 수 없습니다. 항목 값만 수정해 주세요.');
    if (removedRows.has(row.id)) {
      if (row.managed === 'metadata') throw new Error('기본 정보는 삭제할 수 없습니다.');
      operations.push({ kind: 'row-delete', id: row.id });
      continue;
    }
    const title = draft.titles[row.id] ?? row.title ?? section.title;
    const values = Object.fromEntries(
      row.fields
        .filter((field) => Object.hasOwn(draft.values, field.id))
        .map((field) => [field.key, draft.values[field.id]]),
    );
    if (row.managed === 'metadata') {
      const changed = Object.fromEntries(
        Object.entries(values).filter(([key, value]) => {
          const field = row.fields.find((candidate) => candidate.key === key);
          return field && (field.masked || installationComparableValue(field) !== value);
        }),
      );
      if (!Object.keys(changed).length) continue;
      const payload = prepareInstallationRow(row, title, changed, [], []);
      operations.push({
        kind: 'row-update',
        id: row.id,
        body: payload,
        addFieldLocalIds: [],
        metadata: true,
      });
      continue;
    }
    const payload = prepareInstallationRow(row, title, values, removed, additions);
    const changed = Boolean(
      (payload.title !== undefined && payload.title !== row.title) ||
      (payload.values && Object.keys(payload.values).length) ||
      payload.removeFields?.length ||
      payload.addFields?.length,
    );
    if (changed)
      operations.push({
        kind: 'row-update',
        id: row.id,
        body: payload,
        addFieldLocalIds: additions.map((field) => field.localId),
        metadata: false,
      });
  }
  for (const row of draft.addedRows ?? []) {
    const body = prepareInstallationRow(undefined, row.title, {}, [], row.fields);
    operations.push({
      kind: 'row-create',
      localId: row.localId,
      fieldLocalIds: row.fields.map((field) => field.localId ?? ''),
      body: { sectionId, title: body.title!, fields: body.fields! },
    });
  }
  if (sectionId === 'access') {
    for (const note of details.accessNotes ?? []) {
      if ((draft.removedNotes ?? []).includes(note.id)) operations.push({ kind: 'note-delete', id: note.id });
      else if (
        Object.hasOwn(draft.notes, note.id) &&
        (note.masked || draft.notes[note.id] !== note.content)
      ) {
        if (!validLongText(draft.notes[note.id]))
          throw new Error('참고사항은 빈 값이나 잘못된 문자 없이 16,384자 이내로 입력해 주세요.');
        operations.push({ kind: 'note-update', id: note.id, content: draft.notes[note.id] });
      }
    }
    for (const note of draft.addedNotes ?? []) {
      if (!validLongText(note.content))
        throw new Error('참고사항은 빈 값이나 잘못된 문자 없이 16,384자 이내로 입력해 주세요.');
      operations.push({ kind: 'note-create', localId: note.localId, content: note.content });
    }
  }
  return operations;
}

/** Validate the entire tab before sending any mutation; untouched masked values are omitted. */
export function prepareInstallationSection(
  details: InstallationDetails,
  sectionId: InstallationSectionId,
  draft: InstallationSectionDraft,
): InstallationSectionChange[] {
  const section = details.sections.find((item) => item.id === sectionId);
  if (!section) throw new Error('설치 상세 정보를 다시 불러와 주세요.');
  const changes: InstallationSectionChange[] = [];
  for (const row of visibleInstallationSection(section).rows) {
    const values = Object.fromEntries(
      row.fields
        .filter((field) => Object.hasOwn(draft.values, field.id))
        .map((field) => [field.key, draft.values[field.id]]),
    );
    const title = draft.titles[row.id] ?? row.title ?? section.title;
    if (
      title === (row.title ?? section.title) &&
      !row.fields.some(
        (field) => Object.hasOwn(values, field.key) && (field.masked || field.value !== values[field.key]),
      )
    )
      continue;
    changes.push({
      kind: 'row',
      id: row.id,
      metadata: row.managed === 'metadata',
      fieldIds: row.fields.map((field) => field.id),
      body: prepareInstallationRow(row, title, values, [], []),
    });
  }
  if (sectionId === 'access')
    for (const note of details.accessNotes ?? []) {
      if (!Object.hasOwn(draft.notes, note.id) || (!note.masked && draft.notes[note.id] === note.content))
        continue;
      const content = draft.notes[note.id];
      if (
        !content.trim() ||
        content.length > 16384 ||
        content.includes('\0') ||
        /[\uD800-\uDFFF]/u.test(content)
      )
        throw new Error('참고사항은 빈 값이나 잘못된 문자 없이 16,384자 이내로 입력해 주세요.');
      changes.push({ kind: 'note', id: note.id, body: { content }, metadata: false, fieldIds: [] });
    }
  return changes;
}

const unusedAccessFields = new Set(['access_reqst_date', 'access_id', 'access_pwd']);

/** Hide retired controls in both reading and editing without deleting stored values. */
export function visibleInstallationSection(section: InstallationDetailSection): InstallationDetailSection {
  if (section.id !== 'access') return section;
  return {
    ...section,
    rows: section.rows
      .map((row) => ({ ...row, fields: row.fields.filter((field) => !unusedAccessFields.has(field.key)) }))
      .filter((row) => row.fields.length > 0),
  };
}

const sectionIds = ['installation', 'access', 'server', 'yeta', 'sap', 'settings', 'files'];
const accessNoteId = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const serverTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const maskedContent = '••••••••';
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function validServerTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !serverTimestamp.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

const accessOriginParts = new Set(['address', 'vpn', 'access']);

function validAccessOrigin(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes('group') &&
    keys.includes('part') &&
    typeof value.group === 'string' &&
    /^[a-f0-9]{64}$/.test(value.group) &&
    typeof value.part === 'string' &&
    accessOriginParts.has(value.part)
  );
}

function validAccessNotes(value: unknown): boolean {
  // Older detail responses do not include notes. Keep this type guard non-mutating.
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 1000) return false;
  const ids = new Set<string>();
  return value.every((note: unknown) => {
    if (
      !object(note) ||
      typeof note.id !== 'string' ||
      !accessNoteId.test(note.id) ||
      ids.has(note.id.toLowerCase()) ||
      typeof note.content !== 'string' ||
      !note.content.trim() ||
      note.content.length > 16384 ||
      note.content.includes('\0') ||
      // Unicode mode matches unpaired surrogates while allowing valid emoji pairs.
      /[\uD800-\uDFFF]/u.test(note.content) ||
      !validServerTimestamp(note.createdAt) ||
      (note.updatedAt !== undefined && !validServerTimestamp(note.updatedAt)) ||
      typeof note.masked !== 'boolean' ||
      (note.masked && note.content !== maskedContent)
    )
      return false;
    ids.add(note.id.toLowerCase());
    return true;
  });
}

export function validateInstallationDetails(
  value: unknown,
  id: string,
): value is InstallationDetails & { revision: number } {
  if (
    !object(value) ||
    value.id !== id ||
    typeof value.imported !== 'boolean' ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    (value.metadataRevision !== undefined &&
      (typeof value.metadataRevision !== 'string' || !value.metadataRevision)) ||
    !validAccessNotes(value.accessNotes) ||
    !Array.isArray(value.sections) ||
    value.sections.length !== sectionIds.length
  )
    return false;
  const sections = value.sections;
  if (
    !sectionIds.every((id) => sections.filter((section) => object(section) && section.id === id).length === 1)
  )
    return false;
  const rowIds = new Set<string>();
  const fieldIds = new Set<string>();
  return sections.every(
    (section) =>
      object(section) &&
      typeof section.title === 'string' &&
      typeof section.imported === 'boolean' &&
      Array.isArray(section.rows) &&
      section.rows.every((row: unknown) => {
        if (
          !object(row) ||
          typeof row.id !== 'string' ||
          !row.id ||
          rowIds.has(row.id) ||
          (row.managed !== undefined && row.managed !== 'metadata') ||
          (row.managed === 'metadata' && !value.metadataRevision) ||
          !validAccessOrigin(row.origin) ||
          !Array.isArray(row.fields)
        )
          return false;
        rowIds.add(row.id);
        const keys = new Set<string>();
        return row.fields.every((field: unknown) => {
          if (
            !object(field) ||
            typeof field.id !== 'string' ||
            !field.id ||
            fieldIds.has(field.id) ||
            typeof field.key !== 'string' ||
            keys.has(field.key) ||
            typeof field.label !== 'string' ||
            typeof field.value !== 'string' ||
            (field.optionValue !== undefined &&
              (typeof field.optionValue !== 'string' ||
                field.optionValue.length > 100 ||
                field.optionValue.includes('\0'))) ||
            typeof field.secret !== 'boolean' ||
            typeof field.masked !== 'boolean' ||
            typeof field.present !== 'boolean'
          )
            return false;
          fieldIds.add(field.id);
          keys.add(field.key);
          return true;
        });
      }),
  );
}

export function installationFieldMasked(
  field: Pick<InstallationDetailField, 'masked' | 'secret'>,
  policyPending: boolean,
): boolean {
  return field.masked || (policyPending && field.secret);
}

export type NewInstallationField = { key: string; label: string; value: string };
export type RowDraftPayload = {
  title?: string;
  values?: Record<string, string>;
  removeFields?: string[];
  addFields?: NewInstallationField[];
  fields?: NewInstallationField[];
};

export function installationRowCanDelete(row: InstallationDetailRow): boolean {
  return row.managed !== 'metadata';
}

export function refreshedInstallationSelection<T extends { id: string }>(
  current: T | null,
  records: T[],
): T | null {
  return current ? (records.find((record) => record.id === current.id) ?? null) : null;
}

export function prepareInstallationRow(
  row: InstallationDetailRow | undefined,
  title: string,
  values: Record<string, string>,
  removed: string[],
  added: NewInstallationField[],
): RowDraftPayload {
  const normalizedTitle = title.trim();
  if (
    row?.managed === 'metadata' &&
    (normalizedTitle !== row.title || removed.length > 0 || added.length > 0)
  )
    throw new Error('기본 정보의 이름과 항목 구성은 변경할 수 없습니다. 항목 값을 수정해 주세요.');
  if (!normalizedTitle || normalizedTitle.length > 120 || /[\u0000-\u001f\u007f]/.test(normalizedTitle))
    throw new Error('구분명을 제어문자 없이 120자 이내로 입력해 주세요.');
  const fields = added.map(({ key, label, value }) => ({ key: key.trim(), label: label.trim(), value }));
  const remaining =
    row?.fields.filter((field) => !removed.includes(field.key)).map((field) => field.key) ?? [];
  const keys = [...remaining, ...fields.map((field) => field.key)];
  if (keys.length < 1 || keys.length > 80) throw new Error('한 기록에는 항목을 1~80개 등록할 수 있습니다.');
  if (
    fields.some(
      (field) =>
        !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(field.key) ||
        ['constructor', 'prototype', '__proto__'].includes(field.key) ||
        !field.label ||
        field.label.length > 120 ||
        /[\u0000-\u001f\u007f]/.test(field.label),
    )
  )
    throw new Error(
      '새 항목의 이름과 키를 확인해 주세요. 이름은 120자, 키는 영문자로 시작하는 영문·숫자·밑줄·점·하이픈 80자 이내입니다.',
    );
  if (new Set(keys).size !== keys.length)
    throw new Error('같은 키의 항목이 있습니다. 항목 키를 다르게 입력해 주세요.');
  const changed = Object.fromEntries(
    Object.entries(values).filter(([key, value]) => {
      const original = row?.fields.find((field) => field.key === key);
      return (
        original &&
        !removed.includes(key) &&
        (original.masked || installationComparableValue(original) !== value)
      );
    }),
  );
  if (
    [...fields.map((field) => field.value), ...Object.values(changed)].some(
      (value) => value.length > 16384 || value.includes('\0'),
    )
  )
    throw new Error('항목 값은 16,384자 이내여야 하며 NUL 문자를 포함할 수 없습니다.');
  if (row?.managed === 'metadata') {
    if (Object.keys(changed).length === 0) throw new Error('변경한 기본 정보가 없습니다.');
    return { values: changed };
  }
  const patch = { values: changed, removeFields: [...new Set(removed)], addFields: fields };
  // Origin titles stay as stored. The editor shows a fixed label and must not PATCH title.
  return row?.origin ? patch : row ? { title: normalizedTitle, ...patch } : { title: normalizedTitle, fields };
}
