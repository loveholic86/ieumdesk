import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './errors.ts';
import { installationWorkspaceField } from './installation-details.ts';
import {
  installationMetadataAliases,
  installationMetadataKeys,
  installationMetadataPatch,
  installationMetadataRevision,
  installationMetadataValues,
  type InstallationMetadataKey,
} from './installation-metadata.ts';
import type { RecordInput } from './validation.ts';
import type {
  InstallationDetails,
  InstallationDetailRow,
  InstallationSectionId,
} from '../src/installation-types.ts';

const sectionId = z.enum(['installation', 'access', 'server', 'yeta', 'sap', 'settings', 'files']);
export const installationAccessNoteIdSchema = z
  .string()
  .regex(/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
export const installationAccessNoteContentSchema = z
  .string()
  .max(16_384)
  .refine(
    (value) =>
      value.trim().length > 0 && !value.includes('\0') && Buffer.from(value).toString('utf8') === value,
  );
const accessNoteTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const installationAccessNoteSchema = z
  .object({
    id: installationAccessNoteIdSchema,
    content: installationAccessNoteContentSchema,
    createdAt: accessNoteTimestamp,
    updatedAt: accessNoteTimestamp.optional(),
  })
  .strict();
const scalar = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes('\0'));
const fieldSchema = z
  .object({
    id: z.string().min(1).max(100),
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    value: scalar,
    displayValue: scalar,
    secret: z.boolean(),
  })
  .strict();
const rowSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().max(120),
    managed: z.literal('metadata').optional(),
    fields: z.array(fieldSchema).min(1).max(80),
  })
  .strict();
/** Full encrypted operational document. Reads no longer need the archived import. */
export const managedInstallationSchema = z
  .object({
    version: z.literal(2),
    // Optional for existing v2 ciphertext; adding the feature never rewrites an old document.
    accessNotes: z.array(installationAccessNoteSchema).max(1_000).optional(),
    sections: z
      .array(
        z
          .object({ id: sectionId, title: z.string().min(1).max(120), rows: z.array(rowSchema).max(1_000) })
          .strict(),
      )
      .length(7),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.accessNotes?.map((note) => note.id.toLowerCase()) ?? []).size !==
      (value.accessNotes?.length ?? 0)
    )
      context.addIssue({ code: 'custom', message: 'ACCESS_NOTES_DUPLICATED' });
    const ids = new Set<string>();
    if (new Set(value.sections.map((section) => section.id)).size !== 7)
      context.addIssue({ code: 'custom', message: 'SECTIONS_INVALID' });
    let metadataRows = 0;
    for (const section of value.sections)
      for (const row of section.rows) {
        if (ids.has(row.id)) context.addIssue({ code: 'custom', message: 'ROWS_DUPLICATED' });
        ids.add(row.id);
        if (new Set(row.fields.map((field) => field.key)).size !== row.fields.length)
          context.addIssue({ code: 'custom', message: 'FIELDS_DUPLICATED' });
        if (row.managed) {
          metadataRows++;
          if (
            section.id !== 'installation' ||
            row.fields.length !== installationMetadataKeys.length ||
            installationMetadataKeys.some((key) => !row.fields.some((field) => field.key === key))
          )
            context.addIssue({ code: 'custom', message: 'METADATA_FIELDS_INVALID' });
        }
      }
    if (ids.size > 1_000 || metadataRows > 1) context.addIssue({ code: 'custom', message: 'ROWS_INVALID' });
  });
export type ManagedInstallationState = z.infer<typeof managedInstallationSchema>;
export type ManagedInstallationRow = ManagedInstallationState['sections'][number]['rows'][number];

