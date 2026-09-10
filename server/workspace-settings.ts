import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { ApiError } from './errors.ts';
import { databaseConfig } from './config.ts';
import { decodeAuthIdentity } from './auth-identity.ts';
import { openLegacyVault, type LegacyVault } from './legacy-vault.ts';
import { DemoPrivateFile } from './demo-private-file.ts';
import {
  defaultWorkspaceSettings,
  defaultWorkspaceBranding,
  validWorkspaceName,
  menuDefinitions,
  validWorkspaceSettings,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
  type WorkspaceAudit,
} from '../src/workspace-types.ts';

const nameSchema = z
  .string()
  .trim()
  .refine(validWorkspaceName, '표시 이름은 공백 없이 시작하고 끝나는 1~60자의 한 줄 문구로 입력해 주세요.');
export const workspacePatchSchema = z
  .object({
    revision: z.number().int().positive(),
    brandName: nameSchema.optional(),
    workspaceName: nameSchema.optional(),
    protectionEnabled: z.boolean().optional(),
    menus: z
      .object(Object.fromEntries(menuDefinitions.map(([key]) => [key, z.boolean().optional()])))
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.brandName !== undefined ||
      value.workspaceName !== undefined ||
      value.protectionEnabled !== undefined ||
      (value.menus && Object.keys(value.menus).length > 0),
    '변경할 설정을 선택해 주세요.',
  );
export type AuditInput = { actorId: string; action: string; area: string; result: string; fields?: string[] };
export interface WorkspaceSettingsAccess {
  get(): Promise<WorkspaceSettings>;
  save(input: WorkspaceSettingsPatch, actorId: string): Promise<WorkspaceSettings>;
  audit(input: AuditInput): Promise<void>;
  audits(): Promise<WorkspaceAudit[]>;
  close?(): Promise<void>;
}
const conflict = () =>
  new ApiError(
    409,
    'SETTINGS_CONFLICT',
    '다른 관리자가 설정을 변경했습니다. 최신 설정을 불러온 뒤 다시 저장해 주세요.',
  );
const unavailable = () =>
  new ApiError(
    503,
    'WORKSPACE_SETTINGS_UNAVAILABLE',
    '환경설정을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  );
const merge = (current: WorkspaceSettings, input: WorkspaceSettingsPatch): WorkspaceSettings => {
  if (current.revision !== input.revision) throw conflict();
  return {
    ...current,
    revision: current.revision + 1,
    brandName: input.brandName ?? current.brandName,
    workspaceName: input.workspaceName ?? current.workspaceName,
    protectionEnabled: input.protectionEnabled ?? current.protectionEnabled,
    menus: { ...current.menus, ...input.menus },
    updatedAt: new Date().toISOString(),
  };
};
const changed = (input: WorkspaceSettingsPatch) => [
  ...(input.brandName === undefined ? [] : ['brandName']),
  ...(input.workspaceName === undefined ? [] : ['workspaceName']),
  ...(input.protectionEnabled === undefined ? [] : ['protectionEnabled']),
  ...Object.keys(input.menus ?? {}).map((key) => `menus.${key}`),
];

const localQueues = new Map<string, Promise<unknown>>();
export class DemoWorkspaceSettings implements WorkspaceSettingsAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly storage: DemoPrivateFile;
  constructor(
    private file = path.resolve(process.env.CRM_SETTINGS_DEMO_FILE || '.local/crm-workspace-demo.json'),
  ) {
    this.file = path.resolve(file);
    this.storage = new DemoPrivateFile(this.file, unavailable);
  }
  private async read(): Promise<{
    value: { settings: WorkspaceSettings; audit: WorkspaceAudit[] };
    missing: boolean;
  }> {
    try {
      const raw = await this.storage.read();
      if (raw === undefined)
        return { value: { settings: defaultWorkspaceSettings(), audit: [] }, missing: true };
      const data = JSON.parse(raw);
      // Old files have no branding fields. Add defaults in memory without changing policy or writing the file.
      if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings))
        data.settings = { ...defaultWorkspaceBranding, ...data.settings };
      if (!validWorkspaceSettings(data.settings) || !Array.isArray(data.audit)) throw unavailable();
      return { value: data, missing: false };
    } catch {
      throw unavailable();
    }
  }
  async get() {
    return structuredClone((await this.read()).value.settings);
  }
  private async update<T>(
    operation: (data: { settings: WorkspaceSettings; audit: WorkspaceAudit[] }) => T,
  ): Promise<T> {
    const pending = (localQueues.get(this.file) ?? Promise.resolve()).then(async () => {
      const { value: data, missing } = await this.read();
      const result = operation(data);
      if (!(await this.storage.write(JSON.stringify(data), missing))) throw conflict();
      return result;
    });
    this.queue = pending.catch(() => undefined);
    localQueues.set(this.file, this.queue);
    const settled = this.queue;
    void settled.then(() => {
      if (localQueues.get(this.file) === settled) localQueues.delete(this.file);
    });
    return pending;
  }
  async save(input: WorkspaceSettingsPatch, actorId: string) {
    const parsed = workspacePatchSchema.parse(input) as WorkspaceSettingsPatch;
    return this.update((data) => {
      data.settings = merge(data.settings, parsed);
      data.audit.unshift({
        id: randomUUID(),
        actorName: actorId,
        action: '환경설정 저장',
        area: 'settings',
        result: '완료',
        fields: changed(parsed),
        createdAt: new Date().toISOString(),
      });
      return structuredClone(data.settings);
    });
  }
  async audit(input: AuditInput) {
    await this.update((data) => {
      data.audit.unshift({
        id: randomUUID(),
        actorName: input.actorId,
        action: input.action,
        area: input.area,
        result: input.result,
        fields: input.fields ?? [],
        createdAt: new Date().toISOString(),
      });
      data.audit = data.audit.slice(0, 5000);
    });
  }
  async audits() {
    return (await this.read()).value.audit.slice(0, 200);
  }
}

