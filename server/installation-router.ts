import { trackRequestWork } from './request-limits.ts';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from './errors.ts';
import type { InstallationDetailsAccess } from './installation-details.ts';
import type { LegacyVault } from './legacy-vault.ts';
import {
  InstallationWorkspaceService,
  PostgresInstallationWorkspaceRepository,
  protectInstallationDetails,
  type InstallationWorkspaceRepository,
  type InstallationMetadataAccess,
} from './installation-workspace.ts';
import { FileInstallationWorkspaceRepository } from './installation-workspace-file.ts';
import {
  createInstallationAttachmentStore,
  INSTALLATION_ATTACHMENT_EXTENSIONS,
  INSTALLATION_ATTACHMENT_MAX_BYTES,
  type InstallationAttachmentStore,
} from './installation-attachments.ts';

export interface InstallationWorkspaceRouterOptions {
  details: InstallationDetailsAccess;
  mode: 'demo' | 'postgres';
  requireAdmin: RequestHandler;
  protectionEnabled: () => Promise<boolean>;
  /** Refresh request.authUser from the live session; reject revoked/disabled sessions. */
  assertActive?: (request: Request) => Promise<void>;
  onDisclosure?: (request: Request, installationId: string) => Promise<void>;
  repository?: InstallationWorkspaceRepository;
  attachments?: InstallationAttachmentStore;
  vault?: () => Promise<LegacyVault>;
  metadata?: InstallationMetadataAccess;
}
const parameter = (value: string | string[]) => {
  if (typeof value !== 'string') throw new ApiError(404, 'NOT_FOUND', '요청한 항목을 찾을 수 없습니다.');
  return value;
};
const protectionRequired = () =>
  new ApiError(
    403,
    'INSTALLATION_PROTECTION_ENABLED',
    '보호정보가 활성화되어 파일을 내려받을 수 없습니다. 관리자 환경설정에서 보호정보를 비활성화한 뒤 다시 시도해 주세요.',
  );
function download(response: Response, file: { name: string; mime: string; content: Buffer }) {
  if (response.destroyed || response.writableEnded) {
    file.content.fill(0);
    return;
  }
  response.set('Cache-Control', 'no-store');
  response.set('X-Content-Type-Options', 'nosniff');
  response.attachment(file.name).type(file.mime);
  // Retain bytes until Express has finished sending, then discard the buffer.
  const clear = () => file.content.fill(0);
  response.once('finish', clear);
  response.once('close', clear);
  response.send(file.content);
}

