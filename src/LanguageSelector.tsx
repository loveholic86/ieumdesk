import { Languages } from 'lucide-react';
import { setLocale, t, type Locale } from './i18n';
import { useLocale } from './use-locale';
import './language-selector.css';

export function LanguageSelector() {
  const locale = useLocale();
  return (
    <label className="language-selector">
      <Languages size={16} aria-hidden="true" />
      <span className="sr-only">{t('표시 언어')}</span>
      <select
        aria-label={t('표시 언어')}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        <option value="ko" lang="ko">
          한국어
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
    </label>
  );
}
