import { t } from './i18n';
import { installationBooleanChoice } from './installation-client';

type Props = {
  id: string;
  fieldKey: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  masked?: boolean;
  rows?: number;
  describedBy?: string;
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
}: Props) {
  const choice = masked ? null : installationBooleanChoice(fieldKey, value);
  if (choice)
    return (
      <label className="installation-boolean-control" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={choice.checked}
          disabled={disabled}
          aria-describedby={describedBy}
          ref={(input) => {
            if (input) input.indeterminate = !value;
          }}
          onChange={(event) => onChange(event.target.checked ? choice.yes : choice.no)}
        />
        <span aria-hidden="true">{t(value ? (choice.checked ? '예' : '아니오') : '미등록')}</span>
      </label>
    );
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      maxLength={16384}
      disabled={disabled}
      aria-describedby={describedBy}
      autoComplete="off"
      spellCheck={false}
      placeholder={masked ? t('현재 값 유지 · 변경할 때만 입력') : t('내용을 입력하세요')}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