/** Mount at /api/records/installations after active-account/menu checks and before generic write gates. */
export function createInstallationWorkspace(options: InstallationWorkspaceRouterOptions) {
  const router = Router();
  const repository =
    options.repository ??
    (options.mode === 'postgres'
      ? new PostgresInstallationWorkspaceRepository()
      : new FileInstallationWorkspaceRepository());
  const access = new InstallationWorkspaceService(options.details, repository, {
    vault: options.vault,
    metadata: options.metadata,
  });
  const attachments = options.attachments ?? createInstallationAttachmentStore({ vault: options.vault });
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!request.authUser) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', '로그인이 필요합니다.');
    if (request.authUser.status !== 'active')
      throw new ApiError(403, 'ACCOUNT_PENDING', '관리자의 계정 승인이 필요합니다.');
    next();
  });
  // The app must register this upload parser before its ordinary 100 KiB parser.
  router.use(express.json({ limit: '8mb' }));
  const assertActive = async (request: Request) => {
    await options.assertActive?.(request);
    if (!request.authUser || request.authUser.status !== 'active')
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', '로그인이 필요합니다.');
  };
  const assertAdmin = async (request: Request) => {
    await assertActive(request);
    if (request.authUser!.role !== 'admin')
      throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
  };
  const protectedFor = async (request: Request) => {
    const enabled = await options.protectionEnabled();
    await assertActive(request);
    return enabled || request.authUser!.role !== 'admin';
  };
  const assertDownloadAllowed = async (request: Request) => {
    await assertAdmin(request);
    const enabled = await options.protectionEnabled();
    await assertAdmin(request);
    if (enabled) throw protectionRequired();
  };
  const disclose = async (request: Request, id: string) => {
    await assertActive(request);
    try {
      await options.onDisclosure?.(request, id);
    } catch {
      throw new ApiError(
        503,
        'INSTALLATION_DISCLOSURE_AUDIT_UNAVAILABLE',
        '보호정보 조회 기록을 저장하지 못해 정보를 표시할 수 없습니다.',
      );
    }
    await assertActive(request);
  };
  const current = async (id: string, request: Request, response: Response) => {
    const details = await access.details(id, { protected: false });
    await assertActive(request);
    let protectedValues = await protectedFor(request);
    if (!protectedValues) {
      await disclose(request, id);
      // A policy change during disclosure can only make this response more restrictive.
      protectedValues = await protectedFor(request);
    }
    // Retain a protected read for this response: a second true-to-false read must
    // never release raw values without recording a disclosure first.
    response.json(protectInstallationDetails(details, protectedValues));
  };
  router.get('/:id/details', trackRequestWork(async (request, response) =>
    current(parameter(request.params.id), request, response)),
  );
  router.post('/:id/rows', options.requireAdmin, trackRequestWork(async (request, response) => {
    try {
      await access.createRow(parameter(request.params.id), request.body, request.authUser!.id, () =>
        assertAdmin(request),
      );
      await current(parameter(request.params.id), request, response.status(201));
    } finally {
      request.body = undefined;
    }
  }));
  router.patch('/:id/rows/:rowId', options.requireAdmin, trackRequestWork(async (request, response) => {
    try {
      await access.updateRow(
        parameter(request.params.id),
        parameter(request.params.rowId),
        request.body,
        request.authUser!.id,
        () => assertAdmin(request),
      );
      await current(parameter(request.params.id), request, response);
    } finally {
      request.body = undefined;
    }
  }));
  router.delete('/:id/rows/:rowId', options.requireAdmin, trackRequestWork(async (request, response) => {
    await access.deleteRow(
      parameter(request.params.id),
      parameter(request.params.rowId),
      request.body,
      request.authUser!.id,
      () => assertAdmin(request),
    );
    await current(parameter(request.params.id), request, response);
  }));
  router.post('/:id/access-notes', options.requireAdmin, trackRequestWork(async (request, response) => {
    try {
      await access.createAccessNote(parameter(request.params.id), request.body, request.authUser!.id, () =>
        assertAdmin(request),
      );
      await current(parameter(request.params.id), request, response.status(201));
    } finally {
      request.body = undefined;
    }
  }));
  router.patch('/:id/access-notes/:noteId', options.requireAdmin, trackRequestWork(async (request, response) => {
    try {
      await access.updateAccessNote(
        parameter(request.params.id),
        parameter(request.params.noteId),
        request.body,
        request.authUser!.id,
        () => assertAdmin(request),
      );
      await current(parameter(request.params.id), request, response);
    } finally {
      request.body = undefined;
    }
  }));
  router.delete('/:id/access-notes/:noteId', options.requireAdmin, trackRequestWork(async (request, response) => {
    try {
      await access.deleteAccessNote(
        parameter(request.params.id),
        parameter(request.params.noteId),
        request.body,
        request.authUser!.id,
        () => assertAdmin(request),
      );
      await current(parameter(request.params.id), request, response);
    } finally {
      request.body = undefined;
    }
  }));
  router.get('/:id/attachments', trackRequestWork(async (request, response) => {
    await access.details(parameter(request.params.id)); // Verify the installation exists before file lookup.
    const items = await attachments.list(parameter(request.params.id));
    await assertActive(request);
    response.json({
      items,
      maxBytes: INSTALLATION_ATTACHMENT_MAX_BYTES,
      allowedExtensions: INSTALLATION_ATTACHMENT_EXTENSIONS,
      downloadsEnabled: !(await protectedFor(request)),
    });
  }));
  router.post('/:id/attachments', options.requireAdmin, trackRequestWork(async (request, response) => {
    try {
      const parsed = z
        .object({ name: z.string(), contentBase64: z.string() })
        .strict()
        .safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(400, 'INSTALLATION_ATTACHMENT_INVALID', '첨부파일 입력값을 확인해 주세요.');
      await access.details(parameter(request.params.id));
      const uploaded = await attachments.upload(parameter(request.params.id), parsed.data, () =>
        assertAdmin(request),
      );
      await assertActive(request);
      response.status(201).json(uploaded);
    } finally {
      request.body = undefined;
    }
  }));
  router.delete('/:id/attachments/:attachmentId', options.requireAdmin, trackRequestWork(async (request, response) => {
    await access.details(parameter(request.params.id));
    await attachments.remove(parameter(request.params.id), parameter(request.params.attachmentId), () =>
      assertAdmin(request),
    );
    response.status(204).end();
  }));
  router.get('/:id/attachments/:attachmentId/download', trackRequestWork(async (request, response) => {
    await assertDownloadAllowed(request);
    await access.details(parameter(request.params.id));
    const file = await attachments.download(
      parameter(request.params.id),
      parameter(request.params.attachmentId),
    );
    try {
      await disclose(request, parameter(request.params.id));
      await assertDownloadAllowed(request);
    } catch (error) {
      file.content.fill(0);
      throw error;
    }
    download(response, file);
  }));
  router.post('/:id/configuration', trackRequestWork(async (request, response) => {
    await assertDownloadAllowed(request);
    const file = await access.configuration(parameter(request.params.id), request.body ?? {});
    try {
      await disclose(request, parameter(request.params.id));
      await assertDownloadAllowed(request);
    } catch (error) {
      file.content.fill(0);
      throw error;
    }
    response.set('X-Installation-Format', 'generic-java-properties');
    response.set('X-Original-Format-Verified', 'false');
    download(response, file);
  }));
  // The retired endpoint cannot bypass administrator-only disclosure and global protection.
  router.post('/:id/secrets', () => {
    throw new ApiError(
      410,
      'INSTALLATION_REAUTH_RETIRED',
      '개별 열람 대신 관리자 환경설정의 보호정보 설정을 사용해 주세요.',
    );
  });
  return { router, access, close: () => access.close() };
}
