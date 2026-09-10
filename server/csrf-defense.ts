import type { RequestHandler } from 'express';

const modifyingMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * An AJAX-only request marker, not a secret or a per-session CSRF token.
 * Keep the application's Origin, Fetch Metadata, JSON-only and CORS restrictions:
 * a foreign browser origin cannot add this non-safelisted header without preflight.
 */
export const requireCrmRequestHeader: RequestHandler = (request, response, next) => {
  // Keep already-open clients working during the project rename. Every supplied
  // marker must be valid; a legacy marker cannot override a malformed new one.
  const markers = ['X-Ieumdesk-Request', 'X-Yeta-CRM-Request']
    .map((name) => request.get(name))
    .filter((value) => value !== undefined);
  if (
    modifyingMethods.has(request.method.toUpperCase()) &&
    (!markers.length || markers.some((value) => value !== '1'))
  ) {
    response.status(403).json({
      error: {
        code: 'CSRF_HEADER_REQUIRED',
        message: '요청을 확인할 수 없습니다. 화면을 새로고침한 후 다시 시도해 주세요.',
      },
    });
    return;
  }
  next();
};
