import { Router, type Request, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readdir, open, unlink, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import pg, { type Pool } from 'pg';
import { z } from 'zod';
import { ApiError } from './errors.ts';
import { trackRequestWork } from './request-limits.ts';
import { databaseConfig } from './config.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';
import { backupFailure, privateFile, safeDirectory, writeExclusive, syncDirectory } from './backup-files.ts';
import {
  PostgresBackupSnapshotProvider,
  snapshotCounts,
  snapshotFingerprint,
  validateSnapshot,
  restoreBlockers,
  type BackupSnapshot,
  type BackupSnapshotProvider,
} from './backup-snapshot.ts';
import type {
  BackupHistory,
  BackupItem,
  BackupOverview,
  BackupPreview,
  BackupSchedule,
} from '../src/backup-types.ts';

const uuid = z.uuid();
const context = (id: string) => ({
  source: 'yeta-crm-backup:v1',
  table: 'snapshot',
  primaryKey: id,
  batchId: '1',
});
interface Archive {
  version: 1;
  id: string;
  createdAt: string;
  reason: BackupItem['reason'];
  snapshot: BackupSnapshot;
}
interface Artifact {
  format: 'yeta-crm-encrypted-backup-v1';
  id: string;
  envelope: LegacyVaultEnvelope;
}
export interface BackupControl {
  schedule(): Promise<BackupSchedule>;
  updateSchedule(input: {
    revision: number;
    enabled: boolean;
    intervalHours: number;
  }): Promise<BackupSchedule>;
  claimDue(): Promise<boolean>;
  history(): Promise<BackupHistory[]>;
  record(
    action: string,
    outcome: 'success' | 'failed',
    backupId: string | null,
    actorId?: string,
    code?: string,
  ): Promise<void>;
  close(): Promise<void>;
}
export class PostgresBackupControl implements BackupControl {
  private pool?: Pool;
  private async get() {
    this.pool ??= new pg.Pool({
      ...(await databaseConfig(false)),
      max: 1,
      allowExitOnIdle: true,
      application_name: 'ieumdesk_backup_control',
    });
    if ((await this.pool.query('SELECT current_database() AS database')).rows[0]?.database !== 'yeta_crm')
      throw backupFailure('BACKUP_DATABASE_MISMATCH');
    return this.pool;
  }
  private scheduleRow(row: Record<string, unknown>): BackupSchedule {
    return {
      revision: Number(row.revision),
      enabled: row.enabled === true,
      intervalHours: Number(row.interval_hours),
      nextRunAt: row.next_run_at ? new Date(row.next_run_at as string).toISOString() : null,
    };
  }
  async schedule() {
    const row = (
      await (await this.get()).query('SELECT * FROM yeta_crm_private.backup_schedule WHERE singleton')
    ).rows[0];
    if (!row) throw backupFailure('BACKUP_SCHEMA_REQUIRED');
    return this.scheduleRow(row);
  }
  async updateSchedule(input: { revision: number; enabled: boolean; intervalHours: number }) {
    const row = (
      await (
        await this.get()
      ).query(
        `UPDATE yeta_crm_private.backup_schedule SET revision=revision+1,enabled=$2,interval_hours=$3,next_run_at=CASE WHEN $2 THEN now()+($3::text||' hours')::interval ELSE NULL END,updated_at=now() WHERE singleton AND revision=$1 RETURNING *`,
        [input.revision, input.enabled, input.intervalHours],
      )
    ).rows[0];
    if (!row) throw backupFailure('BACKUP_SCHEDULE_CONFLICT');
    return this.scheduleRow(row);
  }
  async claimDue() {
    return (
      ((
        await (
          await this.get()
        ).query(
          `UPDATE yeta_crm_private.backup_schedule SET next_run_at=now()+(interval_hours::text||' hours')::interval WHERE singleton AND enabled AND next_run_at<=now() RETURNING singleton`,
        )
      ).rowCount ?? 0) === 1
    );
  }
  async history() {
    return (
      await (
        await this.get()
      ).query(
        `SELECT id,action,outcome,backup_id AS "backupId",created_at AS "createdAt",code FROM yeta_crm_private.backup_history ORDER BY created_at DESC,id DESC LIMIT 100`,
      )
    ).rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })) as BackupHistory[];
  }
  async record(
    action: string,
    outcome: 'success' | 'failed',
    backupId: string | null,
    actorId?: string,
    code?: string,
  ) {
    await (
      await this.get()
    ).query(
      'INSERT INTO yeta_crm_private.backup_history(id,action,outcome,backup_id,actor_id,code) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), action, outcome, backupId, actorId ?? null, code ?? null],
    );
  }
  async close() {
    await this.pool?.end();
    this.pool = undefined;
  }
}

