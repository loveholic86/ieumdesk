import 'dotenv/config';
import { createApp, assertLocalDevelopment } from './app.ts';
import { DemoStore, type Store } from './store.ts';
import { PostgresStore } from './postgres-store.ts';
import { DemoAuthStore, PostgresAuthStore, type AuthStore } from './auth-store.ts';
import type { InstallationDetailsAccess } from './installation-details.ts';
import type { WorkspaceSettingsAccess } from './workspace-settings.ts';
import type { CatalogService } from './catalog.ts';
import type { SupportService } from './support.ts';
import { createApiHttpServer } from './request-limits.ts';

let store: Store | undefined;
let authStore: AuthStore | undefined;
let installationAccess: InstallationDetailsAccess | undefined;
let workspaceAccess:WorkspaceSettingsAccess|undefined;
let installationWorkspace:{close:()=>Promise<void>}|undefined;
let catalogService:CatalogService|undefined;
let supportService:SupportService|undefined;
let backupManager:{startScheduler:()=>void;close:()=>Promise<void>}|undefined;
try {
  assertLocalDevelopment();
  const mode = process.env.CRM_DATA_MODE || 'demo';
  if (mode !== 'demo' && mode !== 'postgres') throw new Error('INVALID_DATA_MODE');
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT');
  store = mode === 'postgres' ? await PostgresStore.connect() : new DemoStore(process.env.CRM_DEMO_FILE);
  await store.health();
  authStore = mode === 'postgres' ? await PostgresAuthStore.connect() : new DemoAuthStore(process.env.CRM_AUTH_DEMO_FILE);
  await authStore.health();
  const app = createApp(store, authStore);
  installationAccess = app.locals.installationDetailsAccess as InstallationDetailsAccess;
  workspaceAccess = app.locals.workspaceSettingsAccess as WorkspaceSettingsAccess;
  installationWorkspace=app.locals.installationWorkspace;
  catalogService=app.locals.catalogService;
  supportService=app.locals.supportService;
  backupManager=app.locals.backupManager;
  backupManager?.startScheduler();
  const closeStores = async () => { await backupManager?.close(); await app.locals.flushAuditWrites?.(); await Promise.all([store?.close?.(), authStore?.close?.(), installationAccess?.close?.(),workspaceAccess?.close?.(),installationWorkspace?.close(),catalogService?.close(),supportService?.close()]); };
  const server = createApiHttpServer(app);
  server.listen(port, '127.0.0.1', () => {
    console.log(
      `ieumdesk API: http://127.0.0.1:${port} (${mode === 'demo' ? 'DEMO · 가상 고객 데이터' : 'PostgreSQL · 업무 저장소'})`,
    );
  });
  server.on('error', () => {
    console.error('API_START_FAILED: 로컬 포트 상태를 확인해 주세요.');
    process.exitCode = 1;
    void closeStores();
  });
  const stop = () => {
    server.close(() => {
      void closeStores().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  const code = (error as { code?: string; message?: string }).code || (error as Error).message;
  const messages: Record<string, string> = {
    PRODUCTION_AUTHENTICATION_REQUIRED:
      '운영용 HTTPS·접속 도메인 설정 전까지 로컬 개발 전용입니다.',
    DATABASE_SCHEMA_MISSING:
      'CRM 전용 스키마가 없습니다. db/001_initial.sql의 적용 절차를 확인해 주세요. 자동 생성하거나 데모로 전환하지 않습니다.',
    AUTH_SCHEMA_MISSING: '계정 스키마가 없습니다. db/002_auth.sql을 명시적으로 적용한 뒤 다시 실행해 주세요.',
    INVALID_DATA_MODE: 'CRM_DATA_MODE는 demo 또는 postgres여야 합니다.',
    INVALID_PORT: 'PORT는 1024~65535 정수여야 합니다.',
  };
  console.error(
    `API_START_FAILED: ${messages[code || ''] || '접속 설정, 저장소 상태와 네트워크를 확인해 주세요. 데모로 자동 전환하지 않습니다.'}`,
  );
  await store?.close?.();
  await authStore?.close?.();
  await installationAccess?.close?.();
  await workspaceAccess?.close?.();
  await installationWorkspace?.close();
  await catalogService?.close();
  await supportService?.close();
  await backupManager?.close();
  process.exitCode = 1;
}
