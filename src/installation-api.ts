import { privateFetch, publicErrorMessage } from './client-security';

export async function installationRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await privateFetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  await assertInstallationResponse(response);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('서버 응답을 확인하지 못했습니다. 다시 불러온 뒤 확인해 주세요.');
  }
}

async function assertInstallationResponse(response: Response): Promise<void> {
  if (response.ok) return;
  if (typeof window !== 'undefined' && (response.status === 401 || response.status === 403))
    window.dispatchEvent(new Event(response.status === 401 ? 'crm:unauthorized' : 'crm:permissions-changed'));
  let message = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  try {
    const body = await response.json();
    message = publicErrorMessage(body, response.status, message);
  } catch {
    /* Keep the local error for non-JSON failures. */
  }
  throw new Error(message);
}

export async function downloadInstallationFile(
  path: string,
  fallbackName: string,
  options?: RequestInit,
  stillCurrent: () => boolean = () => true,
): Promise<boolean> {
  const response = await privateFetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  await assertInstallationResponse(response);
  const blob = await response.blob();
  if (!stillCurrent() || options?.signal?.aborted) return false;
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  let name = quoted || fallbackName;
  if (encoded) {
    try {
      name = decodeURIComponent(encoded);
    } catch {
      /* Use the safe fallback. */
    }
  }
  name = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 200) || fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) {
        reject(new Error('파일 내용을 읽지 못했습니다. 다시 선택해 주세요.'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('파일 내용을 읽지 못했습니다. 다시 선택해 주세요.'));
    reader.readAsDataURL(file);
  });
}
