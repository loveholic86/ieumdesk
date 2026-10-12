export const rememberedLoginIdKey = 'ieumdesk.rememberedLoginId';

const normalizeLoginId = (value: string) => value.trim().toLowerCase();
const validLoginId = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function readRememberedLoginId(): string {
  try {
    const value = normalizeLoginId(window.localStorage.getItem(rememberedLoginIdKey) ?? '');
    return validLoginId(value) ? value : '';
  } catch {
    return '';
  }
}

// Call after a successful login, or immediately when the user clears the checkbox.
export function saveRememberedLoginId(email: string, remember: boolean): void {
  try {
    const value = normalizeLoginId(email);
    if (remember && validLoginId(value)) window.localStorage.setItem(rememberedLoginIdKey, value);
    else window.localStorage.removeItem(rememberedLoginIdKey);
  } catch {
    // Browser storage restrictions must not prevent signing in.
  }
}
