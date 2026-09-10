import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.ts';

export const requestShapeLimits = {
  targetBytes: 8192,
  queryParameters: 64,
  jsonDepth: 32,
  jsonNodes: 20_000,
  objectKeys: 512,
} as const;
const allowedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const singularHeaders = new Set([
  'host',
  'origin',
  'content-type',
  'content-length',
  'content-encoding',
  'cookie',
  'x-ieumdesk-request',
  'x-yeta-crm-request',
]);
const invalid = () => new ApiError(400, 'INVALID_REQUEST', '요청 형식을 확인해 주세요.');
const complex = () =>
  new ApiError(413, 'REQUEST_TOO_COMPLEX', '요청 구조가 너무 큽니다. 입력 항목을 줄여 주세요.');

/** Host is an HTTP authority, never a URL with credentials, path, fragments or escapes. */
export function validLocalAuthority(value: string): boolean {
  if (!value || /[\s/@?#\\%]/u.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Reject ambiguous request syntax before JSON parsing, credentials, or store access. */
export function validateRequestShape(request: Request, response: Response, next: NextFunction) {
  if (!allowedMethods.includes(request.method)) {
    response.set('Allow', allowedMethods.join(', '));
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식입니다.');
  }
  const seenHeaders = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase();
    if (singularHeaders.has(name) && seenHeaders.has(name)) throw invalid();
    seenHeaders.add(name);
  }
  if (
    ['x-http-method', 'x-http-method-override', 'x-method-override'].some(
      (name) => request.headers[name] !== undefined,
    )
  )
    throw invalid();
  const encoding = request.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity')
    throw new ApiError(415, 'CONTENT_ENCODING_UNSUPPORTED', '압축하지 않은 JSON 요청을 사용해 주세요.');
  if (
    ['GET', 'HEAD'].includes(request.method) &&
    (Number(request.get('content-length') || 0) > 0 || request.get('transfer-encoding'))
  )
    throw invalid();
  const target = request.originalUrl;
  if (Buffer.byteLength(target, 'utf8') > requestShapeLimits.targetBytes)
    throw new ApiError(414, 'REQUEST_TARGET_TOO_LARGE', '요청 주소가 너무 깁니다. 검색 조건을 줄여 주세요.');
  if (!target.startsWith('/') || target.startsWith('//') || /[\x00-\x20\x7f\\#]/u.test(target))
    throw invalid();
  const separator = target.indexOf('?');
  const rawPath = separator < 0 ? target : target.slice(0, separator);
  const rawQuery = separator < 0 ? '' : target.slice(separator + 1);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
    // Fail on malformed percent sequences/UTF-8 instead of parser-dependent replacements.
    decodeURIComponent(rawQuery.replaceAll('+', ' '));
  } catch {
    throw invalid();
  }
  if (
    /[\x00-\x1f\x7f\\]/u.test(decodedPath) ||
    decodedPath.split('/').some((segment) => segment === '.' || segment === '..')
  )
    throw invalid();
  const query = new URLSearchParams(rawQuery);
  const keys = new Set<string>();
  let count = 0;
  for (const [key] of query) {
    if (++count > requestShapeLimits.queryParameters || key.length > 100) throw complex();
    // Current CRM query contracts are scalars. Reject duplicate/array-shaped keys.
    if (
      !key ||
      keys.has(key) ||
      reservedKeys.has(key) ||
      key === '_method' ||
      /[\[\]\x00-\x1f\x7f]/u.test(key)
    )
      throw new ApiError(400, 'AMBIGUOUS_QUERY', '중복되거나 지원하지 않는 조회 조건입니다.');
    keys.add(key);
  }
  next();
}

/** A bounded iterative walk does not recurse on attacker-controlled JSON depth. */
export function assertSafeJsonStructure(body: unknown): void {
  if (body === undefined) return;
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new ApiError(400, 'JSON_OBJECT_REQUIRED', 'JSON 객체 형식으로 요청해 주세요.');
  const stack: { value: unknown; depth: number }[] = [{ value: body, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > requestShapeLimits.jsonNodes || depth > requestShapeLimits.jsonDepth) throw complex();
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalid();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (nodes + stack.length + value.length > requestShapeLimits.jsonNodes) throw complex();
      for (const nested of value) stack.push({ value: nested, depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(value);
    if (
      entries.length > requestShapeLimits.objectKeys ||
      nodes + stack.length + entries.length > requestShapeLimits.jsonNodes
    )
      throw complex();
    for (const [key, nested] of entries) {
      if (reservedKeys.has(key) || key === '_method')
        throw new ApiError(400, 'UNSAFE_JSON_KEY', '지원하지 않는 JSON 항목입니다.');
      stack.push({ value: nested, depth: depth + 1 });
    }
  }
}
export function validateJsonStructure(request: Request, _response: Response, next: NextFunction) {
  assertSafeJsonStructure(request.body);
  next();
}
