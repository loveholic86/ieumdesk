import { t } from './i18n';
import { installationBooleanChoice } from './installation-client';
import { installationInputDefinition } from './installation-editor';

type Props = {
  id: string;
  fieldKey: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  masked?: boolean;
  rows?: number;
  describedBy?: string;
  initialValue?: string;
  expanded?: boolean;
  maxLength?: number;
  invalid?: boolean;
};

export default function InstallationFieldInput({
  id,
  fieldKey,
  value,
  onChange,
  disabled,
  masked,
  rows = 2,
  describedBy,
  initialValue,
  expanded = false,
  maxLength = 16384,
  invalid,
}: Props) {
  const definition = installationInputDefinition(fieldKey, initialValue ?? value, expanded);
  const choice = masked ? null : installationBooleanChoice(fieldKey, value);
  if (choice)
    return (
      <select
        id={id}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        value={value ? (choice.checked ? choice.yes : choice.no) : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled={fieldKey === 'autoUpdate' && Boolean(value)}>
          {t('미등록')}
        </option>
        <option value={choice.yes}>{t('예')}</option>
        <option value={choice.no}>{t('아니오')}</option>
      </select>
    );
  if (!masked && definition.type === 'select')
    return (
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
      >
        {!definition.options.includes(value) && <option value={value}>{value || t('미등록')}</option>}
        {definition.options.map((option) => (
          <option key={option} value={option}>
            {t(option)}
          </option>
        ))}
      </select>
    );
  if (definition.type !== 'textarea' && !expanded)
    return (
      <input
        id={id}
        type={
          masked
            ? /pwd|password/i.test(fieldKey)
              ? 'password'
              : 'text'
            : definition.type === 'boolean' || definition.type === 'select'
              ? 'text'
              : definition.type
        }
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        maxLength={maxLength}
        autoComplete={masked && /pwd|password/i.test(fieldKey) ? 'new-password' : 'off'}
        spellCheck={false}
        step={definition.type === 'number' ? 'any' : undefined}
        placeholder={masked ? t('현재 값 유지 · 변경할 때만 입력') : t('내용을 입력하세요')}
        onInput={
          definition.type === 'date'
            ? (event) => {
                if (!event.currentTarget.validity.badInput) onChange(event.currentTarget.value);
              }
            : undefined
        }
        onChange={(event) => {
          if (!event.currentTarget.validity.badInput) onChange(event.currentTarget.value);
        }}
      />
    );
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      maxLength={maxLength}
      disabled={disabled}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      autoComplete="off"
      spellCheck={false}
      placeholder={masked ? t('현재 값 유지 · 변경할 때만 입력') : t('내용을 입력하세요')}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
