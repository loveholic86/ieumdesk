const modifyingMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function assertPrivateApiPath(path: string): void {
  // Root-relative paths make the current browser origin authoritative. Refuse URL
  // normalization tricks before fetch can turn imported/user-supplied text into a URL.
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\p{Cc}\p{Cf}\\#]/u.test(path)) {
    throw new Error('올바른 API 경로가 아닙니다.');
  }
  const pathname = path.split('?', 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error('올바른 API 경로가 아닙니다.');
  }
  if (
    /%(?:2f|5c)/i.test(pathname) ||
    /[\p{Cc}\p{Cf}\\?#]/u.test(decoded) ||
    decoded.includes('//') ||
    decoded.split('/').some(segment => segment === '.' || segment === '..') ||
    new URL(path, 'https://ieumdesk.invalid').pathname !== pathname
  ) {
    throw new Error('올바른 API 경로가 아닙니다.');
  }
}

/** Authenticated responses must not become reusable browser cache entries or follow redirects. */
export async function privateFetch(path: string, options?: RequestInit): Promise<Response> {
  assertPrivateApiPath(path);
  const headers = new Headers(options?.headers);
  if (modifyingMethods.has((options?.method ?? 'GET').toUpperCase())) headers.set('X-Ieumdesk-Request', '1');
  return fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
}

export function publicErrorMessage(body: unknown, status: number, fallback: string): string {
  // Unexpected server failures can contain database details or submitted secrets.
  if (status >= 500 || !body || typeof body !== 'object') return fallback;
  const error = (body as { error?: unknown }).error;
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : error;
  return typeof message === 'string' && message.length <= 500 ? message : fallback;
}

export function csvContent(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const escape = (value: unknown) => {
    let text = String(value ?? '');
    // Spreadsheet importers can discard invisible prefixes and normalize full-width operators.
    const start = text.replace(/^[\s\p{Cc}\p{Cf}]+/u, '').normalize('NFKC');
    if (/^[=+@-]/.test(start) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const columns = Object.keys(rows[0]);
  return '\uFEFF' + [columns.map(escape).join(','), ...rows.map(row => columns.map(key => escape(row[key])).join(','))].join('\r\n');
}

export function safeWebsite(value: string): string | undefined {
  const text = value.trim();
  if (/^(?:보호됨|\[보호됨\]|[•●*]{3,})$/u.test(text)) return undefined;
  if (!text || /[\p{Cc}\p{Cf}\\]/u.test(text)) return undefined;
  const scheme = /^[a-z][a-z\d+.-]*:/i.test(text);
  const hostWithPort = /^[^/?#:]+:\d+(?:[/?#]|$)/.test(text);
  if (scheme && !hostWithPort && !/^https?:\/\//i.test(text)) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text.replace(/^\/\//, '')}`);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function emailHref(value: string): string | undefined {
  const text = value.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(text) || /[\p{Cc}\p{Cf}]/u.test(text)) return undefined;
  // An imported address must not supply mail-client headers such as bcc or a message body.
  return `mailto:${encodeURIComponent(text).replace(/%40/gi, '@')}`;
}

export function phoneHref(value: string): string | undefined {
  const text = value.trim();
  if (!/^[+\d() .-]+(?:;(?:ext|isub)=\d+)?$/i.test(text) || !/\d/.test(text)) return undefined;
  return `tel:${text.replace(/\s/g, '')}`;
}
