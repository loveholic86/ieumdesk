import {
  accessCommonFieldKeys,
  accessCommonRowId,
  accessEtcKey,
  accessServerUnits,
  type InstallationDetails,
  type InstallationDetailField,
  type InstallationDetailRow,
  type InstallationDetailSection,
  type InstallationSectionId,
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
  /** Server display names, keyed by the row id the editor shows. Never stored as a title. */
  displayNames?: Record<string, string>;
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
    const draftedName = draft.displayNames?.[row.id];
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
    const payload = prepareInstallationRow(row, title, values, removed, additions, draftedName);
    const changed = Boolean(
      (payload.title !== undefined && payload.title !== row.title) ||
      payload.displayName !== undefined ||
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
    const body = prepareInstallationRow(
      undefined,
      row.title,
      {},
      [],
      row.fields,
      draft.displayNames?.[row.localId],
    );
    operations.push({
      kind: 'row-create',
      localId: row.localId,
      fieldLocalIds: row.fields.map((field) => field.localId ?? ''),
      body: {
        sectionId,
        title: body.title!,
        fields: body.fields!,
        ...(body.displayName ? { displayName: body.displayName } : {}),
      },
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

const genericAccessTitles = new Set([
  '기존 접근 정보',
  '접근 정보',
  'Address',
  'VPN',
  '서버',
  '접속 주소',
  '이관 원본 Address',
  '이관 원본 VPN',
  '이관 원본 접근 정보',
  '설치 공통',
]);

function visibleAccessRows(rows: readonly InstallationDetailRow[]) {
  return visibleInstallationSection({
    id: 'access',
    title: '접근 정보',
    imported: false,
    rows: [...rows],
  }).rows;
}

function accessFilled(field: InstallationDetailField) {
  return field.masked || field.value.trim().length > 0;
}

function genericAccessTitle(title: string) {
  return genericAccessTitles.has(title) || /^이관 원본\s+(?:address|vpn|access|접근 정보)$/i.test(title);
}

/** Stored title when it names a server. Part labels and the shared slot title do not. */
export function accessServerTitle(rows: readonly Pick<InstallationDetailRow, 'title'>[]) {
  for (const row of rows) {
    const title = row.title?.trim();
    if (title && !genericAccessTitle(title)) return title;
  }
  return '';
}

/** Server display name set by the user. Kept apart from stored titles. */
export function accessServerDisplayName(rows: readonly Pick<InstallationDetailRow, 'displayName'>[]) {
  for (const row of rows) {
    const name = row.displayName?.trim();
    if (name) return name;
  }
  return '';
}

/** Address, VPN, and access fields for one server card. Only the access remark is installation-wide. */
export function accessServerFields(rows: readonly InstallationDetailRow[]) {
  const seen = new Set<string>();
  const fields: InstallationDetailField[] = [];
  for (const row of rows)
    for (const field of row.fields) {
      if (accessCommonFieldKeys.has(field.key) || seen.has(field.key)) continue;
      seen.add(field.key);
      fields.push(field);
    }
  return fields;
}

/** First filled value of a column key across one server's rows. An empty field never wins. */
export function accessColumnField(rows: readonly InstallationDetailRow[], key: string) {
  for (const row of rows) {
    const field = row.fields.find((item) => item.key === key);
    if (field && accessFilled(field)) return field;
  }
  return undefined;
}

/** Server display name, then a stored title that names this server, then the caller's fallback. */
export function accessRecordLabel(
  rows: readonly Pick<InstallationDetailRow, 'title' | 'displayName'>[],
  fallback: string,
) {
  return accessServerDisplayName(rows) || accessServerTitle(rows) || fallback;
}

export type AccessRecordItem = { id: string; rows: InstallationDetailRow[]; index: number };

/** One server per list row. A server link is one server; migration parts merge only as one run. */
export function accessRecordItems(rows: readonly InstallationDetailRow[]): AccessRecordItem[] {
  return accessServerUnits(visibleAccessRows(rows));
}

/** Read-only installation access remark. VPN stays on its server. Does not rewrite stored rows. */
export function accessInstallationCommon(rows: readonly InstallationDetailRow[]) {
  const visibleRows = visibleAccessRows(rows);
  const slot = visibleRows.find((row) => row.id === accessCommonRowId);
  const explicitEtc = slot?.fields.find((field) => field.key === accessEtcKey);
  let etc: InstallationDetailField | undefined;
  if (explicitEtc) {
    if (accessFilled(explicitEtc)) etc = explicitEtc;
  } else {
    for (const row of visibleRows) {
      if (row.id === accessCommonRowId) continue;
      const field = row.fields.find((item) => item.key === accessEtcKey);
      if (field && accessFilled(field)) {
        etc = field;
        break;
      }
    }
  }
  return { etc };
}

/**
 * Where a shared remark edit belongs. The explicit slot wins; otherwise the value already stored
 * on a server row is updated in place, so a legacy install is not given a second shared row.
 */
export function accessCommonSaveTarget(
  rows: readonly InstallationDetailRow[],
): { kind: 'slot' | 'legacyRow'; rowId: string } | { kind: 'create' } {
  const visibleRows = visibleAccessRows(rows);
  if (visibleRows.some((row) => row.id === accessCommonRowId))
    return { kind: 'slot', rowId: accessCommonRowId };
  for (const row of visibleRows) {
    const field = row.fields.find((item) => item.key === accessEtcKey);
    if (field && accessFilled(field)) return { kind: 'legacyRow', rowId: row.id };
  }
  return { kind: 'create' };
}

/** Keep the selected access rows, plus rows created after editing started. One record, or any other tab, stays whole. */
export function installationAccessEditingDetails<T extends InstallationDetails>(
  details: T,
  selectedIds: readonly string[] | undefined,
  baselineIds: readonly string[] | undefined,
): T {
  if (!selectedIds) return details;
  const selected = new Set(selectedIds);
  const baseline = new Set(baselineIds ?? selectedIds);
  return {
    ...details,
    sections: details.sections.map((section) =>
      section.id === 'access'
        ? {
            ...section,
            rows: section.rows.filter((row) => selected.has(row.id) || !baseline.has(row.id)),
          }
        : section,
    ),
  };
}

export function installationDetailsForAccessEdit<T extends InstallationDetails>(
  details: T,
  selectedId: string,
): T {
  const section = details.sections.find((item) => item.id === 'access');
  if (!section) return details;
  const items = accessRecordItems(section.rows);
  const selected =
    items.find((item) => item.id === selectedId) ??
    items.find((item) => item.rows.some((row) => row.id === selectedId)) ??
    items[0];
  return installationAccessEditScope(
    details,
    selected?.rows.map((row) => row.id) ?? [],
    section.rows.map((row) => row.id),
  );
}

/**
 * Rows of the selected server, with the installation-wide fields stripped. This is the server
 * editing scope only: the shared remark is seeded and saved from the unscoped details.
 */
export function installationAccessEditScope<T extends InstallationDetails>(
  details: T,
  rowIds: readonly string[] | undefined,
  baselineIds: readonly string[] | undefined,
): T {
  const scoped = installationAccessEditingDetails(details, rowIds, baselineIds);
  return {
    ...scoped,
    sections: scoped.sections.map((item) =>
      item.id === 'access'
        ? {
            ...item,
            rows: item.rows
              .map((row) => ({
                ...row,
                fields: row.fields.filter((field) => !accessCommonFieldKeys.has(field.key)),
              }))
              .filter((row) => row.fields.length > 0),
          }
        : item,
    ),
  };
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
  displayName?: string;
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
  displayName?: string,
): RowDraftPayload {
  const normalizedTitle = title.trim();
  const normalizedDisplayName = displayName?.trim();
  if (normalizedDisplayName && normalizedDisplayName.length > 120)
    throw new Error('표시명은 120자 이내로 입력해 주세요.');
  if (normalizedDisplayName && /[\u0000-\u001f\u007f]/.test(normalizedDisplayName))
    throw new Error('표시명에 제어문자를 쓸 수 없습니다.');
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
  const nameChange =
    normalizedDisplayName !== undefined && normalizedDisplayName !== (row?.displayName ?? '')
      ? { displayName: normalizedDisplayName }
      : {};
  // The stored title keeps its part meaning. A user-facing name travels as displayName, so
  // renaming a server never breaks the title-based grouping of a migrated server unit.
  return row?.origin || row?.serverId
    ? { ...nameChange, ...patch }
    : row
      ? { title: normalizedTitle, ...nameChange, ...patch }
      : { title: normalizedTitle, ...nameChange, fields };
}
