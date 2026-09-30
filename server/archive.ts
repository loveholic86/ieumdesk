import { trackRequestWork } from './request-limits.ts';
import { Router, type RequestHandler } from 'express';
import { archiveAreas, type ArchiveArea } from '../src/archive-types.ts';
import type { Store } from './store.ts';
import { ApiError } from './errors.ts';
const area = (value: string): ArchiveArea => {
  if (!(archiveAreas as readonly string[]).includes(value))
    throw new ApiError(404, 'NOT_FOUND', '휴지통 항목을 찾을 수 없습니다.');
  return value as ArchiveArea;
};
export function createArchiveRouter(store: Store, requireAdmin: RequestHandler, requireEditor: RequestHandler) {
  const router = Router();
  router.get(
    '/',
    requireAdmin,
    trackRequestWork(async (_request, response) => {
      response.json({ items: await store.listArchived() });
    }),
  );
  router.post(
    '/:area/:id',
    requireEditor,
    trackRequestWork(async (request, response) => {
      response.json(
        await store.archive(
          area(String(request.params.area)),
          String(request.params.id),
          request.authUser!.id,
        ),
      );
    }),
  );
  router.post(
    '/:area/:id/restore',
    requireAdmin,
    trackRequestWork(async (request, response) => {
      response.json(
        await store.restoreArchived(
          area(String(request.params.area)),
          String(request.params.id),
          request.authUser!.id,
        ),
      );
    }),
  );
  return router;
}
