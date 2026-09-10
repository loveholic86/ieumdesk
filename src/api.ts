import { t, getLocaleTag } from './i18n';
import { validWorkspaceSettings } from './workspace-types';
import { csvContent, privateFetch, publicErrorMessage } from './client-security';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await privateFetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (typeof window !== 'undefined' && (response.status === 401 || response.status === 403)) {
    window.dispatchEvent(new Event(response.status === 401 ? 'crm:unauthorized' : 'crm:permissions-changed'));
  }
  let body: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch {
    throw new Error('서버 응답을 확인하지 못했습니다. 저장 결과를 확인한 뒤 다시 시도해 주세요.');
  }
  if (!response.ok) {
    throw new Error(publicErrorMessage(body, response.status, '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
  }
  const method = options?.method?.toUpperCase() || 'GET';
  const route = path.split('?')[0];
  const collection =
    route === '/companies' ||
    route === '/tasks' ||
    /^\/records\/[^/]+$/.test(route) ||
    route.endsWith('/activities');
  const valid = route === '/settings'
    ? validWorkspaceSettings(body)
    : method==='POST' && /^\/archive\/(?:companies|contacts|activities|tasks|sales|quotations|installations)\/[^/]+(?:\/restore)?$/.test(route)
      ? body.success===true
    : route === '/settings/audit' && method === 'GET'
      ? Array.isArray(body.items) && body.items.every(item=>item && typeof item.id==='string' && typeof item.action==='string' && typeof item.createdAt==='string')
    : (/^\/catalog\/(?:products|codes)$/.test(route)||route==='/archive') && method === 'GET'
      ? Array.isArray(body.items) && body.items.every(item=>item && typeof item.id==='string')
    : method === 'GET'
      ? route === '/health'
        ? ['demo', 'postgres'].includes(String(body.mode))
        : collection
          ? Array.isArray(body.items) &&
            body.items.every((item) => item && typeof item.id === 'string') &&
            (route !== '/companies' ||
              (Number.isFinite(body.total) &&
                typeof body.stats === 'object' &&
                body.stats !== null &&
                Number.isFinite(body.pageSize) &&
                Number(body.pageSize) > 0))
          : typeof body.id === 'string'
      : typeof body.id === 'string' && body.id.length > 0;
  if (!valid)
    throw new Error('서버 응답 형식이 올바르지 않습니다. 저장 결과를 확인한 뒤 다시 시도해 주세요.');
  return body as T;
}

export function changedFields<T extends Record<string, unknown>>(
  current: T,
  original: Record<string, unknown>,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(current).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(original[key])),
  ) as Partial<T>;
}

export const statusLabels = { active: '이용 중', prospect: '도입 상담', paused: '이용 종료', unclassified: '미분류' };
export const dateLabel = (value: string) =>
  value
    ? new Date(value)
        .toLocaleDateString(getLocaleTag(), { year: 'numeric', month: '2-digit', day: '2-digit' })
        .replace(/\.\s*$/, '')
    : t('미등록');
export const money = (value: number) => new Intl.NumberFormat(getLocaleTag()).format(value);
export function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const csv = csvContent(rows);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
