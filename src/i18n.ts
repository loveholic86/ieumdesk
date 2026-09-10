import { english } from './locales/en';

export type Locale = 'ko' | 'en';
export const localeStorageKey = 'ieumdesk.locale';
const listeners = new Set<() => void>();
const validLocale = (value: unknown): value is Locale => value === 'ko' || value === 'en';

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'ko';
  try {
    const saved = window.localStorage.getItem(localeStorageKey);
    if (validLocale(saved)) return saved;
  } catch {
    /* Language selection also works without browser storage. */
  }
  return window.navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'ko';
}
let locale = initialLocale();
export const getLocale = () => locale;
export const getLocaleTag = () => (locale === 'en' ? 'en-US' : 'ko-KR');

function applyLocale(next: Locale) {
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (locale === next) return;
  locale = next;
  for (const listener of listeners) listener();
}
export function setLocale(next: Locale) {
  if (!validLocale(next)) return;
  applyLocale(next);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(localeStorageKey, next);
    } catch {
      /* Keep the in-memory choice. */
    }
  }
}
function storageChanged(event: StorageEvent) {
  if (event.key === localeStorageKey && validLocale(event.newValue)) applyLocale(event.newValue);
}
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  if (typeof window !== 'undefined' && listeners.size === 1)
    window.addEventListener('storage', storageChanged);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined' && !listeners.size)
      window.removeEventListener('storage', storageChanged);
  };
}

const normalize = (message: string) => message.replace(/\s+/g, ' ').trim();
const interpolate = (message: string, values: readonly unknown[]) =>
  message.replace(/\{(\d+)\}/g, (placeholder, index) =>
    index < values.length ? String(values[index] ?? '') : placeholder,
  );
// Only these slots contain built-in interface labels. All names and other data stay verbatim.
const interfaceSlots: Record<string, readonly number[]> = {
  '{0} 목록 응답을 확인하지 못했습니다.': [0],
  '{0} 목록을 불러오지 못했습니다.': [0],
  '{0} {1}을 {2}으로 변경했습니다.': [1, 2],
  '{0} 정보를 저장했습니다.': [0],
  '{0} 기록을 저장했습니다.': [0],
  '{0}개 {1} 정보를 내보냈습니다.': [1],
  '{0} {1}를 완료했습니다.': [0, 1],
};
const translateSlots = (source: string, values: readonly unknown[]) =>
  values.map((value, index) => (interfaceSlots[source]?.includes(index) ? t(value) : value));
const templatePatterns = Object.entries(english)
  .filter(([source]) => /\{\d+\}/.test(source))
  .sort(([left], [right]) => right.replace(/\{\d+\}/g, '').length - left.replace(/\{\d+\}/g, '').length)
  .map(([source, translated]) => {
    const indexes: number[] = [];
    const pattern = source
      .split(/(\{\d+\})/)
      .map((part) => {
        const placeholder = /^\{(\d+)\}$/.exec(part);
        if (placeholder) {
          indexes.push(Number(placeholder[1]));
          return '(.*?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    return { source, regex: new RegExp(`^${pattern}$`), indexes, translated };
  });

/** Translate interface messages at render time; never use this for request values or customer content. */
export function t<T>(value: T, values?: readonly unknown[], context?: string): T {
  if (typeof value !== 'string') return value;
  const source = normalize(value);
  if (locale === 'ko') return (values ? interpolate(value, values) : value) as T;
  const key = context && Object.hasOwn(english, `${context}::${source}`) ? `${context}::${source}` : source;
  if (Object.hasOwn(english, key)) {
    const translated = english[key];
    const leading = /^\s/.test(value) && !/^\s/.test(translated) ? ' ' : '';
    const trailing = /\s$/.test(value) && !/\s$/.test(translated) ? ' ' : '';
    return (leading +
      (values ? interpolate(translated, translateSlots(source, values)) : translated) +
      trailing) as T;
  }
  // Errors received from the API may already contain interpolation values.
  for (const { source: template, regex, indexes, translated } of templatePatterns) {
    const match = regex.exec(source);
    if (!match) continue;
    const parameters: string[] = [];
    indexes.forEach((index, position) => {
      parameters[index] = match[position + 1];
    });
    return interpolate(translated, translateSlots(template, parameters)) as T;
  }
  return (values ? interpolate(value, values) : value) as T;
}

/** Localize server masking markers without translating customer text. */
export function displayValue<T>(value: T): T {
  return value === '보호됨' || value === '[보호됨]' ? t(value) : value;
}
