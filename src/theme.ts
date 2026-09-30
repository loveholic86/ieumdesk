export type ThemePreference = 'light' | 'dark' | 'system';
export type ColorTheme = 'light' | 'dark';
export const themeStorageKey = 'ieumdesk.theme';
export const validTheme = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system';
export const resolveTheme = (preference: ThemePreference, systemDark: boolean): ColorTheme =>
  preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

let snapshot: { preference: ThemePreference; resolved: ColorTheme } = {
  preference: 'light',
  resolved: 'light',
};
const listeners = new Set<() => void>();
let media: MediaQueryList | undefined;
export const getTheme = () => snapshot;
export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function applyTheme(preference: ThemePreference) {
  const resolved = resolveTheme(preference, media?.matches ?? false);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'dark' ? '#101722' : '#f1f5fa');
  }
  if (snapshot.preference === preference && snapshot.resolved === resolved) return;
  snapshot = { preference, resolved };
  listeners.forEach((listener) => listener());
}
export function setTheme(preference: ThemePreference) {
  if (!validTheme(preference)) return;
  applyTheme(preference);
  try {
    window.localStorage.setItem(themeStorageKey, preference);
  } catch {
    // The current tab still supports themes when browser storage is unavailable.
  }
}
export function initializeTheme() {
  media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference: ThemePreference = 'light';
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (validTheme(stored)) preference = stored;
  } catch {
    /* Keep the existing light appearance when storage is unavailable. */
  }
  applyTheme(preference);
  const systemChanged = () => applyTheme(snapshot.preference);
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null || event.key === themeStorageKey)
      applyTheme(validTheme(event.newValue) ? event.newValue : 'light');
  };
  media.addEventListener('change', systemChanged);
  window.addEventListener('storage', storageChanged);
  const currentMedia = media;
  return () => {
    currentMedia.removeEventListener('change', systemChanged);
    window.removeEventListener('storage', storageChanged);
  };
}
