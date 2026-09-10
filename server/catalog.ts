import { trackRequestWork } from './request-limits.ts';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { databaseConfig } from './config.ts';
import { ApiError } from './errors.ts';
import { LegacyReader } from './legacy-reader.ts';
import { BusinessEncryption } from './business-encryption.ts';
import { openLegacyVault, type LegacyVault } from './legacy-vault.ts';
import { DemoPrivateFile } from './demo-private-file.ts';

type Kind = 'products' | 'codes';
const localQueues = new Map<string, Promise<unknown>>();
export type CatalogItem = { id: string; revision: number; active: boolean; [key: string]: unknown };
type LocalCatalog = { products: CatalogItem[]; codes: CatalogItem[] };
const localContext = {
  source: 'crm-catalog-demo',
  table: 'catalog',
  primaryKey: 'local',
  batchId: 'catalog-v1',
};
const text = (length = 200) => z.string().trim().max(length);
const product = z
  .object({
    name: text().min(1),
    unitPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    description: text(10000),
    active: z.boolean(),
    category: text(100),
    subCategory: text(100),
  })
  .strict();
const code = z
  .object({
    group: text(100).min(1),
    groupName: text(),
    code: text(100).min(1),
    name: text().min(1),
    parentCode: text(100),
    numericValue: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    active: z.boolean(),
  })
  .strict();
const storedIdentity = { id: text(200).min(1), revision: z.number().int().positive() };
const localSchema = z
  .object({ products: z.array(product.extend(storedIdentity)), codes: z.array(code.extend(storedIdentity)) })
  .strict();
const fail = () =>
  new ApiError(409, 'CATALOG_CONFLICT', '카탈로그가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.');
