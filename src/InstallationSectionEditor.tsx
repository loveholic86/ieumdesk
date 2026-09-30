import { useId, useRef, useState } from 'react';
import { Check, LockKeyhole, RotateCcw } from 'lucide-react';
import { t } from './i18n';
import { useLocale } from './use-locale';
import { installationFieldLabel } from './installation-labels';
import {
  visibleInstallationSection,
  type InstallationSectionChange,
  type InstallationSectionDraft,
} from './installation-client';
import type { InstallationDetails, InstallationSectionId } from './installation-types';
import InstallationFieldInput from './InstallationFieldInput';
import './installation-record-editor.css';

type Props = {
  details: InstallationDetails;
  sectionId: InstallationSectionId;
  busy: boolean;
  policyPending: boolean;
  error: string;
  onClose: () => void;
  onSave: (
    draft: InstallationSectionDraft,
    committed: (change: InstallationSectionChange) => void,
  ) => Promise<void>;
};
const omit = (values: Record<string, string>, keys: string[]) =>
  Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key)));

export default function InstallationSectionEditor({
  details,
  sectionId,
  busy,
  policyPending,
  error,
  onClose,
  onSave,
}: Props) {
  useLocale();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const section = visibleInstallationSection(details.sections.find((item) => item.id === sectionId)!);
  const committed = (change: InstallationSectionChange) => {
    if (change.kind === 'note') setNotes((current) => omit(current, [change.id]));
    else {
      setValues((current) => omit(current, change.fieldIds));
      setTitles((current) => omit(current, [change.id]));
    }
  };
  return (
    <section
      className="installation-inline-editor installation-section-editor"
      tabIndex={-1}
      aria-label={t('정보 수정')}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (!busy && !policyPending) form.current?.requestSubmit();
        }
      }}
    >
      <header className="installation-inline-edit-header">
        <div>
          <h3>{t('{0} 수정', [t(section.title)])}</h3>
          <p>{t('현재 탭의 모든 항목을 수정한 뒤 저장하세요. 입력하지 않은 보호된 값은 유지됩니다.')}</p>
        </div>
      </header>
      <form
        ref={form}
        autoComplete="off"
        spellCheck={false}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !policyPending) void onSave({ values, titles, notes }, committed);
        }}
      >
        {section.rows.map((row, index) => (
          <fieldset key={row.id} className="installation-section-edit-row" disabled={busy}>
            <legend>{row.title || t('{0} 기록', [index + 1])}</legend>
            {row.managed !== 'metadata' && (
              <label className="installation-section-edit-title">
                {t('기록 이름')}
                <input
                  value={titles[row.id] ?? row.title ?? section.title}
                  maxLength={120}
                  onChange={(event) => setTitles((current) => ({ ...current, [row.id]: event.target.value }))}
                />
              </label>
            )}
            <div className="installation-inline-edit-fields">
              {row.fields.map((field) => {
                const hidden = policyPending && field.secret;
                const touched = Object.hasOwn(values, field.id);
                const value = hidden ? '' : touched ? values[field.id] : field.masked ? '' : field.value;
                const wide =
                  field.key === 'note' ||
                  field.key === 'ct_etc' ||
                  /[\n\r]/.test(value) ||
                  value.length > 150 ||
                  /etc|description/.test(field.key);
                const inputId = `${id}-${field.id}`;
                return (
                  <div
                    key={field.id}
                    className={`installation-inline-edit-field${wide ? ' is-wide' : ''}${touched ? ' is-changed' : ''}`}
                  >
                    <div className="installation-inline-edit-field-heading">
                      <label htmlFor={inputId}>
                        {installationFieldLabel(field)}
                        {field.secret && <LockKeyhole size={14} />}
                      </label>
                    </div>
                    <InstallationFieldInput
                      id={inputId}
                      fieldKey={field.key}
                      value={value}
                      rows={wide ? 5 : 2}
                      masked={field.masked || hidden}
                      disabled={busy || hidden}
                      onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                    />
                    {touched && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => setValues((current) => omit(current, [field.id]))}
                      >
                        <RotateCcw size={13} />
                        {t('입력 취소')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
        {sectionId === 'access' && (details.accessNotes ?? []).length > 0 && (
          <fieldset className="installation-section-edit-row" disabled={busy || policyPending}>
            <legend>{t('참고사항')}</legend>
            {(details.accessNotes ?? []).map((note, index) => (
              <div key={note.id} className="installation-inline-edit-field is-wide">
                <label htmlFor={`${id}-note-${note.id}`}>{t('참고사항 {0}', [index + 1])}</label>
                <textarea
                  id={`${id}-note-${note.id}`}
                  rows={5}
                  maxLength={16384}
                  value={policyPending ? '' : (notes[note.id] ?? (note.masked ? '' : note.content))}
                  placeholder={note.masked ? t('현재 값 유지 · 변경할 때만 입력') : ''}
                  onChange={(event) => setNotes((current) => ({ ...current, [note.id]: event.target.value }))}
                />
                {Object.hasOwn(notes, note.id) && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setNotes((current) => omit(current, [note.id]))}
                  >
                    {t('입력 취소')}
                  </button>
                )}
              </div>
            ))}
          </fieldset>
        )}
        {error && (
          <p className="installation-action-error" role="alert">
            {t(error)}
          </p>
        )}
        <div className="installation-section-edit-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {t('수정 취소')}
          </button>
          <button className="button primary" disabled={busy || policyPending}>
            <Check size={15} />
            {t(busy ? '저장 중…' : '정보 저장')}
          </button>
        </div>
      </form>
    </section>
  );
}
