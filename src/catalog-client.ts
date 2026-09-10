import { changedFields } from './api';

/** Unchanged display masks must never replace protected catalogue text. */
export function catalogFormPayload(values: Record<string, unknown>, original: Record<string, unknown> | null) {
  const patch = original ? changedFields(values, original) : values;
  if (original && !Object.keys(patch).length) throw new Error('변경한 내용이 없습니다.');
  return patch;
}
