import type {
  InstallationDetails,
  InstallationDetailField,
  InstallationDetailRow,
} from './installation-types';

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
    throw new Error('기록 이름을 제어문자 없이 120자 이내로 입력해 주세요.');
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
      return original && !removed.includes(key) && (original.masked || original.value !== value);
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
  return row
    ? { title: normalizedTitle, values: changed, removeFields: [...new Set(removed)], addFields: fields }
    : { title: normalizedTitle, fields };
}