const identity = (kind: Kind, key: string) =>
  `legacy-${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
const scalar = (value: unknown) => (value == null ? '' : String(value));
const unavailable = () => new ApiError(503, 'CATALOG_UNAVAILABLE', '카탈로그를 확인하지 못했습니다.');
export class CatalogService {
  private legacy: LegacyReader;
  private pool?: Promise<pg.Pool>;
  private queue: Promise<unknown> = Promise.resolve();
  private encryption: BusinessEncryption;
  private localVault?: Promise<LegacyVault>;
  private localFile: DemoPrivateFile;
  constructor(
    private mode: 'demo' | 'postgres',
    private file = path.resolve(process.env.CRM_CATALOG_DEMO_FILE || '.local/crm-catalog-demo.json'),
    private options: { vault?: () => Promise<LegacyVault>; keyFile?: string } = {},
  ) {
    this.file = path.resolve(file);
    this.localFile = new DemoPrivateFile(this.file, unavailable);
    this.legacy = new LegacyReader(mode);
    this.encryption = new BusinessEncryption(options.vault);
  }
  private openLocalVault(createIfMissing = false) {
    return (this.localVault ??=
      this.options.vault?.() ??
      openLegacyVault({
        keyFile: this.options.keyFile ?? path.join(path.dirname(this.file), '.keys', 'crm-catalog.key'),
        createIfMissing,
      }));
  }
  private async connection() {
    return (this.pool ??= (async () => {
      const pool = new pg.Pool({ ...(await databaseConfig()), max: 2, allowExitOnIdle: true });
      pool.on('error', () => {});
      try {
        if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== 'yeta_crm')
          throw new Error();
        return pool;
      } catch {
        await pool.end();
        throw new ApiError(503, 'CATALOG_UNAVAILABLE', '카탈로그를 확인하지 못했습니다.');
      }
    })().catch((error) => {
      this.pool = undefined;
      throw error;
    }));
  }
  private async loadLocal(): Promise<{ data: LocalCatalog; upgrade: boolean; missing: boolean }> {
    try {
      const raw = await this.localFile.read();
      if (raw === undefined) return { data: { products: [], codes: [] }, upgrade: false, missing: true };
      const stored = JSON.parse(raw);
      if (stored?.version === 1 && stored.document) {
        return {
          data: localSchema.parse(
            JSON.parse((await this.openLocalVault()).decrypt(stored.document, localContext)),
          ),
          upgrade: false,
          missing: false,
        };
      }
      return { data: localSchema.parse(stored), upgrade: true, missing: false };
    } catch {
      throw unavailable();
    }
  }
  private async local(): Promise<LocalCatalog> {
    const loaded = await this.loadLocal();
    // Serialize the one-time local upgrade with writes; reread after acquiring the queue.
    return loaded.upgrade ? await this.mutateLocal((current) => current) : loaded.data;
  }
  private async mutateLocal<T>(operation: (data: LocalCatalog) => T): Promise<T> {
    const pending = (localQueues.get(this.file) ?? Promise.resolve()).then(async () => {
      const loaded = await this.loadLocal();
      const result = operation(loaded.data);
      await this.localFile.ensureDirectory();
      const vault = await this.openLocalVault(true);
      const persisted = await this.localFile.write(
        JSON.stringify({ version: 1, document: vault.encrypt(JSON.stringify(loaded.data), localContext) }),
        loaded.missing,
      );
      if (!persisted) throw unavailable();
      return result;
    });
    this.queue = pending.catch(() => {});
    localQueues.set(this.file, this.queue);
    const settled = this.queue;
    void settled.then(() => {
      if (localQueues.get(this.file) === settled) localQueues.delete(this.file);
    });
    return pending;
  }
  async list(kind: Kind, includeInactive = false): Promise<CatalogItem[]> {
    const original = await this.legacy.read([kind === 'products' ? 'quotation_item_tb' : 'code_tb']);
    const mapped: CatalogItem[] = original.map(({ key, data }) => {
      if (kind === 'products') {
        const amount = Number(data.amount ?? 0),
          valid = Number.isSafeInteger(amount) && amount >= 0;
        return {
          id: identity(kind, key),
          revision: 0,
          active: valid,
          name: scalar(data.qt_item_nm),
          unitPrice: valid ? amount : 0,
          description: scalar(data.conts),
          category: scalar(data.qt_bcls),
          subCategory: scalar(data.qt_mcls),
          imported: true,
        };
      }
      const numeric = Number(data.num_val),
        numericValue =
          data.num_val == null || data.num_val === '' ? null : Number.isSafeInteger(numeric) ? numeric : null;
      return {
        id: identity(kind, key),
        revision: 0,
        active: true,
        group: scalar(data.grp_cd),
        groupName: scalar(data.grp_cd_nm),
        code: scalar(data.code),
        name: scalar(data.code_nm),
        parentCode: scalar(data.parent_cd),
        numericValue,
        imported: true,
      };
    });
    const edits =
      this.mode === 'demo'
        ? (await this.local())[kind]
        : await Promise.all(
            (
              await (
                await this.connection()
              ).query('SELECT id,kind,revision,data,protected_data FROM yeta_crm.catalog WHERE kind=$1', [
                kind,
              ])
            ).rows.map(async (row) => {
              const decoded = await this.encryption.decrypt('catalog', row);
              return {
                ...(decoded.data as Record<string, unknown>),
                id: String(row.id),
                revision: Number(row.revision),
              } as CatalogItem;
            }),
          );
    const items = new Map(mapped.map((item) => [item.id, item]));
    for (const item of edits) items.set(item.id, item);
    return [...items.values()]
      .filter((item) => includeInactive || item.active)
      .sort(
        (a, b) =>
          scalar(a.group).localeCompare(scalar(b.group), 'ko') ||
          scalar(a.name).localeCompare(scalar(b.name), 'ko'),
      );
  }
  async save(kind: Kind, id: string | undefined, body: unknown, actorId: string) {
    const schema = kind === 'products' ? product : code;
    const parsed = id
      ? schema
          .partial()
          .extend({ revision: z.number().int().min(0) })
          .strict()
          .parse(body)
      : schema.parse(body);
    const current = id ? (await this.list(kind, true)).find((item) => item.id === id) : undefined;
    if (id && !current) throw new ApiError(404, 'NOT_FOUND', '카탈로그 항목을 찾을 수 없습니다.');
    const revision = id ? Number((parsed as { revision: number }).revision) : 0;
    if (current && current.revision !== revision) throw fail();
    const merged: Record<string, unknown> = { ...current, ...parsed };
    const value = schema.parse(
      Object.fromEntries(Object.keys(schema.shape).map((key) => [key, merged[key]])),
    );
    if (kind === 'codes') {
      const duplicate = (await this.list(kind, true)).some(
        (item) =>
          item.id !== id &&
          item.group === (value as { group: string }).group &&
          item.code === (value as { code: string }).code,
      );
      if (duplicate) throw new ApiError(409, 'CODE_DUPLICATE', '같은 그룹과 코드가 이미 있습니다.');
    }
    const next: CatalogItem = {
      ...value,
      id: id ?? randomUUID(),
      revision: revision + 1,
      active: value.active,
    };
    if (this.mode === 'demo') {
      return this.mutateLocal((data) => {
        const stored = data[kind].find((row) => row.id === next.id);
        if ((stored?.revision ?? 0) !== revision) throw fail();
        if (
          kind === 'codes' &&
          data.codes.some(
            (item) => item.id !== next.id && item.group === next.group && item.code === next.code,
          )
        )
          throw new ApiError(409, 'CODE_DUPLICATE', '같은 그룹과 코드가 이미 있습니다.');
        data[kind] = [...data[kind].filter((row) => row.id !== next.id), next];
        return next;
      });
    }
    const client = await (await this.connection()).connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        'SELECT revision FROM yeta_crm.catalog WHERE kind=$1 AND id=$2 FOR UPDATE',
        [kind, next.id],
      );
      if ((found.rows[0]?.revision ?? 0) !== revision) throw fail();
      const currentAuth = (
        await client.query('SELECT role,status FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE', [actorId])
      ).rows[0];
      if (currentAuth?.role !== 'admin' || currentAuth?.status !== 'active')
        throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      const encrypted = await this.encryption.encrypt('catalog', { id: next.id, kind, data: value });
      const saved = await client.query(
        `INSERT INTO yeta_crm.catalog(kind,id,revision,data,updated_by,protected_data) VALUES($1,$2,$3,$4::jsonb,$5,$7::jsonb) ON CONFLICT(kind,id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,protected_data=EXCLUDED.protected_data,updated_by=EXCLUDED.updated_by,updated_at=now() WHERE catalog.revision=$6 RETURNING id`,
        [
          kind,
          next.id,
          next.revision,
          JSON.stringify(encrypted.data),
          actorId,
          revision,
          JSON.stringify(encrypted.protected_data),
        ],
      );
      if (saved.rowCount !== 1) throw fail();
      await client.query(
        "INSERT INTO yeta_crm.workspace_audit(actor_id,action,area,result) VALUES($1,$2,'catalog','완료')",
        [actorId, id ? '카탈로그 수정' : '카탈로그 등록'],
      );
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505')
        throw new ApiError(409, 'CODE_DUPLICATE', '같은 그룹과 코드가 이미 있습니다.');
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.legacy.close();
    if (this.pool) await (await this.pool).end();
    await this.queue;
  }
}
export function createCatalogRouter(
  service: CatalogService,
  requireAdmin: RequestHandler,
  security: {
    assertActive: (request: Request) => Promise<void>;
    send: (
      request: Request,
      response: Response,
      area: Kind,
      payload: unknown,
      status?: number,
      adminOnly?: boolean,
    ) => Promise<void>;
  },
) {
  const router = Router();
  const currentAdmin = async (request: Request) => {
    await security.assertActive(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active')
      throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
  };
  for (const kind of ['products', 'codes'] as const) {
    router.get(
      `/${kind}`,
      trackRequestWork(async (request, response) => {
        const include = request.query.includeInactive === 'true';
        if (include && request.authUser?.role !== 'admin')
          throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
        await security.send(
          request,
          response,
          kind,
          { items: await service.list(kind, include) },
          200,
          include,
        );
      }),
    );
    router.post(
      `/${kind}`,
      requireAdmin,
      trackRequestWork(async (request, response) => {
        await currentAdmin(request);
        await security.send(
          request,
          response,
          kind,
          await service.save(kind, undefined, request.body, request.authUser!.id),
          201,
          true,
        );
      }),
    );
    router.patch(
      `/${kind}/:id`,
      requireAdmin,
      trackRequestWork(async (request, response) => {
        await currentAdmin(request);
        await security.send(
          request,
          response,
          kind,
          await service.save(kind, String(request.params.id), request.body, request.authUser!.id),
          200,
          true,
        );
      }),
    );
  }
  return router;
}
