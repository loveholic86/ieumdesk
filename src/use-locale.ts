import { useEffect, useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale } from './i18n';

export function useLocale() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'ko' as const);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return locale;
}
