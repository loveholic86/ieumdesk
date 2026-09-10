import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { ApiError, DemoStore, type Store } from './store.ts';
import {
  companySchema,
  companyPatchSchema,
  activitySchema,
  activityPatchSchema,
  taskSchema,
  taskPatchSchema,
  querySchema,
  parseRecord,
  parseRecordPatch,
} from './validation.ts';
import type { RecordKind, QuotationRecord } from '../src/types.ts';
import { createAuthentication, type AuthOptions } from './auth.ts';
import type { AuthStore } from './auth-store.ts';
import { createInstallationDetailsAccess, type InstallationDetailsAccess } from './installation-details.ts';
import {
  DemoWorkspaceSettings,
  PostgresWorkspaceSettings,
  workspacePatchSchema,
  type WorkspaceSettingsAccess,
} from './workspace-settings.ts';
import type { WorkspaceSettingsPatch } from '../src/workspace-types.ts';
import { assertQuotationPermission } from './records.ts';
import {
  createInstallationWorkspace,
  type InstallationWorkspaceRouterOptions,
} from './installation-router.ts';
import { CatalogService, createCatalogRouter } from './catalog.ts';
import { createArchiveRouter } from './archive.ts';
import { SupportService, createSupportRouter } from './support.ts';
import { createBackupManager } from './backup.ts';
import { installationMetadataPatch } from './installation-metadata.ts';
import { prepareBusinessDisclosure, type BusinessArea } from './business-disclosure.ts';
import { requireCrmRequestHeader } from './csrf-defense.ts';
import { createRequestLimits, trackRequestWork } from './request-limits.ts';
import { validLocalAuthority, validateRequestShape, validateJsonStructure } from './request-validation.ts';