export class BackupService {
  readonly directory: string;
  private vault: () => Promise<LegacyVault>;
  private verified = new Map<string, string>();
  constructor(
    readonly provider: BackupSnapshotProvider,
    readonly control: BackupControl,
    options: { directory?: string; vault?: () => Promise<LegacyVault> } = {},
  ) {
    this.directory = path.resolve(options.directory ?? '.local/backups');
    this.vault = options.vault ?? (() => openLegacyVault());
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await safeDirectory(path.dirname(this.directory), true);
    await safeDirectory(this.directory, true);
    const file = path.join(this.directory, '.operation.lock');
    let handle;
    try {
      handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw backupFailure('BACKUP_BUSY');
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await unlink(file);
    }
  }
  private async load(id: string): Promise<{ archive: Archive; content: Buffer }> {
    if (!uuid.safeParse(id).success) throw backupFailure('BACKUP_NOT_FOUND');
    await safeDirectory(this.directory);
    let content: Buffer | undefined;
    try {
      content = await privateFile(path.join(this.directory, `${id}.ycrm`));
      const artifact = JSON.parse(content.toString('utf8')) as Artifact;
      if (artifact.format !== 'yeta-crm-encrypted-backup-v1' || artifact.id !== id)
        throw backupFailure('BACKUP_INTEGRITY_FAILED');
      const archive = JSON.parse((await this.vault()).decrypt(artifact.envelope, context(id))) as Archive;
      if (
        archive.version !== 1 ||
        archive.id !== id ||
        !['manual', 'scheduled', 'pre-restore'].includes(archive.reason) ||
        !Number.isFinite(Date.parse(archive.createdAt))
      )
        throw backupFailure('BACKUP_INTEGRITY_FAILED');
      validateSnapshot(archive.snapshot);
      return { archive, content };
    } catch (error) {
      content?.fill(0);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw backupFailure('BACKUP_NOT_FOUND');
      throw backupFailure('BACKUP_INTEGRITY_FAILED');
    }
  }
  private item(archive: Archive, bytes: number): BackupItem {
    return {
      id: archive.id,
      createdAt: archive.createdAt,
      reason: archive.reason,
      bytes,
      counts: snapshotCounts(archive.snapshot),
      verifiedAt: this.verified.get(archive.id) ?? null,
    };
  }
  private async save(snapshot: BackupSnapshot, reason: BackupItem['reason']): Promise<BackupItem> {
    validateSnapshot(snapshot);
    const id = randomUUID(),
      archive: Archive = { version: 1, id, createdAt: new Date().toISOString(), reason, snapshot };
    const envelope = (await this.vault()).encrypt(JSON.stringify(archive), context(id));
    const artifact: Artifact = { format: 'yeta-crm-encrypted-backup-v1', id, envelope };
    await safeDirectory(this.directory, true);
    const pending = path.join(this.directory, `.${id}.pending`);
    await writeExclusive(pending, JSON.stringify(artifact));
    await rename(pending, path.join(this.directory, `${id}.ycrm`));
    await syncDirectory(this.directory);
    // Reopen and decrypt the durable artifact before reporting success or touching restore data.
    const checked = await this.load(id);
    try {
      if (snapshotFingerprint(checked.archive.snapshot) !== snapshotFingerprint(snapshot))
        throw backupFailure('BACKUP_INTEGRITY_FAILED');
      this.verified.set(id, new Date().toISOString());
      return this.item(archive, checked.content.length);
    } finally {
      checked.content.fill(0);
    }
  }
  async inventory(): Promise<{ items: BackupItem[]; issues: { id: string; code: string }[] }> {
    if (!(await safeDirectory(this.directory))) return { items: [], issues: [] };
    const files = (await readdir(this.directory)).filter((name) => /^[a-f\d-]{36}\.ycrm$/.test(name));
    if (files.length > 1000) throw backupFailure('BACKUP_LIST_LIMIT');
    const items: BackupItem[] = [],
      issues: { id: string; code: string }[] = [];
    for (const file of files) {
      const id = file.slice(0, -5);
      try {
        const value = await this.load(id);
        try {
          items.push(this.item(value.archive, value.content.length));
        } finally {
          value.content.fill(0);
        }
      } catch (error) {
        issues.push({ id, code: safeBackupCode(error) });
      }
    }
    return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), issues };
  }
  async list(): Promise<BackupItem[]> {
    return (await this.inventory()).items;
  }
  async create(reason: BackupItem['reason'] = 'manual', actorId?: string, guard?: () => Promise<void>) {
    return this.exclusive(async () => {
      try {
        await this.vault();
        const snapshot = await this.provider.capture();
        await guard?.();
        const item = await this.save(snapshot, reason);
        await this.control.record('create', 'success', item.id, actorId);
        return item;
      } catch (error) {
        await this.control.record('create', 'failed', null, actorId, safeBackupCode(error));
        throw error;
      }
    });
  }
  async verify(id: string, actorId?: string) {
    try {
      const { archive, content } = await this.load(id);
      try {
        this.verified.set(id, new Date().toISOString());
        await this.control.record('verify', 'success', id, actorId);
        return {
          id,
          verified: true as const,
          verifiedAt: this.verified.get(id)!,
          counts: snapshotCounts(archive.snapshot),
        };
      } finally {
        content.fill(0);
      }
    } catch (error) {
      await this.control.record(
        'verify',
        'failed',
        uuid.safeParse(id).success ? id : null,
        actorId,
        safeBackupCode(error),
      );
      throw error;
    }
  }
  async download(id: string, actorId?: string) {
    const value = await this.load(id);
    try {
      await this.control.record('download', 'success', id, actorId);
      return value.content;
    } catch (error) {
      value.content.fill(0);
      throw error;
    }
  }
  async preview(id: string): Promise<BackupPreview> {
    const value = await this.load(id);
    try {
      const current = await this.provider.capture(),
        blockedCodes = restoreBlockers(value.archive.snapshot, current);
      return {
        id,
        canRestore: !blockedCodes.length,
        blockedCodes,
        currentFingerprint: snapshotFingerprint(current),
        counts: snapshotCounts(value.archive.snapshot),
        currentCounts: snapshotCounts(current),
        requiresStoppedServer: true,
        revokesSessions: true,
      };
    } finally {
      value.content.fill(0);
    }
  }
  async restore(id: string, expectedFingerprint: string) {
    if (!/^[a-f\d]{64}$/.test(expectedFingerprint)) throw backupFailure('BACKUP_FINGERPRINT_REQUIRED');
    return this.exclusive(async () => {
      const value = await this.load(id);
      let preimage: BackupItem | undefined;
      try {
        const result = await this.provider.restore(
          value.archive.snapshot,
          expectedFingerprint,
          async (current) => {
            preimage = await this.save(current, 'pre-restore');
          },
        );
        if (!preimage) throw backupFailure('BACKUP_PREIMAGE_REQUIRED');
        try {
          await this.control.record('restore', 'success', id);
        } catch {
          throw backupFailure('BACKUP_RESTORE_COMMITTED_HISTORY_FAILED');
        }
        return { id, restored: true, preimageId: preimage.id, ...result };
      } catch (error) {
        await this.control.record('restore', 'failed', id, undefined, safeBackupCode(error));
        throw error;
      } finally {
        value.content.fill(0);
      }
    });
  }
  async close() {
    await Promise.all([this.provider.close(), this.control.close()]);
  }
}
export const safeBackupCode = (error: unknown) =>
  error instanceof Error && /^BACKUP_[A-Z_]+$/.test(error.message) ? error.message : 'BACKUP_UNAVAILABLE';
