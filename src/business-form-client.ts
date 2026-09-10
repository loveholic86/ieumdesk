import { changedFields } from './api';

export function businessFormPolicy(
  user: { id: string; role: string; status: string } | null | undefined,
  revision: number | undefined,
): string {
  return user?.status === 'active' && Number.isInteger(revision) && Number(revision) > 0
    ? `${user.id}:${user.role}:${user.status}:${revision}`
    : '';
}

export function businessFormPolicyMatches(captured: string, current: string): boolean {
  return Boolean(captured) && captured === current;
}

/** Display projections are compared to their opening snapshot; unchanged masks never become writes. */
export function businessFormPayload<T extends Record<string, unknown>>(
  current: T,
  original: Record<string, unknown> | null,
  capturedPolicy: string,
  currentPolicy: string,
): Partial<T> {
  if (!businessFormPolicyMatches(capturedPolicy, currentPolicy))
    throw new Error('보호 설정 또는 계정 권한이 변경되었습니다. 화면을 다시 열어 입력해 주세요.');
  return original === null ? { ...current } : changedFields(current, original);
}
