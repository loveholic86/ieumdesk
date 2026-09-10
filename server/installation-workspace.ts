import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { ApiError, notFound } from './errors.ts';
import { databaseConfig } from './config.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';
import { installationWorkspaceField, type InstallationDetailsAccess } from './installation-details.ts';
import type {
  InstallationDetails,
  InstallationDetailRow,
  InstallationSectionId,
  InstallationWorkspaceFieldInput,
} from '../src/installation-types.ts';
import type { RecordInput } from './validation.ts';
import { installationMetadataPatch, installationMetadataRevision } from './installation-metadata.ts';
import {
  buildManagedInstallation,
  managedField,
  managedInstallationCounts,
  managedInstallationDetails,
  managedInstallationSchema,
  managedMetadataRowId,
  installationAccessNoteIdSchema,
  installationAccessNoteContentSchema,
  type ManagedInstallationState,
} from './installation-managed.ts';

const SOURCE = 'yeta-crm-workspace:v1';
const MASK = '••••••••';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bad = () =>
  new ApiError(400, 'INSTALLATION_WORKSPACE_INVALID', '설치 항목의 입력값과 길이를 확인해 주세요.');
const unavailable = () =>
  new ApiError(
    503,
    'INSTALLATION_WORKSPACE_UNAVAILABLE',
    '설치 작업본을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  );
const conflict = () =>
  new ApiError(
    409,
    'INSTALLATION_REVISION_CONFLICT',
    '다른 작업에서 설치 정보가 변경되었습니다. 새로고침한 뒤 다시 저장해 주세요.',
  );
const keySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z\d_.-]{0,79}$/)
  .refine((key) => !['constructor', 'prototype', '__proto__'].includes(key));
const valueSchema = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes('\0') && Buffer.from(value).toString('utf8') === value);
const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const inputField = z.object({ key: keySchema, label: titleSchema, value: valueSchema }).strict();
const sectionSchema = z.enum(['installation', 'access', 'server', 'yeta', 'sap', 'settings', 'files']);
const revisionSchema = z.number().int().min(0).max(2_147_483_646);
export const installationRowCreateSchema = z
  .object({
    revision: revisionSchema,
    sectionId: sectionSchema,
    title: titleSchema,
    fields: z.array(inputField).min(1).max(80),
  })
  .strict();
