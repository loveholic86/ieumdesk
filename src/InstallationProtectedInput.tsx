import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { t } from './i18n';
import InstallationFieldInput from './InstallationFieldInput';

type Props = {
  id: string;
  fieldKey: string;
  value: string;
  touched: boolean;
  disabled?: boolean;
  rows?: number;
  expanded?: boolean;
  allowClear?: boolean;
  maxLength?: number;
  invalid?: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
  onReset: () => void;
};
/** A blank replacement never clears the stored value. Clearing requires the explicit action. */
export default function InstallationProtectedInput({
  id,
  fieldKey,
  value,
  touched,
  disabled,
  rows,
  expanded,
  allowClear = true,
  maxLength,
  invalid,
  describedBy,
  onChange,
  onReset,
}: Props) {
  const [replacing, setReplacing] = useState(false);
  const mode = touched ? (value ? 'replace' : 'clear') : replacing ? 'replace' : 'keep';
  return (
    <div className="installation-protected-input">
      <span className="installation-protected-input-status">
        <LockKeyhole size={14} aria-hidden="true" />
        {t('보호된 값')}
      </span>
      <div className="installation-value-modes" role="group" aria-label={t('보호된 값 처리')}>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={mode === 'keep'}
          onClick={() => {
            setReplacing(false);
            onReset();
          }}
        >
          {t('기존 값 유지')}
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={mode === 'replace'}
          onClick={() => {
            setReplacing(true);
            if (mode === 'clear') onReset();
          }}
        >
          {t('새 값 입력')}
        </button>
        {allowClear && (
          <button
            type="button"
            disabled={disabled}
            aria-pressed={mode === 'clear'}
            onClick={() => {
              setReplacing(false);
              onChange('');
            }}
          >
            {t('값 비우기')}
          </button>
        )}
      </div>
      {mode === 'replace' && (
        <InstallationFieldInput
          id={id}
          fieldKey={fieldKey}
          initialValue=""
          value={touched ? value : ''}
          masked
          rows={rows}
          expanded={expanded}
          disabled={disabled}
          maxLength={maxLength}
          invalid={invalid}
          describedBy={describedBy}
          onChange={(next) => {
            setReplacing(true);
            if (next === '') onReset();
            else onChange(next);
          }}
        />
      )}
      {mode === 'clear' && <small className="danger-text">{t('저장하면 기존 값이 비워집니다.')}</small>}
      {mode === 'keep' && <small>{t('입력하지 않은 보호된 값은 유지됩니다.')}</small>}
    </div>
  );
}