const developmentOrigins = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);
const recordKind = (value: string): RecordKind => {
  if (!['contacts', 'sales', 'quotations', 'installations'].includes(value))
    throw new ApiError(404, 'NOT_FOUND', '요청한 업무 항목을 찾을 수 없습니다.');
  return value as RecordKind;
};
export function assertLocalDevelopment(environment = process.env.NODE_ENV) {
  if (environment === 'production') throw new Error('PRODUCTION_AUTHENTICATION_REQUIRED');
}
export function createApp(
  store: Store,
  authStore?: AuthStore,
  authOptions?: AuthOptions,
  installationAccess?: InstallationDetailsAccess,
  options: {
    workspace?: WorkspaceSettingsAccess;
    support?: SupportService;
    catalog?: CatalogService;
    installation?: Pick<InstallationWorkspaceRouterOptions, 'repository' | 'attachments' | 'vault'>;
  } = {},
) {
  assertLocalDevelopment();
  if (!authStore) throw new Error('AUTH_STORE_REQUIRED');
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  app.set('query parser', 'simple');
  app.use(helmet({ referrerPolicy: { policy: 'no-referrer' }, frameguard: { action: 'deny' } }));
  // Apply before origin checks and body parsing so rejected requests are not cached either.
  app.use('/api', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    response.set('Expires', '0');
    if (/\/(?:download|configuration)$/.test(request.path)) {
      response.set(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
    }
    next();
  });
  app.use('/api', createRequestLimits());
  app.use(validateRequestShape);
  // The API stays local until HTTPS and deployment-domain policy are configured.
  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (
      !validLocalAuthority(request.headers.host || '') ||
      (origin && !developmentOrigins.has(origin)) ||
      request.get('sec-fetch-site') === 'cross-site' ||
      // A browser request from another same-site port still needs an allowed Origin.
      (request.get('sec-fetch-site') === 'same-site' && !origin)
    ) {
      response
        .status(403)
        .json({ error: { code: 'LOCAL_ONLY', message: '이 개발 서버는 로컬 접속만 허용합니다.' } });
      return;
    }
    if (['POST', 'PATCH', 'PUT'].includes(request.method) && !request.is('application/json')) {
      response
        .status(415)
        .json({ error: { code: 'JSON_REQUIRED', message: 'JSON 형식으로 요청해 주세요.' } });
      return;
    }
    next();
  });
  app.use('/api', requireCrmRequestHeader);
  app.use('/api/records/installations/:id/attachments', express.json({ limit: '8mb', inflate: false }));
  app.use('/api/support/:id/attachments', express.json({ limit: '8mb', inflate: false }));
  app.use('/api/support', express.json({ limit: '1mb', inflate: false }));
  app.use(express.json({ limit: '100kb', inflate: false }));
  app.use('/api', validateJsonStructure);
  const auth = createAuthentication(authStore, authOptions);
  const installation = installationAccess ?? createInstallationDetailsAccess(store);
  const workspace =
    options.workspace ??
    (store.mode === 'postgres'
      ? new PostgresWorkspaceSettings()
      : new DemoWorkspaceSettings(
          process.env.CRM_SETTINGS_DEMO_FILE ??
            (store instanceof DemoStore ? `${store.storageFile}.settings.json` : undefined),
        ));
  app.locals.installationDetailsAccess = installation;
  app.locals.workspaceSettingsAccess = workspace;
  const assertActive = async (request: Request) => {
    const current = request.authTokenHash
      ? await authStore.getSession(
          request.authTokenHash,
          new Date((authOptions?.now ?? Date.now)()).toISOString(),
        )
      : undefined;
    if (!current || current.status !== 'active' || current.id !== request.authUser?.id)
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', '로그인이 필요합니다.');
    request.authUser = current;
  };
  const sendBusiness = async (
    request: Request,
    response: Response,
    area: BusinessArea,
    payload: unknown,
    status = 200,
    adminOnly = false,
  ) => {
    if (request.aborted || response.destroyed || response.writableEnded) return;
    const body = await prepareBusinessDisclosure(area, payload, {
      settings: () => workspace.get(),
      assertActive: async () => {
        await assertActive(request);
        if (adminOnly && request.authUser!.role !== 'admin')
          throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
        return request.authUser!;
      },
    });
    if (!request.aborted && !response.destroyed && !response.writableEnded)
      response.status(status).json(body);
  };
  const installationWorkspace = createInstallationWorkspace({
    details: installation,
    mode: store.mode,
    requireAdmin: auth.requireAdmin,
    ...options.installation,
    metadata: {
      async read(id) {
        const record = (await store.listRecords('installations')).find((row) => row.id === id);
        if (!record) throw new ApiError(404, 'NOT_FOUND', '설치 정보를 찾을 수 없습니다.');
        return record as unknown as Record<string, unknown>;
      },
      async update(id, values, expectedRevision, actorId) {
        await store.updateInstallationMetadata(id, installationMetadataPatch(values), expectedRevision, {
          id: actorId,
          name: '',
          role: 'admin',
        });
      },
    },
    protectionEnabled: async () => (await workspace.get()).protectionEnabled,
    assertActive,
    onDisclosure: async (request) => {
      await workspace.audit({
        actorId: request.authUser!.id,
        action: '보호 정보 조회',
        area: 'installations',
        result: '완료',
      });
    },
  });
  app.locals.installationWorkspace = installationWorkspace;
  const catalog = options.catalog ?? new CatalogService(store.mode);
  app.locals.catalogService = catalog;
  const support = options.support ?? new SupportService(store);
  app.locals.supportService = support;
  const backups = createBackupManager({
    mode: store.mode,
    requireAdmin: auth.requireAdmin,
    assertActive,
    onAudit: async (request, action) =>
      workspace.audit({ actorId: request.authUser!.id, action, area: 'backups', result: '완료' }),
  });
  app.locals.backupManager = backups;
  app.use('/api/auth', auth.router);
  app.use('/api/admin', auth.admin);
  app.use('/api', auth.requireActive);
  const pendingAuditWrites = new Set<Promise<void>>();
  app.locals.flushAuditWrites = async () => {
    await Promise.allSettled([...pendingAuditWrites]);
  };
  app.use(
    '/api',
    trackRequestWork(async (request, response, next) => {
      if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return next();
      const matched = /^\/(companies|activities|tasks|records)(?:\/|$)/.exec(request.path);
      if (!matched) return next();
      await assertActive(request);
      const area =
        matched[1] === 'records' &&
        ['contacts', 'sales', 'quotations', 'installations'].includes(request.path.split('/')[2])
          ? request.path.split('/')[2]
          : matched[1];
      const action = (
        { POST: '등록 요청', PATCH: '수정 요청', PUT: '수정 요청', DELETE: '삭제 요청' } as Record<
          string,
          string
        >
      )[request.method];
      const actorId = request.authUser!.id;
      // Record the attempt before changing data; request values are never copied into the audit.
      await workspace.audit({ actorId, action, area, result: '요청' });
      response.once('finish', () => {
        const write = workspace
          .audit({
            actorId,
            action,
            area,
            result: response.statusCode < 400 ? '완료' : `실패 (${response.statusCode})`,
          })
          .catch(() => {
            app.locals.auditWriteFailed = true;
          });
        pendingAuditWrites.add(write);
        void write.finally(() => pendingAuditWrites.delete(write));
      });
      next();
    }),
  );
  app.get(
    '/api/settings',
    trackRequestWork(async (_request, response) => {
      response.json(await workspace.get());
    }),
  );
  app.patch(
    '/api/settings',
    auth.requireAdmin,
    trackRequestWork(async (request, response) => {
      await assertActive(request);
      if (request.authUser!.role !== 'admin')
        throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      response.json(
        await workspace.save(
          workspacePatchSchema.parse(request.body) as WorkspaceSettingsPatch,
          request.authUser!.id,
        ),
      );
    }),
  );
  app.get(
    '/api/settings/audit',
    auth.requireAdmin,
    trackRequestWork(async (_request, response) => {
      response.json({ items: await workspace.audits() });
    }),
  );
  app.use(
    '/api/catalog',
    createCatalogRouter(catalog, auth.requireAdmin, { assertActive, send: sendBusiness }),
  );
  app.use('/api/backups', backups.router);
  app.use(
    '/api/support',
    createSupportRouter(support, workspace, auth.requireAdmin, auth.requireEditor, assertActive),
  );
  app.post(
    '/api/archive/companies/:id',
    auth.requireAdmin,
    trackRequestWork(async (request, _response, next) => {
      if (await support.countCompany(String(request.params.id)))
        throw new ApiError(
          409,
          'COMPANY_HAS_SUPPORT',
          '연결된 고객지원 자료를 먼저 휴지통으로 이동해 주세요.',
        );
      next();
    }),
  );
  app.use('/api/archive', createArchiveRouter(store, auth.requireAdmin));
  app.use('/api/records/installations', installationWorkspace.router);
  app.use('/api', (request, response, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method))
      return auth.requireEditor(request, response, next);
    next();
  });
  app.get(
    '/api/health',
    trackRequestWork(async (_request, response) => {
      await store.health();
      response.json({
        status: 'ok',
        mode: store.mode,
        database: store.mode === 'postgres' ? 'connected' : 'not-connected',
      });
    }),
  );
  app.get(
    '/api/companies',
    trackRequestWork(async (request, response) => {
      await sendBusiness(
        request,
        response,
        'companies',
        await store.listCompanies(querySchema.parse(request.query)),
      );
    }),
  );
  app.get(
    '/api/companies/:id',
    trackRequestWork(async (request, response) => {
      await sendBusiness(request, response, 'companies', await store.getCompany(String(request.params.id)));
    }),
  );
  app.post(
    '/api/companies',
    trackRequestWork(async (request, response) => {
      await sendBusiness(
        request,
        response,
        'companies',
        await store.createCompany(companySchema.parse(request.body)),
        201,
      );
    }),
  );
  app.patch(
    '/api/companies/:id',
    trackRequestWork(async (request, response) => {
      const patch = companyPatchSchema.parse(request.body);
      if (!Object.keys(patch).length) throw new ApiError(400, 'EMPTY_PATCH', '변경할 항목을 입력해 주세요.');
      await sendBusiness(
        request,
        response,
        'companies',
        await store.updateCompany(String(request.params.id), patch),
      );
    }),
  );
  app.get(
    '/api/activities',
    trackRequestWork(async (request, response) => {
      await sendBusiness(request, response, 'activities', { items: await store.listAllActivities() });
    }),
  );
  app.get(
    '/api/companies/:id/activities',
    trackRequestWork(async (request, response) => {
      await sendBusiness(request, response, 'activities', {
        items: await store.listActivities(String(request.params.id)),
      });
    }),
  );
  app.post(
    '/api/companies/:id/activities',
    trackRequestWork(async (request, response) => {
      await sendBusiness(
        request,
        response,
        'activities',
        await store.createActivity(
          String(request.params.id),
          activitySchema.parse({ ...request.body, author: request.authUser!.name }),
        ),
        201,
      );
    }),
  );
  app.patch(
    '/api/activities/:id',
    trackRequestWork(async (request, response) => {
      const patch = activityPatchSchema.parse(request.body);
      if (!Object.keys(patch).length) throw new ApiError(400, 'EMPTY_PATCH', '변경할 항목을 입력해 주세요.');
      await sendBusiness(
        request,
        response,
        'activities',
        await store.updateActivity(String(request.params.id), patch),
      );
    }),
  );
  app.get(
    '/api/tasks',
    trackRequestWork(async (request, response) => {
      await sendBusiness(request, response, 'tasks', { items: await store.listTasks() });
    }),
  );
  app.post(
    '/api/tasks',
    trackRequestWork(async (request, response) => {
      await sendBusiness(
        request,
        response,
        'tasks',
        await store.createTask(taskSchema.parse(request.body)),
        201,
      );
    }),
  );
  app.patch(
    '/api/tasks/:id',
    trackRequestWork(async (request, response) => {
      const patch = taskPatchSchema.parse(request.body);
      if (!Object.keys(patch).length) throw new ApiError(400, 'EMPTY_PATCH', '변경할 항목을 입력해 주세요.');
      await sendBusiness(
        request,
        response,
        'tasks',
        await store.updateTask(String(request.params.id), patch),
      );
    }),
  );
  app.get(
    '/api/records/:kind',
    trackRequestWork(async (request, response) => {
      const kind = recordKind(String(request.params.kind));
      await sendBusiness(request, response, kind, { items: await store.listRecords(kind) });
    }),
  );
  app.post(
    '/api/records/quotations/:id/revisions',
    trackRequestWork(async (request, response) => {
      const input = parseRecord('quotations', request.body);
      assertQuotationPermission(request.authUser!.role, input);
      await sendBusiness(
        request,
        response,
        'quotations',
        await store.createQuotationRevision(String(request.params.id), input),
        201,
      );
    }),
  );
  app.post(
    '/api/records/:kind',
    trackRequestWork(async (request, response) => {
      const kind = recordKind(String(request.params.kind));
      const input = parseRecord(kind, request.body);
      if (kind === 'quotations') assertQuotationPermission(request.authUser!.role, input);
      await sendBusiness(
        request,
        response,
        kind,
        await store.createRecord(kind, input, request.authUser!),
        201,
      );
    }),
  );
  app.patch(
    '/api/records/:kind/:id',
    trackRequestWork(async (request, response) => {
      const kind = recordKind(String(request.params.kind));
      const patch = parseRecordPatch(kind, request.body);
      if (!Object.keys(patch).length) throw new ApiError(400, 'EMPTY_PATCH', '변경할 항목을 입력해 주세요.');
      if (kind === 'quotations') {
        const existing = (await store.listRecords('quotations')).find(
          (row) => row.id === String(request.params.id),
        ) as QuotationRecord | undefined;
        assertQuotationPermission(request.authUser!.role, patch, existing);
      }
      await sendBusiness(
        request,
        response,
        kind,
        await store.updateRecord(kind, String(request.params.id), patch, request.authUser!),
      );
    }),
  );
  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: '요청한 경로를 찾을 수 없습니다.' } });
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent || response.writableEnded || response.destroyed) {
      response.destroy();
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: '입력 형식과 필수 항목을 확인해 주세요.',
          fields: error.issues.map((issue) => issue.path.join('.')),
        },
      });
      return;
    }
    if (error instanceof ApiError) {
      const retry = (error as ApiError & { retryAfterSeconds?: unknown }).retryAfterSeconds;
      if (typeof retry === 'number' && Number.isInteger(retry) && retry >= 1 && retry <= 3600)
        response.set('Retry-After', String(retry));
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    const type = (error as { type?: string })?.type;
    if (['encoding.unsupported', 'charset.unsupported'].includes(type ?? '')) {
      response
        .status(415)
        .json({ error: { code: 'UNSUPPORTED_BODY_ENCODING', message: '지원하지 않는 요청 인코딩입니다.' } });
      return;
    }
    if (
      ['entity.parse.failed', 'entity.too.large', 'request.size.invalid', 'request.aborted'].includes(
        type ?? '',
      )
    ) {
      response
        .status(type === 'entity.too.large' ? 413 : 400)
        .json({ error: { code: 'INVALID_BODY', message: '요청 본문 형식 또는 크기를 확인해 주세요.' } });
      return;
    }
    // Do not expose SQL, credentials, file paths or submitted personal data.
    response.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: '저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      },
    });
  };
  app.use(errorHandler);
  return app;
}
