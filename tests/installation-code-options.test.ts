import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Request, type RequestHandler, type Response } from 'express';
import test, { type TestContext } from 'node:test';
import { CatalogService, createCatalogRouter } from '../server/catalog.ts';
import { installationWorkspaceField } from '../server/installation-details.ts';
import { installationRequest, InstallationRequestError } from '../src/installation-api.ts';
import InstallationCodeOptionInput from '../src/InstallationCodeOptionInput.tsx';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  InstallationOptionRegistrationController,
  installationCodeGroupForField,
  installationOptionDisplayValue,
  installationOptionRegistrationMatchesTarget,
  normalizeInstallationOptionName,
  parseInstallationCodeOptions,
  type InstallationCodeOption,
} from '../src/installation-code-options.ts';
import { installationFieldChanged } from '../src/installation-editor.ts';
import { prepareInstallationSectionOperations } from '../src/installation-client.ts';
import type { InstallationDetails } from '../src/installation-types.ts';

const option: InstallationCodeOption = {
  id: 'fixture-access-remote',
  revision: 1,
  active: true,
  group: 'access_type',
  groupName: '접근 유형',
  code: 'REMOTE',
  name: '원격 접속',
  parentCode: '',
  numericValue: null,
};

async function catalogFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ieumdesk-install-options-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new CatalogService('demo', path.join(directory, 'catalog.json'), {
    keyFile: path.join(directory, 'keys', 'fixture.key'),
  });
}