const publicError = (error: unknown) => {
  if (error instanceof ApiError) return error;
  const code = safeBackupCode(error);
  return new ApiError(
    code === 'BACKUP_NOT_FOUND' ? 404 : code.endsWith('CONFLICT') || code.includes('BUSY') ? 409 : 503,
    code,
    (
      {
        BACKUP_NOT_FOUND: '백업을 찾을 수 없습니다.',
        BACKUP_INTEGRITY_FAILED: '백업 무결성 또는 암호화 키를 확인해 주세요.',
        BACKUP_SCHEDULE_CONFLICT: '백업 설정이 변경되었습니다. 새로고침 후 다시 시도해 주세요.',
        BACKUP_BUSY: '다른 백업 작업이 진행 중입니다.',
        BACKUP_FILES_BUSY: '첨부파일 작업 중입니다. 잠시 후 다시 시도해 주세요.',
      } as Record<string, string>
    )[code] ?? '백업 작업을 완료하지 못했습니다. 관리 이력과 서버 상태를 확인해 주세요.',
  );
};

export function createBackupManager(options: {
  mode: 'demo' | 'postgres';
  requireAdmin: RequestHandler;
  assertActive?: (request: Request) => Promise<void>;
  onAudit?: (request: Request, action: string) => Promise<void>;
  service?: BackupService;
}) {
  const router = Router(),
    service =
      options.service ?? new BackupService(new PostgresBackupSnapshotProvider(), new PostgresBackupControl());
  const supported = options.mode === 'postgres' || Boolean(options.service);
  const admin = async (request: Request) => {
    await options.assertActive?.(request);
    if (!request.authUser || request.authUser.status !== 'active' || request.authUser.role !== 'admin')
      throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
  };
  router.use(
    options.requireAdmin,
    trackRequestWork(async (request, response, next) => {
      response.set('Cache-Control', 'no-store');
      await admin(request);
      if (!supported)
        throw new ApiError(
          409,
          'BACKUP_POSTGRES_REQUIRED',
          '실제 PostgreSQL 모드에서 백업을 사용할 수 있습니다.',
        );
      next();
    }),
  );
  const wrap = (action: RequestHandler): RequestHandler =>
    trackRequestWork(async (request, response, next) => {
      try {
        await action(request, response, next);
      } catch (error) {
        next(publicError(error));
      }
    });
  router.get(
    '/',
    wrap(async (request, response) => {
      const [inventory, schedule] = await Promise.all([service.inventory(), service.control.schedule()]);
      await admin(request);
      response.json({
        ...inventory,
        schedule,
        capabilities: {
          supported,
          format: 'encrypted-structured-v1',
          automaticRequiresRunningServer: true,
          restore: 'cli-only',
          keyIncluded: false,
        },
      } satisfies BackupOverview);
    }),
  );
  router.get(
    '/history',
    wrap(async (request, response) => {
      const items = await service.control.history();
      await admin(request);
      response.json({ items });
    }),
  );
  router.patch(
    '/schedule',
    wrap(async (request, response) => {
      const input = z
        .object({
          revision: z.number().int().positive(),
          enabled: z.boolean(),
          intervalHours: z.number().int().min(1).max(168),
        })
        .strict()
        .safeParse(request.body);
      if (!input.success)
        throw new ApiError(400, 'BACKUP_SCHEDULE_INVALID', '백업 주기와 설정을 확인해 주세요.');
      await admin(request);
      const schedule = await service.control.updateSchedule(input.data);
      await service.control.record('schedule', 'success', null, request.authUser!.id);
      await options.onAudit?.(request, 'backup.schedule');
      response.json(schedule);
    }),
  );
  router.post(
    '/',
    wrap(async (request, response) => {
      const item = await service.create('manual', request.authUser!.id, () => admin(request));
      await admin(request);
      response.status(201).json(item);
    }),
  );
  router.post(
    '/:id/verify',
    wrap(async (request, response) => {
      const result = await service.verify(String(request.params.id), request.authUser!.id);
      await admin(request);
      response.json(result);
    }),
  );
  router.post(
    '/:id/restore-preview',
    wrap(async (request, response) => {
      const result = await service.preview(String(request.params.id));
      await admin(request);
      response.json(result);
    }),
  );
  router.get(
    '/:id/download',
    wrap(async (request, response) => {
      const id = String(request.params.id),
        content = await service.download(id, request.authUser!.id);
      if (request.aborted || response.destroyed || response.writableEnded) {
        content.fill(0);
        return;
      }
      try {
        await admin(request);
      } catch (error) {
        content.fill(0);
        throw error;
      }
      if (request.aborted || response.destroyed || response.writableEnded) {
        content.fill(0);
        return;
      }
      response.set('Cache-Control', 'no-store');
      response.attachment(`ieumdesk-${id}.ycrm`).type('application/octet-stream');
      const clear = () => content.fill(0);
      response.once('finish', clear);
      response.once('close', clear);
      response.send(content);
    }),
  );
  let timer: NodeJS.Timeout | undefined,
    pending: Promise<void> | undefined,
    stopped = false;
  const tick = async () => {
    if (stopped || pending || !supported) return;
    pending = (async () => {
      try {
        if (await service.control.claimDue()) await service.create('scheduled');
      } catch (error) {
        try {
          await service.control.record('scheduler', 'failed', null, undefined, safeBackupCode(error));
        } catch {
          /* No payload or connection diagnostics are logged. */
        }
      }
    })();
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  };
  return {
    router,
    service,
    runScheduled: tick,
    startScheduler: () => {
      if (timer || !supported) return;
      stopped = false;
      timer = setInterval(() => {
        void tick();
      }, 60_000);
      timer.unref();
      void tick();
    },
    close: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await pending;
      await service.close();
    },
  };
}