const metadataLabels: Record<InstallationMetadataKey, string> = {
  systemCode: '시스템 코드',
  serviceVersion: '서비스 버전',
  version: '현재 버전',
  installedAt: '설치일',
  patchedAt: '최종 패치일',
  engineer: '담당 엔지니어',
  accessType: '접근 유형',
  autoUpdate: '자동 업데이트',
  domain: '도메인',
  note: '비고',
};
export const managedMetadataRowId = (id: string) =>
  `metadata-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
export function metadataRow(id: string, record: Record<string, unknown>): ManagedInstallationRow {
  const values = installationMetadataValues(record),
    rowId = managedMetadataRowId(id);
  return {
    id: rowId,
    title: '설치 정보',
    managed: 'metadata',
    fields: installationMetadataKeys.map((key) =>
      managedField('installation', rowId, key, metadataLabels[key], values[key]),
    ),
  };
}
export function managedField(
  section: InstallationSectionId,
  rowId: string,
  key: string,
  label: string,
  value: string,
) {
  const rendered = installationWorkspaceField(section, rowId, key, label, value);
  return { id: rendered.id, key, label, value, displayValue: rendered.value, secret: rendered.secret };
}
export function ordinaryInstallationTitle(title: string | undefined) {
  const plain = (title ?? '').replace(/^이관 원본\s*/, '');
  if (plain === '현재 설치 정보' || plain === '설치 정보') return '설치 정보';
  if (plain === 'Address') return '접속 주소';
  if (plain.startsWith('고객 전달용 설정')) return plain.replace('고객 전달용 설정', '설정');
  return plain;
}
const invalid = () =>
  new ApiError(
    503,
    'INSTALLATION_MANAGED_DATA_INVALID',
    '설치 정보를 안전하게 통합하지 못했습니다. 기존 자료는 보존됩니다.',
  );
const sameScalar = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');
function aliasValue(key: InstallationMetadataKey, value: string) {
  if ((key === 'installedAt' || key === 'patchedAt') && /^\d{8}$/.test(value))
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return value;
}
type PreviousChanges = {
  deleted: string[];
  patches: Record<
    string,
    { values: Record<string, string>; removeFields: string[]; addFields: { key: string }[] }
  >;
};

/** Merge effective values, preserving explicit edits and retaining conflicting values as ordinary detail fields. */
export function buildManagedInstallation(
  raw: InstallationDetails,
  display: InstallationDetails,
  original: InstallationDetails,
  changes: PreviousChanges,
  record?: Record<string, unknown>,
) {
  const state: ManagedInstallationState = {
    version: 2,
    sections: raw.sections.map((section) => ({
      id: section.id,
      title: section.title,
      rows: section.rows.map((row) => ({
        id: row.id,
        title: ordinaryInstallationTitle(row.title),
        fields: row.fields.map((field) => {
          const shown = display.sections
            .find((item) => item.id === section.id)
            ?.rows.find((item) => item.id === row.id)
            ?.fields.find((item) => item.key === field.key);
          if (!shown || field.masked || shown.masked) throw invalid();
          return {
            id: field.id,
            key: field.key,
            label: field.label,
            value: field.value,
            displayValue: shown.value,
            secret: shown.secret,
          };
        }),
      })),
    })),
  };
  let metadataPatch: Partial<RecordInput> = {};
  let preservedEdits = 0;
  if (record) {
    const current = installationMetadataValues(record);
    const section = state.sections.find((item) => item.id === 'installation')!;
    // The original current row is identified by its schema, never by translated titles.
    const previousCurrent = original.sections
      .find((item) => item.id === 'installation')
      ?.rows.find(
        (row) =>
          row.fields.some((field) => field.key === 'systemCode') &&
          row.fields.some((field) => field.key === 'installedAt'),
      );
    const fixed = new Set<string>(installationMetadataKeys);
    const primaryChanges = previousCurrent ? changes.patches[previousCurrent.id] : undefined;
    const acceptedPrimary = new Set<string>();
    const originalBasics = original.sections
      .find((item) => item.id === 'installation')
      ?.rows.find((row) => row.fields.some((field) => field.key === 'setup_cd'));
    if (previousCurrent) {
      const row = section.rows.find((item) => item.id === previousCurrent.id);
      if (row) {
        row.title = row.title === '설치 정보' ? '추가 설치 정보' : row.title;
        row.fields = row.fields.filter((field) => {
          if (!fixed.has(field.key)) return true;
          if (primaryChanges?.addFields.some((added) => added.key === field.key)) {
            // A removed-and-recreated field may have a different meaning or label; retain it intact.
            preservedEdits++;
            return true;
          }
          if (!Object.hasOwn(primaryChanges?.values ?? {}, field.key)) return false;
          try {
            const patch = installationMetadataPatch({ [field.key]: field.value });
            if (
              sameScalar(
                current[field.key as InstallationMetadataKey],
                (patch as Record<string, unknown>)[field.key],
              )
            ) {
              acceptedPrimary.add(field.key);
              preservedEdits++;
              return false;
            }
            const sourceKey = Object.entries(installationMetadataAliases).find(
              ([, key]) => key === field.key,
            )?.[0];
            const sourceValue = originalBasics?.fields.find((item) => item.key === sourceKey)?.value;
            if (sourceValue === undefined) {
              preservedEdits++;
              return true;
            }
            const baseline = installationMetadataPatch({
              [field.key]: aliasValue(field.key as InstallationMetadataKey, sourceValue),
            }) as Record<string, unknown>;
            // If ordinary metadata was independently edited, retain both values rather than overwriting it.
            if (!sameScalar(current[field.key as InstallationMetadataKey], baseline[field.key])) {
              preservedEdits++;
              return true;
            }
            Object.assign(metadataPatch, patch);
            acceptedPrimary.add(field.key);
            preservedEdits++;
            return false;
          } catch {
            // Previously allowed free text remains encrypted; do not force it into typed basic metadata.
            preservedEdits++;
            return true;
          }
        });
      }
    }
    for (const row of section.rows) {
      const sourceRow = original.sections
        .find((item) => item.id === 'installation')
        ?.rows.find((item) => item.id === row.id);
      if (!sourceRow?.fields.some((field) => field.key === 'setup_cd')) continue;
      if (row.title === '설치 정보') row.title = '설치 세부 정보';
      row.fields = row.fields.filter((field) => {
        const key = installationMetadataAliases[field.key as keyof typeof installationMetadataAliases];
        if (!key) return true;
        if (changes.patches[row.id]?.addFields.some((added) => added.key === field.key)) {
          preservedEdits++;
          return true;
        }
        const edited = Object.hasOwn(changes.patches[row.id]?.values ?? {}, field.key);
        if (!edited) return false;
        preservedEdits++;
        try {
          const originalValue = sourceRow.fields.find((item) => item.key === field.key)?.value ?? '';
          const baseline = installationMetadataPatch({ [key]: aliasValue(key, originalValue) }) as Record<
            string,
            unknown
          >;
          const next = installationMetadataPatch({ [key]: aliasValue(key, field.displayValue) }) as Record<
            string,
            unknown
          >;
          if (!acceptedPrimary.has(key) && sameScalar(current[key], baseline[key])) {
            Object.assign(metadataPatch, next);
            return false;
          }
          if (sameScalar((metadataPatch as Record<string, unknown>)[key] ?? current[key], next[key]))
            return false;
        } catch {
          /* Retain old explicit free text in its encrypted detail row. */
        }
        return true;
      });
    }
    section.rows = section.rows.filter((row) => row.fields.length);
    section.rows.unshift(metadataRow(raw.id, { ...record, ...metadataPatch }));
  }
  const parsed = managedInstallationSchema.safeParse(state);
  if (!parsed.success) throw invalid();
  return { state: parsed.data, metadataPatch, preservedEdits };
}

export function managedInstallationDetails(
  id: string,
  state: ManagedInstallationState,
  revision: number,
  record?: Record<string, unknown>,
  raw = false,
): InstallationDetails {
  return {
    id,
    imported: false,
    revision,
    accessNotes: (state.accessNotes ?? []).map((note) => ({ ...note, masked: false })),
    ...(record ? { metadataRevision: installationMetadataRevision(record) } : {}),
    sections: state.sections.map((section) => ({
      id: section.id,
      title: section.title,
      imported: false,
      rows: section.rows.map((saved) => {
        const row = saved.managed && record ? metadataRow(id, record) : saved;
        const result: InstallationDetailRow = {
          id: row.id,
          title: row.title,
          ...(row.managed ? { managed: row.managed } : {}),
          fields: row.fields.map((field) => ({
            id: field.id,
            key: field.key,
            label: field.label,
            value: raw ? field.value : field.displayValue,
            secret: field.secret,
            masked: false,
            present: field.value.length > 0,
          })),
        };
        return result;
      }),
    })),
  };
}

export function managedInstallationCounts(state: ManagedInstallationState) {
  const rows = state.sections.flatMap((section) => section.rows);
  return { rowCount: rows.length, fieldCount: rows.reduce((count, row) => count + row.fields.length, 0) };
}