export const installationRowPatchSchema = z
  .object({
    revision: revisionSchema,
    metadataRevision: z
      .string()
      .regex(/^[a-f\d]{64}$/)
      .optional(),
    title: titleSchema.optional(),
    values: z.record(keySchema, valueSchema).optional(),
    removeFields: z.array(keySchema).max(80).optional(),
    addFields: z.array(inputField).max(80).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      Object.keys(value.values ?? {}).length > 0 ||
      Boolean(value.removeFields?.length) ||
      Boolean(value.addFields?.length),
  );
export const installationRowDeleteSchema = z.object({ revision: revisionSchema }).strict();
export const installationAccessNoteInputSchema = z
  .object({ revision: revisionSchema, content: installationAccessNoteContentSchema })
  .strict();
export const installationAccessNoteDeleteSchema = z.object({ revision: revisionSchema }).strict();
const patchSchema = z
  .object({
    title: titleSchema.optional(),
    values: z.record(keySchema, valueSchema),
    removeFields: z.array(keySchema),
    addFields: z.array(inputField),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    added: z
      .array(
        z
          .object({
            id: z.string().regex(/^workspace-row-[a-f\d-]{36}$/),
            sectionId: sectionSchema,
            title: titleSchema,
            fields: z.array(inputField).min(1).max(80),
          })
          .strict(),
      )
      .max(300),
    deleted: z.array(z.string().max(100)).max(1_000),
    patches: z.record(z.string().max(100), patchSchema),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
export type InstallationWorkspaceStored = { revision: number; envelope: LegacyVaultEnvelope };
type Stored = InstallationWorkspaceStored;
export type InstallationWorkspaceAction =
  'row-create' | 'row-update' | 'row-delete' | 'materialize' | 'note-create' | 'note-update' | 'note-delete';
export interface InstallationWorkspaceRepository {
  get(id: string): Promise<Stored | undefined>;
  save(
    id: string,
    expected: number,
    envelope: LegacyVaultEnvelope,
    actorUserId: string,
    action: InstallationWorkspaceAction,
  ): Promise<number>;
  close?(): Promise<void>;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw bad();
  return result.data;
}
const context = (id: string, revision: number) => ({
  source: SOURCE,
  table: 'installation_workspace',
  primaryKey: id,
  batchId: String(revision),
});
const blank = (): State => ({ version: 1, added: [], deleted: [], patches: {} });
function unique(fields: InstallationWorkspaceFieldInput[]) {
  if (new Set(fields.map((field) => field.key)).size !== fields.length) throw bad();
}

export function protectInstallationDetails(
  details: InstallationDetails,
  protectedValues = true,
): InstallationDetails {
  const result = structuredClone(details);
  result.accessNotes = (result.accessNotes ?? []).map((note) => ({
    ...note,
    content: protectedValues ? MASK : note.content,
    masked: protectedValues,
  }));
  for (const section of result.sections)
    for (const row of section.rows)
      for (const field of row.fields) {
        field.masked = protectedValues && field.secret && field.present;
        if (field.masked) field.value = MASK;
      }
  return result;
}

class LegacyInstallationWorkspaceService {
  constructor(
    private base: InstallationDetailsAccess,
    private repository: InstallationWorkspaceRepository,
    private options: { vault?: () => Promise<LegacyVault> } = {},
  ) {}
  private async vault() {
    return (this.options.vault ?? (() => openLegacyVault({ createIfMissing: false })))();
  }
  private async load(id: string) {
    const record = await this.repository.get(id);
    if (!record) return { revision: 0, state: blank() };
    try {
      if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw unavailable();
      const raw = (await this.vault()).decrypt(record.envelope, context(id, record.revision));
      if (Buffer.byteLength(raw) > 1_048_576) throw unavailable();
      const state = stateSchema.parse(JSON.parse(raw));
      for (const row of state.added) unique(row.fields);
      return { revision: record.revision, state };
    } catch {
      throw unavailable();
    }
  }
  private apply(
    base: InstallationDetails,
    state: State,
    revision: number,
    raw: boolean,
  ): InstallationDetails {
    const result = structuredClone(base);
    result.revision = revision;
    for (const section of result.sections) {
      section.rows = section.rows.filter((row) => !state.deleted.includes(row.id));
      for (const added of state.added.filter((row) => row.sectionId === section.id)) {
        const fields = added.fields.map((field) =>
          installationWorkspaceField(section.id, added.id, field.key, field.label, field.value),
        );
        if (raw)
          fields.forEach((field, index) => {
            field.value = added.fields[index].value;
          });
        section.rows.push({ id: added.id, title: added.title, fields });
      }
      for (const row of section.rows) {
        const patch = state.patches[row.id];
        if (!patch) continue;
        if (patch.title !== undefined) row.title = patch.title;
        row.fields = row.fields.filter((field) => !patch.removeFields.includes(field.key));
        for (const field of row.fields)
          if (Object.hasOwn(patch.values, field.key)) {
            const next = installationWorkspaceField(
              section.id,
              row.id,
              field.key,
              field.label,
              patch.values[field.key],
            );
            if (raw) next.value = patch.values[field.key];
            Object.assign(field, next);
          }
        for (const field of patch.addFields) {
          const next = installationWorkspaceField(section.id, row.id, field.key, field.label, field.value);
          if (raw) next.value = field.value;
          row.fields.push(next);
        }
      }
      if (
        section.rows.some(
          (row) => row.id.startsWith('workspace-row-') || Object.hasOwn(state.patches, row.id),
        )
      )
        section.note = '이관 원본을 보존하고 암호화된 작업본의 변경을 적용한 정보입니다.';
    }
    return result;
  }
  async managed(id: string, record?: Record<string, unknown>) {
    const rawBase = await this.base.details(id, { protected: false, raw: true });
    const displayBase = await this.base.details(id, { protected: false });
    const loaded = await this.load(id);
    const raw = this.apply(rawBase, loaded.state, loaded.revision, true);
    const display = this.apply(displayBase, loaded.state, loaded.revision, false);
    return {
      ...buildManagedInstallation(raw, display, displayBase, loaded.state, record),
      expectedRevision: loaded.revision,
    };
  }
}

function configurationFile(details: InstallationDetails, input: unknown) {
  const filter = parse(
    z
      .object({
        systemCode: z.string().min(1).max(80).optional(),
        year: z
          .string()
          .regex(/^\d{4}$/)
          .optional(),
      })
      .strict(),
    input,
  );
  const rows = details.sections.find((section) => section.id === 'files')!.rows;
  const properties = new Map<string, string>();
  const scopes = new Set<string>();
  for (const row of rows) {
    const value = (key: string) => row.fields.find((field) => field.key === key)?.value ?? '';
    if (filter.systemCode !== undefined && value('system_code') !== filter.systemCode) continue;
    if (filter.year !== undefined && value('att_year') !== filter.year) continue;
    const key = value('set_name');
    if (!key || !row.fields.some((field) => field.key === 'set_value')) continue;
    if (properties.has(key))
      throw new ApiError(
        409,
        'INSTALLATION_CONFIGURATION_DUPLICATE',
        '같은 설정 키가 여러 개 있습니다. 시스템과 연도를 선택하거나 중복 항목을 정리해 주세요.',
      );
    properties.set(key, value('set_value'));
    scopes.add(JSON.stringify([value('system_code'), value('att_year')]));
  }
  if (scopes.size > 1)
    throw new ApiError(
      409,
      'INSTALLATION_CONFIGURATION_SCOPE_REQUIRED',
      '설정 파일을 생성할 시스템과 연도를 선택해 주세요.',
    );
  if (!properties.size)
    throw new ApiError(
      409,
      'INSTALLATION_CONFIGURATION_EMPTY',
      '선택한 시스템과 연도에 설정 키·값이 없습니다.',
    );
  const header = '# Generic Java properties export\n# Original YETA delivery format has not been verified.\n';
  return {
    name: 'yeta-installation.properties',
    mime: 'text/plain; charset=us-ascii',
    content: Buffer.from(
      header +
        [...properties.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${escapeProperty(key)}=${escapeProperty(value)}\n`)
          .join(''),
      'ascii',
    ),
  };
}

export interface InstallationMetadataAccess {
  read(id: string): Promise<Record<string, unknown>>;
  update(
    id: string,
    values: Record<string, string>,
    expectedRevision: string,
    actorId: string,
  ): Promise<void>;
}
export interface InstallationMaterialization {
  id: string;
  expectedRevision: number;
  nextRevision: number;
  envelope?: LegacyVaultEnvelope;
  fingerprint: string;
  alreadyMaterialized: boolean;
  rowCount: number;
  fieldCount: number;
  metadataPatch: Partial<RecordInput>;
  preservedEdits: number;
}

/** Operational details own their complete encrypted data; basic metadata is shared with the list. */
export class InstallationWorkspaceService {
  private legacy: LegacyInstallationWorkspaceService;
  constructor(
    private base: InstallationDetailsAccess,
    private repository: InstallationWorkspaceRepository,
    private options: {
      vault?: () => Promise<LegacyVault>;
      metadata?: InstallationMetadataAccess;
      now?: () => number;
    } = {},
  ) {
    this.legacy = new LegacyInstallationWorkspaceService(base, repository, options);
  }
  private async vault() {
    return (this.options.vault ?? (() => openLegacyVault({ createIfMissing: false })))();
  }
  private timestamp() {
    try {
      return new Date((this.options.now ?? Date.now)()).toISOString();
    } catch {
      throw unavailable();
    }
  }
  private async document(id: string) {
    const stored = await this.repository.get(id);
    if (!stored) return { revision: 0, state: undefined };
    try {
      if (!Number.isSafeInteger(stored.revision) || stored.revision < 1) throw unavailable();
      const plaintext = (await this.vault()).decrypt(stored.envelope, context(id, stored.revision));
      if (Buffer.byteLength(plaintext) > 8 * 1_048_576) throw unavailable();
      const parsed = JSON.parse(plaintext);
      if (parsed.version === 1) {
        if (Buffer.byteLength(plaintext) > 1_048_576) throw unavailable();
        stateSchema.parse(parsed);
        return { revision: stored.revision, state: undefined };
      }
      return { revision: stored.revision, state: managedInstallationSchema.parse(parsed) };
    } catch {
      throw unavailable();
    }
  }
  private async effective(id: string) {
    const loaded = await this.document(id);
    // Current-record lookup also rejects archived/deleted installations without opening the import archive.
    const record = await this.options.metadata?.read(id);
    if (loaded.state)
      return {
        ...loaded,
        state: loaded.state,
        record,
        metadataPatch: {} as Partial<RecordInput>,
        preservedEdits: 0,
      };
    const prepared = await this.legacy.managed(id, record);
    if (prepared.expectedRevision !== loaded.revision) throw conflict();
    return {
      revision: loaded.revision,
      state: prepared.state,
      record,
      metadataPatch: prepared.metadataPatch,
      preservedEdits: prepared.preservedEdits,
    };
  }
  async details(id: string, options: { protected?: boolean; raw?: boolean } = {}) {
    const current = await this.effective(id);
    const record = current.record ? { ...current.record, ...current.metadataPatch } : undefined;
    return protectInstallationDetails(
      managedInstallationDetails(id, current.state, current.revision, record, Boolean(options.raw)),
      options.protected !== false,
    );
  }
  async prepareMaterialization(id: string): Promise<InstallationMaterialization> {
    const before = await this.document(id),
      current = await this.effective(id);
    if (before.revision !== current.revision) throw conflict();
    const state = managedInstallationSchema.parse(current.state);
    const fingerprint = hash(
      JSON.stringify({
        id,
        revision: current.revision,
        state,
        metadata: current.record ?? null,
        patch: current.metadataPatch,
      }),
    );
    const result: InstallationMaterialization = {
      id,
      expectedRevision: current.revision,
      nextRevision: before.state ? current.revision : current.revision + 1,
      fingerprint,
      alreadyMaterialized: Boolean(before.state),
      ...managedInstallationCounts(state),
      metadataPatch: current.metadataPatch,
      preservedEdits: current.preservedEdits,
    };
    if (!before.state) result.envelope = await this.encrypt(id, result.nextRevision, state);
    return result;
  }
  private async encrypt(id: string, revision: number, state: ManagedInstallationState) {
    const serialized = JSON.stringify(managedInstallationSchema.parse(state));
    if (Buffer.byteLength(serialized) > 8 * 1_048_576)
      throw new ApiError(
        413,
        'INSTALLATION_WORKSPACE_TOO_LARGE',
        '설치 상세정보의 최대 용량을 초과했습니다.',
      );
    try {
      return (await this.vault()).encrypt(serialized, context(id, revision));
    } catch {
      throw unavailable();
    }
  }
  private async mutate(
    id: string,
    expected: number,
    actor: string,
    action: InstallationWorkspaceAction,
    change: (state: ManagedInstallationState) => void,
    guard?: () => Promise<void>,
  ) {
    const current = await this.effective(id);
    if (expected !== current.revision) throw conflict();
    if (Object.keys(current.metadataPatch).length)
      throw new ApiError(
        409,
        'INSTALLATION_INTEGRATION_REQUIRED',
        '기존 수정 내용을 설치 기본정보에 연결하는 작업이 필요합니다. 자료는 보존됩니다.',
      );
    change(current.state);
    const envelope = await this.encrypt(id, expected + 1, current.state);
    await guard?.();
    await this.repository.save(id, expected, envelope, actor, action);
  }
  async createRow(id: string, input: unknown, actor: string, guard?: () => Promise<void>) {
    const data = parse(installationRowCreateSchema, input);
    unique(data.fields);
    await this.mutate(
      id,
      data.revision,
      actor,
      'row-create',
      (state) => {
        if (managedInstallationCounts(state).rowCount >= 1_000) throw bad();
        const rowId = `workspace-row-${randomUUID()}`;
        state.sections
          .find((section) => section.id === data.sectionId)!
          .rows.push({
            id: rowId,
            title: data.title,
            fields: data.fields.map((field) =>
              managedField(data.sectionId, rowId, field.key, field.label, field.value),
            ),
          });
      },
      guard,
    );
  }
  async updateRow(id: string, rowId: string, input: unknown, actor: string, guard?: () => Promise<void>) {
    const data = parse(installationRowPatchSchema, input);
    if (rowId === managedMetadataRowId(id)) {
      if (
        !this.options.metadata ||
        data.title !== undefined ||
        data.removeFields?.length ||
        data.addFields?.length ||
        !data.metadataRevision ||
        !Object.keys(data.values ?? {}).length
      )
        throw bad();
      const current = await this.effective(id);
      if (current.revision !== data.revision) throw conflict();
      if (
        !current.state.sections.some((section) => section.rows.some((row) => row.id === rowId && row.managed))
      )
        throw notFound();
      if (Object.keys(current.metadataPatch).length)
        throw new ApiError(
          409,
          'INSTALLATION_INTEGRATION_REQUIRED',
          '기존 수정 내용의 연결을 먼저 완료해 주세요.',
        );
      installationMetadataPatch(data.values!);
      if (installationMetadataRevision(current.record!) !== data.metadataRevision)
        throw new ApiError(
          409,
          'INSTALLATION_METADATA_CONFLICT',
          '설치 기본정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.',
        );
      await guard?.();
      await this.options.metadata.update(id, data.values!, data.metadataRevision, actor);
      return;
    }
    await this.mutate(
      id,
      data.revision,
      actor,
      'row-update',
      (state) => {
        const section = state.sections.find((section) => section.rows.some((row) => row.id === rowId));
        const row = section?.rows.find((row) => row.id === rowId);
        if (!row || !section) throw notFound();
        if (row.managed) throw bad();
        const existing = new Set(row.fields.map((field) => field.key)),
          removed = new Set(data.removeFields ?? []);
        if (
          [...removed, ...Object.keys(data.values ?? {})].some((key) => !existing.has(key)) ||
          Object.keys(data.values ?? {}).some((key) => removed.has(key))
        )
          throw bad();
        unique(data.addFields ?? []);
        if ((data.addFields ?? []).some((field) => existing.has(field.key) && !removed.has(field.key)))
          throw bad();
        const length = row.fields.length - removed.size + (data.addFields?.length ?? 0);
        if (length < 1 || length > 80) throw bad();
        if (data.title !== undefined) row.title = data.title;
        row.fields = row.fields
          .filter((field) => !removed.has(field.key))
          .map((field) => {
            if (!Object.hasOwn(data.values ?? {}, field.key)) return field;
            return {
              ...managedField(section.id, row.id, field.key, field.label, data.values![field.key]),
              id: field.id,
            };
          });
        row.fields.push(
          ...(data.addFields ?? []).map((field) =>
            managedField(section.id, row.id, field.key, field.label, field.value),
          ),
        );
      },
      guard,
    );
  }
  async deleteRow(id: string, rowId: string, input: unknown, actor: string, guard?: () => Promise<void>) {
    const data = parse(installationRowDeleteSchema, input);
    if (rowId === managedMetadataRowId(id)) throw bad();
    await this.mutate(
      id,
      data.revision,
      actor,
      'row-delete',
      (state) => {
        const section = state.sections.find((section) => section.rows.some((row) => row.id === rowId));
        const row = section?.rows.find((row) => row.id === rowId);
        if (!section || !row) throw notFound();
        if (row.managed) throw bad();
        section.rows = section.rows.filter((row) => row.id !== rowId);
      },
      guard,
    );
  }
  async createAccessNote(id: string, input: unknown, actor: string, guard?: () => Promise<void>) {
    const data = parse(installationAccessNoteInputSchema, input);
    await this.mutate(
      id,
      data.revision,
      actor,
      'note-create',
      (state) => {
        const notes = state.accessNotes ?? [];
        if (notes.length >= 1_000)
          throw new ApiError(
            409,
            'INSTALLATION_ACCESS_NOTES_LIMIT',
            '참고사항은 최대 1,000개까지 등록할 수 있습니다.',
          );
        state.accessNotes = [
          ...notes,
          { id: randomUUID(), content: data.content, createdAt: this.timestamp() },
        ];
      },
      guard,
    );
  }
  async updateAccessNote(
    id: string,
    noteId: string,
    input: unknown,
    actor: string,
    guard?: () => Promise<void>,
  ) {
    const key = parse(installationAccessNoteIdSchema, noteId).toLowerCase();
    const data = parse(installationAccessNoteInputSchema, input);
    await this.mutate(
      id,
      data.revision,
      actor,
      'note-update',
      (state) => {
        const note = state.accessNotes?.find((note) => note.id.toLowerCase() === key);
        if (!note) throw notFound();
        note.content = data.content;
        note.updatedAt = this.timestamp();
      },
      guard,
    );
  }
  async deleteAccessNote(
    id: string,
    noteId: string,
    input: unknown,
    actor: string,
    guard?: () => Promise<void>,
  ) {
    const key = parse(installationAccessNoteIdSchema, noteId).toLowerCase();
    const data = parse(installationAccessNoteDeleteSchema, input);
    await this.mutate(
      id,
      data.revision,
      actor,
      'note-delete',
      (state) => {
        if (!state.accessNotes?.some((note) => note.id.toLowerCase() === key)) throw notFound();
        state.accessNotes = state.accessNotes.filter((note) => note.id.toLowerCase() !== key);
      },
      guard,
    );
  }
  async configuration(id: string, input: unknown) {
    return configurationFile(await this.details(id, { protected: false, raw: true }), input);
  }
  async close() {
    await this.repository.close?.();
  }
}

export function escapeProperty(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index],
      code = value.charCodeAt(index);
    if (character === '\\') result += '\\\\';
    else if (character === '\n') result += '\\n';
    else if (character === '\r') result += '\\r';
    else if (character === '\t') result += '\\t';
    else if (character === '\f') result += '\\f';
    else if (' =:#!'.includes(character)) result += `\\${character}`;
    else if (code < 0x20 || code > 0x7e) result += `\\u${code.toString(16).padStart(4, '0')}`;
    else result += character;
  }
  return result;
}

export class MemoryInstallationWorkspaceRepository implements InstallationWorkspaceRepository {
  readonly records = new Map<string, Stored>();
  async get(id: string) {
    const value = this.records.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async save(id: string, expected: number, envelope: LegacyVaultEnvelope) {
    if ((this.records.get(id)?.revision ?? 0) !== expected) throw conflict();
    const revision = expected + 1;
    this.records.set(id, { revision, envelope: structuredClone(envelope) });
    return revision;
  }
}

export class PostgresInstallationWorkspaceRepository implements InstallationWorkspaceRepository {
  private pool?: Promise<pg.Pool>;
  private async connection() {
    return (this.pool ??= (async () => {
      const pool = new pg.Pool({ ...(await databaseConfig(false)), max: 2, allowExitOnIdle: true });
      pool.on('error', () => {});
      try {
        if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== 'yeta_crm')
          throw unavailable();
        return pool;
      } catch {
        await pool.end();
        throw unavailable();
      }
    })().catch((error) => {
      this.pool = undefined;
      throw error;
    }));
  }
  async get(id: string): Promise<Stored | undefined> {
    try {
      return (
        await (
          await this.connection()
        ).query(
          'SELECT revision,envelope FROM yeta_crm_private.installation_workspace WHERE installation_id=$1',
          [id],
        )
      ).rows[0];
    } catch {
      throw unavailable();
    }
  }
  async save(
    id: string,
    expected: number,
    envelope: LegacyVaultEnvelope,
    actor: string,
    action: InstallationWorkspaceAction,
  ) {
    const client = await (await this.connection()).connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('installation-workspace:' || $1))", [id]);
      if (
        !(
          await client.query(
            "SELECT 1 FROM yeta_crm.records WHERE id=$1 AND kind='installations' AND archived_at IS NULL FOR UPDATE",
            [id],
          )
        ).rowCount
      )
        throw notFound();
      const current = (
        await client.query(
          'SELECT revision FROM yeta_crm_private.installation_workspace WHERE installation_id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if ((current?.revision ?? 0) !== expected) throw conflict();
      const account = (
        await client.query('SELECT role,status FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE', [actor])
      ).rows[0];
      if (account?.role !== 'admin' || account?.status !== 'active')
        throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      await client.query(
        'INSERT INTO yeta_crm_private.installation_workspace(installation_id,revision,envelope,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(installation_id) DO UPDATE SET revision=EXCLUDED.revision,envelope=EXCLUDED.envelope,updated_by=EXCLUDED.updated_by,updated_at=now()',
        [id, expected + 1, envelope, actor],
      );
      await client.query(
        'INSERT INTO yeta_crm_private.installation_workspace_audit(installation_ref_hash,actor_user_id,action,revision) VALUES($1,$2,$3,$4)',
        [hash(id), actor, action, expected + 1],
      );
      await client.query('COMMIT');
      return expected + 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof ApiError) throw error;
      throw unavailable();
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool?.then((pool) => pool.end());
  }
}
