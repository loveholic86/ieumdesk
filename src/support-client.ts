export const supportProtectedFields = [
  'body',
  'contactName',
  'contactEmail',
  'contactPhone',
  'contactMobile',
] as const;

export function prepareSupportForm(
  draft: Record<string, string | boolean>,
  changed: readonly string[],
  existing: Record<string, unknown> | null,
): Record<string, string | boolean> {
  const title = String(draft.title || '').trim();
  if (!title) throw new Error('제목을 입력해 주세요.');
  if (!existing && !String(draft.body || '').trim()) throw new Error('내용을 입력해 주세요.');
  const payload: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (existing && !changed.includes(key)) continue;
    const normalized = key === 'companyId' ? String(value || '') : key === 'title' ? title : value;
    const explicitlyProtected =
      Boolean(existing?.masked) && supportProtectedFields.some((field) => field === key);
    const previous = key === 'companyId' ? String(existing?.[key] || '') : existing?.[key];
    if (existing && !explicitlyProtected && normalized === previous) continue;
    payload[key] = normalized;
  }
  return payload;
}

export function prepareSupportDiscussionPatch(
  kind: 'answers' | 'replies',
  revision: number,
  body: string,
  changedTitle?: string,
): { revision: number; body: string; title?: string } {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('자료 버전을 확인하지 못했습니다. 상세 정보를 다시 불러와 주세요.');
  const content = body.trim();
  if (!content) throw new Error('수정할 내용을 입력해 주세요.');
  if (content.length > 100000) throw new Error('내용은 100,000자 이하로 입력해 주세요.');
  const title = changedTitle?.trim();
  if (kind === 'answers' && title !== undefined && title.length > 300)
    throw new Error('답변 제목은 300자 이하로 입력해 주세요.');
  return { revision, body: content, ...(kind === 'answers' && title !== undefined ? { title } : {}) };
}