function detailsFixture(optionValue = 'REMOTE', value = '원격 접속'): InstallationDetails {
  return {
    id: 'synthetic-installation',
    imported: true,
    revision: 3,
    sections: [
      {
        id: 'access',
        title: '접근 정보',
        imported: true,
        rows: [
          {
            id: 'synthetic-access-row',
            title: '합성 접근 기록',
            fields: [
              {
                id: 'synthetic-access-type',
                key: 'access_type',
                label: '접근 유형',
                value,
                optionValue,
                secret: false,
                masked: false,
                present: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

async function startRouter(t: TestContext, service: CatalogService) {
  void t;
  const requireAdmin: RequestHandler = (request, response, next) =>
    request.authUser?.role === 'admin' && request.authUser.status === 'active'
      ? next()
      : response.status(403).json({ code: 'ADMIN_REQUIRED' });
  const router = createCatalogRouter(service, requireAdmin, {
    assertActive: async () => undefined,
    send: async (_request, response, _area, payload, status = 200) => {
      response.status(status).json(payload);
    },
  });
  return {
    router,
  };
}

function routeHandler(
  router: ReturnType<typeof createCatalogRouter>,
  method: string,
  routePath: string,
  index: number,
) {
  const layer = (
    router as unknown as {
      stack: Array<{
        route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> };
      }>;
    }
  ).stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer?.route);
  const handler = layer.route.stack[index]?.handle;
  assert.ok(handler);
  return handler;
}

function request(
  role: 'admin' | 'viewer',
  method: string,
  query: Record<string, string> = {},
  body?: unknown,
) {
  return {
    method,
    query,
    body,
    aborted: false,
    originalUrl: '/catalog/codes',
    authUser: {
      id: 'synthetic-admin',
      email: 'synthetic@example.test',
      name: 'Synthetic User',
      role,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      passwordHash: 'synthetic-only',
    },
  } as unknown as Request;
}

function response() {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
    destroyed: false,
    writableEnded: false,
    status(code: number) {
      state.statusCode = code;
      return state;
    },
    json(body: unknown) {
      state.body = body;
      state.writableEnded = true;
      return state;
    },
  };
  return state as unknown as Response & { statusCode: number; body: unknown };
}

test('installation option groups are limited to safe built-in detail fields', () => {
  assert.equal(installationCodeGroupForField('access', 'access_type', '접근 유형'), 'access_type');
  assert.equal(
    installationCodeGroupForField('access', 'ssl_manage_type', 'SSL 관리 유형'),
    'ssl_manage_type',
  );
  assert.equal(installationCodeGroupForField('yeta', 'app_type', '구분'), 'app_type');
  assert.equal(installationCodeGroupForField('sap', 'app_type', '구분'), 'app_type');
  assert.equal(installationCodeGroupForField('settings', 'setting_type', '설정 종류'), 'setting_type');
  assert.equal(installationCodeGroupForField('installation', 'sv_version', '서비스 버전'), undefined);
  assert.equal(installationCodeGroupForField('installation', 'ct_cd', '고객사 코드'), undefined);
  assert.equal(installationCodeGroupForField('access', 'access_type', '비밀번호'), undefined);
});

test('option names accept category text and reject credential-like or URL-like input', () => {
  assert.equal(normalizeInstallationOptionName('  원격 접속 / VPN-1  '), '원격 접속 / VPN-1');
  for (const value of [
    '',
    'https://example.test',
    'www.example.test',
    '비밀번호',
    'admin token',
    '계정 입력',
    'x\nnext',
  ])
    assert.equal(normalizeInstallationOptionName(value), undefined, value);
  assert.equal(normalizeInstallationOptionName('a'.repeat(81)), undefined);
});

test('previously stored safe category values remain ordinary details; credential-like text stays protected', () => {
  const direct = installationWorkspaceField(
    'access',
    'synthetic-row',
    'access_type',
    '접근 유형',
    '방문 접속',
  );
  assert.equal(direct.secret, false);
  assert.equal(direct.value, '방문 접속');
  assert.equal(direct.optionValue, '방문 접속');
  const credential = installationWorkspaceField(
    'access',
    'synthetic-row',
    'access_type',
    '접근 유형',
    'password reset',
  );
  assert.equal(credential.secret, true);
  assert.equal(credential.value, 'password reset');
  const url = installationWorkspaceField(
    'access',
    'synthetic-row',
    'access_type',
    '접근 유형',
    'https://example.test',
  );
  assert.equal(url.secret, true);
});

test('catalog option parser accepts legacy numeric codes and skips malformed or unrelated rows independently', () => {
  const numericOption: InstallationCodeOption = {
    ...option,
    id: 'fixture-ssl-numeric',
    group: 'ssl_manage_type',
    groupName: 'SSL 관리 유형',
    code: '1',
    name: '합성 SSL 방식',
  };
  const malformed = { ...option, id: 'unsafe-name', name: 'https://example.test' };
  const unrelated = { ...option, id: 'private', group: 'passwords' };
  const items = parseInstallationCodeOptions({ items: [option, numericOption, malformed, unrelated, null] });
  assert.deepEqual(items, [option, numericOption]);
  assert.equal(parseInstallationCodeOptions({ items: [{ ...option, revision: -1 }] })?.length, 0);
});

test('legacy string and numeric codes round-trip labels and optionValue without crossing groups or marking unchanged values edited', () => {
  const numericOption: InstallationCodeOption = {
    ...option,
    id: 'fixture-ssl-numeric',
    group: 'ssl_manage_type',
    groupName: 'SSL 관리 유형',
    code: '1',
    name: '합성 SSL 방식',
  };
  const items = parseInstallationCodeOptions({ items: [option, numericOption] });
  assert.deepEqual(items, [option, numericOption]);
  assert.equal(installationOptionDisplayValue(items!, 'access_type', '원격 접속', 'REMOTE'), '원격 접속');
  assert.equal(installationOptionDisplayValue(items!, 'ssl_manage_type', '1', '1'), '합성 SSL 방식');
  assert.equal(installationOptionDisplayValue(items!, 'access_type', '1', '1'), '1');
  const details = detailsFixture();
  const field = details.sections[0].rows[0].fields[0];
  assert.equal(installationFieldChanged(field, { [field.id]: 'REMOTE' }), false);
  const unchanged = prepareInstallationSectionOperations(details, 'access', {
    values: { [field.id]: 'REMOTE' },
    titles: {},
    notes: {},
  });
  assert.deepEqual(unchanged, []);
  const changed = prepareInstallationSectionOperations(details, 'access', {
    values: { [field.id]: 'VPN_CUSTOM' },
    titles: {},
    notes: {},
  });
  assert.deepEqual(changed[0].kind, 'row-update');
  if (changed[0].kind === 'row-update')
    assert.deepEqual(changed[0].body.values, { access_type: 'VPN_CUSTOM' });
  const newRecord = prepareInstallationSectionOperations(details, 'access', {
    values: {},
    titles: {},
    notes: {},
    addedRows: [
      {
        localId: 'synthetic-new-access-row',
        title: '새 합성 접근 기록',
        fields: [{ key: 'access_type', label: '접근 유형', value: 'VPN_CUSTOM' }],
      },
    ],
  });
  assert.equal(newRecord.length, 1);
  if (newRecord[0].kind === 'row-create')
    assert.deepEqual(newRecord[0].body.fields, [
      { key: 'access_type', label: '접근 유형', value: 'VPN_CUSTOM' },
    ]);
  else assert.fail('new record should be created with the selected category code');

  const sslDetails = detailsFixture('1', '합성 SSL 방식');
  const sslField = sslDetails.sections[0].rows[0].fields[0];
  sslField.key = 'ssl_manage_type';
  sslField.label = 'SSL 관리 유형';
  assert.equal(
    installationOptionDisplayValue(items!, 'ssl_manage_type', sslField.value, sslField.optionValue),
    '합성 SSL 방식',
  );
  assert.equal(installationFieldChanged(sslField, { [sslField.id]: '1' }), false);
  assert.deepEqual(
    prepareInstallationSectionOperations(sslDetails, 'access', {
      values: { [sslField.id]: '1' },
      titles: {},
      notes: {},
    }),
    [],
  );
});

test('unknown stored values keep their existing label and remain unchanged', () => {
  const available = parseInstallationCodeOptions({ items: [option] });
  assert.ok(available);
  const unknown = detailsFixture('LEGACY_CODE', 'legacy category label');
  const field = unknown.sections[0].rows[0].fields[0];
  assert.equal(
    installationOptionDisplayValue(available, 'access_type', field.value, field.optionValue),
    field.value,
  );
  assert.equal(installationFieldChanged(field, { [field.id]: 'LEGACY_CODE' }), false);
  assert.deepEqual(
    prepareInstallationSectionOperations(unknown, 'access', {
      values: { [field.id]: 'LEGACY_CODE' },
      titles: {},
      notes: {},
    }),
    [],
  );
});

test('only administrators see the shared add control; nonadmins retain the unknown current value and get permission guidance', () => {
  const baseProps = {
    id: 'fixture-access',
    group: 'access_type' as const,
    fieldLabel: '접근 유형',
    value: 'LEGACY_CODE',
    displayValue: '기존 접근 유형',
    optionValue: 'LEGACY_CODE',
    options: [] as InstallationCodeOption[],
    loading: false,
    optionsError: '',
    disabled: false,
    target: {
      recordId: 'fixture-installation',
      sectionId: 'access' as const,
      targetId: 'fixture-field',
      fieldLabel: '접근 유형',
      fieldValue: 'LEGACY_CODE',
    },
    registration: undefined,
    onChange: () => {},
    onAdd: async () => option,
    onDismissRegistration: () => {},
    onRetryOptions: () => {},
  };
  const viewerMarkup = renderToStaticMarkup(
    createElement(InstallationCodeOptionInput, {
      ...baseProps,
      canAddSharedOptions: false,
    }),
  );
  assert.match(viewerMarkup, /<option value="LEGACY_CODE" selected="">기존 접근 유형<\/option>/);
  assert.match(viewerMarkup, /공용 선택지를 추가하려면 관리자 권한이 필요합니다\./);
  assert.doesNotMatch(viewerMarkup, /fixture-access-shared-name/);
  assert.doesNotMatch(viewerMarkup, /현재 기록에만 사용/);

  const adminMarkup = renderToStaticMarkup(
    createElement(InstallationCodeOptionInput, {
      ...baseProps,
      canAddSharedOptions: true,
    }),
  );
  assert.match(adminMarkup, /공용 선택지 추가/);
  assert.doesNotMatch(adminMarkup, /현재 기록에만 사용/);
});

test('uncertain add remains pending through failed checks and a repeated add never sends another POST', async () => {
  const controller = new InstallationOptionRegistrationController();
  const target = {
    recordId: 'synthetic-installation',
    sectionId: 'access' as const,
    targetId: 'synthetic-access-type',
    fieldLabel: '접근 유형',
    fieldValue: 'LEGACY_CODE',
  };
  let createCalls = 0;
  let checkCalls = 0;
  const input = {
    group: 'access_type',
    name: '합성 VPN',
    draftName: '합성 VPN',
    target,
    create: async () => {
      createCalls += 1;
      throw new Error('synthetic lost response');
    },
    isDefiniteFailure: () => false,
  };
  assert.equal(await controller.register(input), undefined);
  assert.equal(controller.getSnapshot()[0]?.state, 'uncertain');
  assert.equal(await controller.register(input), undefined);
  await controller.confirm(
    controller.getSnapshot()[0]!.id,
    async () => {
      checkCalls += 1;
      throw new Error('synthetic catalog read failure');
    },
    () => {},
  );
  assert.equal(await controller.register(input), undefined);
  assert.equal(createCalls, 1);
  assert.equal(checkCalls, 1);
  assert.equal(controller.getSnapshot()[0]?.name, '합성 VPN');
  assert.equal(controller.getSnapshot()[0]?.draftName, '합성 VPN');
  assert.equal(controller.getSnapshot()[0]?.state, 'uncertain');

  let loaded: readonly InstallationCodeOption[] = [];
  const id = controller.getSnapshot()[0]!.id;
  const recoveredOption = { ...option, name: '합성 VPN' };
  await controller.confirm(
    id,
    async () => [recoveredOption],
    (options) => {
      loaded = options;
    },
  );
  const found = controller.getSnapshot()[0]!;
  assert.equal(found.state, 'found');
  assert.equal(found.option?.code, option.code);
  assert.deepEqual(loaded, [recoveredOption]);
  assert.equal(
    installationOptionRegistrationMatchesTarget(found, target, 'access_type', '접근 유형', 'LEGACY_CODE'),
    true,
  );
  assert.equal(
    installationOptionRegistrationMatchesTarget(found, target, 'access_type', '접근 유형', 'CHANGED'),
    false,
  );
  assert.equal(
    installationOptionRegistrationMatchesTarget(found, target, 'access_type', '다른 필드', 'LEGACY_CODE'),
    false,
  );
  assert.equal(
    installationOptionRegistrationMatchesTarget(found, target, 'app_type', '접근 유형', 'LEGACY_CODE'),
    false,
  );
});

test('an explicit retry is enabled only after a successful check confirms absence and uses the original submitted name', async () => {
  const controller = new InstallationOptionRegistrationController();
  const target = {
    recordId: 'synthetic-installation',
    sectionId: 'access' as const,
    targetId: 'synthetic-access-type',
    fieldLabel: '접근 유형',
    fieldValue: 'LEGACY_CODE',
  };
  let createCalls = 0;
  let retriedWith: unknown[] = [];
  const recovered = await controller.register({
    group: 'access_type',
    name: '합성 최초 이름',
    draftName: '합성 최초 이름',
    target,
    create: async () => {
      createCalls += 1;
      throw new Error('synthetic lost response');
    },
    isDefiniteFailure: () => false,
  });
  assert.equal(recovered, undefined);
  const attemptId = controller.getSnapshot()[0]!.id;
  await controller.confirm(
    attemptId,
    async () => [],
    () => {},
  );
  assert.equal(controller.getSnapshot()[0]?.state, 'absent');
  controller.setDraftName(attemptId, '합성 수정 중 이름');
  let created: InstallationCodeOption | undefined;
  const retryOption = { ...option, group: 'access_type' as const, name: '합성 최초 이름' };
  await controller.retry(
    attemptId,
    async (group, name) => {
      createCalls += 1;
      retriedWith = [group, name];
      return retryOption;
    },
    () => false,
    (item) => {
      created = item;
    },
  );
  assert.equal(createCalls, 2);
  assert.deepEqual(retriedWith, ['access_type', '합성 최초 이름']);
  assert.equal(created?.code, retryOption.code);
  assert.equal(controller.getSnapshot()[0]?.state, 'found');
  assert.equal(controller.getSnapshot()[0]?.draftName, '합성 수정 중 이름');
});

test('filtered catalog API exposes shared options across records and keeps add separate from record save', async (t) => {
  const service = await catalogFixture(t);
  const { router } = await startRouter(t, service);
  const postGuard = routeHandler(router, 'post', '/codes/installation-options', 0);
  const post = routeHandler(router, 'post', '/codes/installation-options', 1);
  const denied = response();
  await postGuard(request('viewer', 'POST'), denied, () => {});
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(await service.list('codes', false, ['access_type']), []);

  // Existing catalog endpoints permit digit-leading codes; the installation option reader must accept them.
  const catalogPostGuard = routeHandler(router, 'post', '/codes', 0);
  const catalogPost = routeHandler(router, 'post', '/codes', 1);
  const legacyCreate = response();
  await catalogPostGuard(
    request(
      'admin',
      'POST',
      {},
      {
        group: 'ssl_manage_type',
        groupName: 'SSL 관리 유형',
        code: '1',
        name: '합성 SSL 방식',
        parentCode: '',
        numericValue: null,
        active: true,
      },
    ),
    legacyCreate,
    () => {},
  );
  await catalogPost(
    request(
      'admin',
      'POST',
      {},
      {
        group: 'ssl_manage_type',
        groupName: 'SSL 관리 유형',
        code: '1',
        name: '합성 SSL 방식',
        parentCode: '',
        numericValue: null,
        active: true,
      },
    ),
    legacyCreate,
    () => {},
  );
  assert.equal(legacyCreate.statusCode, 201);
  const get = routeHandler(router, 'get', '/codes', 0);
  const legacyGet = response();
  await get(request('viewer', 'GET', { groups: 'ssl_manage_type' }), legacyGet, () => {});
  assert.equal(legacyGet.statusCode, 200);
  const parsedLegacy = parseInstallationCodeOptions(legacyGet.body);
  assert.deepEqual(
    parsedLegacy?.map((item) => item.group),
    ['ssl_manage_type'],
  );
  assert.equal(parsedLegacy?.[0]?.code, '1');
  assert.equal(installationOptionDisplayValue(parsedLegacy!, 'ssl_manage_type', '1', '1'), '합성 SSL 방식');

  const invalidResponse = response();
  const invalidError = await post(
    request('admin', 'POST', {}, { group: 'access_type', name: 'https://example.test' }),
    invalidResponse,
    () => {},
  ).catch((error: { status?: number }) => error);
  assert.equal(invalidError.status, 400);
  assert.deepEqual(await service.list('codes', false, ['access_type']), []);

  const createResponse = response();
  await post(
    request('admin', 'POST', {}, { group: 'access_type', name: '합성 VPN' }),
    createResponse,
    () => {},
  );
  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.body as { item: InstallationCodeOption; created: boolean };
  assert.equal(created.created, true);
  assert.equal(created.item.group, 'access_type');
  assert.equal(parseInstallationCodeOptions({ items: [created.item] })?.[0]?.code, created.item.code);

  const repeated = response();
  await post(request('admin', 'POST', {}, { group: 'access_type', name: ' 합성 VPN ' }), repeated, () => {});
  assert.equal(repeated.statusCode, 200);
  assert.equal((repeated.body as { created: boolean }).created, false);

  const firstResponse = response();
  await get(request('viewer', 'GET', { groups: 'access_type' }), firstResponse, () => {});
  const firstRecordOptions = firstResponse.body as { items: InstallationCodeOption[] };
  const secondResponse = response();
  await get(request('viewer', 'GET', { groups: 'access_type' }), secondResponse, () => {});
  const secondRecordOptions = secondResponse.body as { items: InstallationCodeOption[] };
  assert.equal(firstRecordOptions.items.filter((item) => item.name === '합성 VPN').length, 1);
  assert.equal(secondRecordOptions.items[0].code, created.item.code);
  const unrelatedResponse = response();
  await get(request('viewer', 'GET', { groups: 'app_type' }), unrelatedResponse, () => {});
  const unrelated = unrelatedResponse.body as { items: InstallationCodeOption[] };
  assert.deepEqual(unrelated.items, []);

  // No installation row write is involved: canceling the record draft cannot roll back this shared catalog entry.
  assert.equal((await service.list('codes', false, ['access_type'])).length, 1);
});

test('option response parse failure is explicit so the editor can keep the value and offer a reload', () => {
  assert.equal(parseInstallationCodeOptions({ items: 'not-an-array' }), undefined);
  assert.equal(parseInstallationCodeOptions(null), undefined);
  assert.deepEqual(parseInstallationCodeOptions({ items: [{ ...option, revision: -1 }] }), []);
});

test('responsive option controls keep their contents shrinkable and stack add actions on mobile', async () => {
  const css = await readFile(path.resolve('src/installation-record-editor.css'), 'utf8');
  assert.match(
    css,
    /\.installation-inline-editor \.installation-code-option-control\s*\{[^}]*min-width:\s*0/s,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.installation-inline-editor \.installation-code-option-add-actions > \*\s*\{\s*flex:\s*1 1 100%/,
  );
});

test('a 403 while adding a shared option reports permission failure without clearing the record draft', async () => {
  const target = globalThis as typeof globalThis & { window?: EventTarget };
  const originalFetch = globalThis.fetch;
  const originalWindow = target.window;
  const events: string[] = [];
  let draftValue = '현재 분류';
  let status = 403;
  const windowEvents = new EventTarget();
  windowEvents.addEventListener('crm:permissions-changed', () => {
    events.push('permissions');
    draftValue = '';
  });
  windowEvents.addEventListener('crm:unauthorized', () => {
    events.push('unauthorized');
    draftValue = '';
  });
  target.window = windowEvents;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: '요청을 확인해 주세요.' } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    await assert.rejects(
      installationRequest('/catalog/codes/installation-options', {
        method: 'POST',
        body: JSON.stringify({ group: 'access_type', name: '새 분류' }),
        preserveDraftOnPermissionDenied: true,
      }),
      (error: unknown) => error instanceof InstallationRequestError && error.outcome === 'rejected',
    );
    assert.deepEqual(events, []);
    assert.equal(draftValue, '현재 분류');
    status = 401;
    await assert.rejects(
      installationRequest('/catalog/codes/installation-options', {
        method: 'POST',
        body: JSON.stringify({ group: 'access_type', name: '새 분류' }),
        preserveDraftOnPermissionDenied: true,
      }),
      (error: unknown) => error instanceof InstallationRequestError && error.outcome === 'rejected',
    );
    assert.deepEqual(events, ['unauthorized']);
    assert.equal(draftValue, '');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete target.window;
    else target.window = originalWindow;
  }
});
