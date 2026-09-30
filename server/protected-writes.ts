import type { RequestHandler } from 'express';
import { ApiError } from './errors.ts';

const legacyPlaceholder = '[접속정보가 포함될 수 있는 원문은 보안 보관함에 보존됨]';
const isPlaceholder = (value: unknown): boolean =>
  typeof value === 'string' &&
  (/^(?:보호됨|\[보호됨\]|Protected|\[Protected\]|[•●*]{3,})$/u.test(value.trim()) ||
    value.trim() === legacyPlaceholder);

/**
 * Display masks are never source values. A scalar PATCH mask means "keep the
 * current value"; the store merges omitted fields with its locked, raw record.
 * New records and nested replacements cannot safely recover a mask, so reject
 * them before any write instead of guessing an array item's original identity.
 * Mount after JSON structure validation and authentication, on business APIs only.
 */
export const preserveProtectedValues: RequestHandler = (request, _response, next) => {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return next();
  const body = request.body;
  const candidate =
    request.method === 'PATCH' && body && typeof body === 'object' && !Array.isArray(body)
      ? Object.fromEntries(Object.entries(body).filter(([, value]) => !isPlaceholder(value)))
      : body;
  const pending: unknown[] = [candidate];
  while (pending.length) {
    const value = pending.pop();
    if (isPlaceholder(value))
      throw new ApiError(
        400,
        'PROTECTED_VALUE_PLACEHOLDER',
        '보호 표시 문구는 저장할 수 없습니다. 원문을 조회한 뒤 수정하거나 실제 내용을 입력해 주세요.',
      );
    if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  request.body = candidate;
  next();
};
