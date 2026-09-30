import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { t } from './i18n';
import { useLocale } from './use-locale';
import { getTheme, setTheme, subscribeTheme, type ThemePreference } from './theme';
import './theme.css';

const choices = [
  { value: 'light', label: '라이트', description: '밝은 배경으로 표시합니다.', icon: Sun },
  { value: 'dark', label: '다크', description: '어두운 배경으로 표시합니다.', icon: Moon },
  { value: 'system', label: '시스템 설정', description: '기기의 화면 설정을 따릅니다.', icon: Monitor },
] satisfies { value: ThemePreference; label: string; description: string; icon: typeof Sun }[];

export function ThemeSelector() {
  useLocale();
  const { preference } = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  return (
    <fieldset className="theme-choices">
      <legend className="sr-only">{t('화면 테마')}</legend>
      {choices.map(({ value, label, description, icon: Icon }) => (
        <label key={value} className={preference === value ? 'selected' : ''}>
          <input
            type="radio"
            name="theme"
            value={value}
            checked={preference === value}
            onChange={() => setTheme(value)}
          />
          <Icon size={20} aria-hidden="true" />
          <span>
            <strong>{t(label)}</strong>
            <small>{t(description)}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function ThemeToggle() {
  useLocale();
  const { resolved } = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  const dark = resolved === 'dark';
  const label = t(dark ? '라이트 테마로 전환' : '다크 테마로 전환');
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={label}
      title={label}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