export class PostgresWorkspaceSettings implements WorkspaceSettingsAccess {
  private pool?: Promise<pg.Pool>;
  constructor(
    private getVault: () => Promise<LegacyVault> = () => openLegacyVault({ createIfMissing: false }),
  ) {}
  private async connection() {
    if (!this.pool)
      this.pool = (async () => {
        const pool = new pg.Pool({ ...(await databaseConfig()), max: 2, allowExitOnIdle: true });
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
      });
    return this.pool;
  }
  private decode(row: { revision: number; data: unknown; updated_at: Date | string } | undefined) {
    if (!row || !row.data || typeof row.data !== 'object') throw unavailable();
    const defaults = defaultWorkspaceSettings();
    const data = row.data as Partial<WorkspaceSettings>;
    const settings = {
      ...defaults,
      ...data,
      menus: { ...defaults.menus, ...data.menus },
      revision: Number(row.revision),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
    if (!validWorkspaceSettings(settings)) throw unavailable();
    return settings;
  }
  async get() {
    return this.decode(
      (
        await (
          await this.connection()
        ).query('SELECT revision,data,updated_at FROM yeta_crm.workspace_settings WHERE singleton=true')
      ).rows[0],
    );
  }
  async save(input: WorkspaceSettingsPatch, actorId: string) {
    const parsed = workspacePatchSchema.parse(input) as WorkspaceSettingsPatch;
    const client = await (await this.connection()).connect();
    try {
      await client.query('BEGIN');
      const current = this.decode(
        (
          await client.query(
            'SELECT revision,data,updated_at FROM yeta_crm.workspace_settings WHERE singleton=true FOR UPDATE',
          )
        ).rows[0],
      );
      const actor = (
        await client.query('SELECT role,status FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE', [actorId])
      ).rows[0];
      if (actor?.role !== 'admin' || actor?.status !== 'active')
        throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      const next = merge(current, parsed);
      await client.query(
        'UPDATE yeta_crm.workspace_settings SET revision=$1,data=$2::jsonb,updated_at=$3,updated_by=$4 WHERE singleton=true',
        [
          next.revision,
          JSON.stringify({
            brandName: next.brandName,
            workspaceName: next.workspaceName,
            protectionEnabled: next.protectionEnabled,
            menus: next.menus,
          }),
          next.updatedAt,
          actorId,
        ],
      );
      await client.query(
        "INSERT INTO yeta_crm.workspace_audit(actor_id,action,area,result,fields) VALUES($1,'환경설정 저장','settings','완료',$2::jsonb)",
        [actorId, JSON.stringify(changed(parsed))],
      );
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async audit(input: AuditInput) {
    await (
      await this.connection()
    ).query(
      'INSERT INTO yeta_crm.workspace_audit(actor_id,action,area,result,fields) VALUES($1,$2,$3,$4,$5::jsonb)',
      [input.actorId, input.action, input.area, input.result, JSON.stringify(input.fields ?? [])],
    );
  }
  async audits(): Promise<WorkspaceAudit[]> {
    const rows = (
      await (
        await this.connection()
      ).query(
        `SELECT a.id::text AS id,u.id AS "actorId",u.email AS "actorEmail",u.name AS "actorStoredName",u.identity_cipher AS "actorIdentityCipher",a.action,a.area,a.result,a.fields,a.created_at AS "createdAt" FROM yeta_crm.workspace_audit a LEFT JOIN yeta_crm.auth_users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200`,
      )
    ).rows;
    const vault = rows.some((row) => row.actorId) ? await this.getVault() : undefined;
    return rows.map(
      ({ actorId, actorEmail, actorStoredName, actorIdentityCipher, ...row }) =>
        ({
          ...row,
          actorName: actorId
            ? decodeAuthIdentity(vault!, {
                id: actorId,
                email: actorEmail,
                name: actorStoredName,
                identityCipher: actorIdentityCipher,
              }).name
            : '탈퇴한 사용자',
          createdAt: new Date(row.createdAt).toISOString(),
        }) as WorkspaceAudit,
    );
  }
  async close() {
    if (this.pool) await (await this.pool).end();
  }
}
