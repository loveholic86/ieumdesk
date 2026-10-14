import { useEffect, useId, useRef, useState } from 'react';
import { Check, LockKeyhole, Maximize2, RotateCcw, Search } from 'lucide-react';
import { t } from './i18n';
import { useLocale } from './use-locale';
import { installationFieldLabel, installationRowTitle } from './installation-labels';
import {
  visibleInstallationSection,
  type InstallationSectionChange,
  type InstallationSectionDraft,
} from './installation-client';
import {
  installationEditorGroups,
  installationFieldChanged,
  installationFieldGroup,
  installationLongField,
  installationSectionChangeCount,
} from './installation-editor';
import type {
  InstallationDetailField,
  InstallationDetails,
  InstallationSectionId,
} from './installation-types';
import InstallationFieldInput from './InstallationFieldInput';
import InstallationProtectedInput from './InstallationProtectedInput';
import { InstallationEditorActions, useInstallationDirty } from './InstallationEditorLayout';
import { focusInstallationField } from './installation-scroll';
import './installation-record-editor.css';
import './installation-editor.css';

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
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [review, setReview] = useState(false);
  const [expanded, setExpanded] = useState('');
  const [active, setActive] = useState('');
  const section = visibleInstallationSection(details.sections.find((item) => item.id === sectionId)!);
  const groups = installationEditorGroups(
    sectionId,
    section.rows.flatMap((row) => row.fields.map((field) => field.key)),
    Boolean(details.accessNotes?.length),
  );
  const [selectedGroup, setSelectedGroup] = useState(groups[0]?.id || 'other');
  const groupId = groups.some((group) => group.id === selectedGroup) ? selectedGroup : groups[0]?.id;
  const search = query.trim().toLocaleLowerCase();
  const draft = { values, titles, notes };
  const count = installationSectionChangeCount({ ...details, sections: [section] }, sectionId, draft);
  useInstallationDirty(count > 0);
  const noteChanged = (note: NonNullable<InstallationDetails['accessNotes']>[number]) =>
    Object.hasOwn(notes, note.id) && (note.masked || notes[note.id] !== note.content);
  const titleChanged = (row: (typeof section.rows)[number]) =>
    Object.hasOwn(titles, row.id) && titles[row.id] !== (row.title ?? section.title);
  const matches = (field: InstallationDetailField) =>
    (!search ||
      [field.label, field.key, installationFieldLabel(field)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search)) &&
    (Boolean(search) || installationFieldGroup(sectionId, field.key).id === groupId) &&
    (!changedOnly || installationFieldChanged(field, values) || active === field.id);
  const showNotes =
    sectionId === 'access' &&
    (Boolean(search)
      ? t('참고사항').toLocaleLowerCase().includes(search) || 'note'.includes(search)
      : groupId === 'notes');
  const groupCount = (group: string) =>
    section.rows
      .flatMap((row) => row.fields)
      .filter(
        (field) =>
          installationFieldGroup(sectionId, field.key).id === group &&
          installationFieldChanged(field, values),
      ).length +
    (group === 'notes' && sectionId === 'access'
      ? (details.accessNotes ?? []).filter(noteChanged).length
      : 0);
  useEffect(() => {
    if (expanded) focusInstallationField(document.getElementById(id + '-field-' + expanded));
  }, [expanded, id]);
  useEffect(() => {
    if (error) focusInstallationField(errorMessage.current);
  }, [error]);
  const committed = (change: InstallationSectionChange) => {
    if (change.kind === 'note') setNotes((current) => omit(current, [change.id]));
    else {
      setValues((current) => omit(current, change.fieldIds));
      setTitles((current) => omit(current, [change.id]));
    }
  };
  const reset = (fieldId: string) => setValues((current) => omit(current, [fieldId]));
  const renderField = (field: InstallationDetailField) => {
    const touched = Object.hasOwn(values, field.id);
    const changed = installationFieldChanged(field, values);
    const hidden = policyPending && field.secret;
    const value = hidden ? '' : touched ? values[field.id] : field.masked ? '' : field.value;
    const isExpanded = expanded === field.id;
    const wide = isExpanded || installationLongField(field.key, value) || field.masked;
    const inputId = id + '-field-' + field.id;
    return (
      <div
        key={field.id}
        className={
          'installation-inline-edit-field' +
          (wide ? ' is-wide' : '') +
          (changed ? ' is-changed' : '') +
          (isExpanded ? ' is-expanded' : '')
        }
        onFocusCapture={() => setActive(field.id)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setActive('');
        }}
      >
        <div className="installation-inline-edit-field-heading">
          <label htmlFor={inputId}>
            {installationFieldLabel(field)}
            {field.secret && <LockKeyhole size={14} aria-hidden="true" />}
          </label>
          {changed && (
            <span className="installation-inline-edit-state is-change">
              {t(value === '' ? '비우기 예정' : '변경됨')}
            </span>
          )}
        </div>
        {field.masked ? (
          <InstallationProtectedInput
            id={inputId}
            fieldKey={field.key}
            value={value}
            touched={touched}
            rows={isExpanded ? 16 : 4}
            expanded={isExpanded}
            disabled={busy || policyPending}
            onChange={(next) => setValues((current) => ({ ...current, [field.id]: next }))}
            onReset={() => reset(field.id)}
          />
        ) : (
          <InstallationFieldInput
            id={inputId}
            fieldKey={field.key}
            initialValue={field.value}
            value={value}
            rows={isExpanded ? 16 : 4}
            expanded={isExpanded}
            masked={hidden}
            disabled={busy || policyPending}
            onChange={(next) => setValues((current) => ({ ...current, [field.id]: next }))}
          />
        )}
        <div className="installation-field-tools">
          <button
            type="button"
            className="text-button"
            disabled={busy || policyPending}
            onClick={() => setExpanded(isExpanded ? '' : field.id)}
            aria-expanded={isExpanded}
          >
            <Maximize2 size={13} />
            {t(isExpanded ? '기본 크기로' : '크게 편집')}
          </button>
          {touched && (
            <button
              type="button"
              className="text-button"
              disabled={busy || policyPending}
              onClick={() => reset(field.id)}
            >
              <RotateCcw size={13} />
              {t('입력 취소')}
            </button>
          )}
        </div>
      </div>
    );
  };
  const diff = (label: string, before: string, after: string, protectedValue: boolean, undo: () => void) => (
    <div className="installation-change-row">
      <dt>{label}</dt>
      <dd>
        {protectedValue ? (
          <span>
            <LockKeyhole size={13} aria-hidden="true" />
            {t(after === '' ? '보호된 값 비우기' : '보호된 값 변경')}
          </span>
        ) : (
          <>
            <del>{before || t('미등록')}</del>
            <span aria-hidden="true"> → </span>
            <ins>{after || t('비우기 예정')}</ins>
          </>
        )}
        <button type="button" className="text-button" disabled={busy || policyPending} onClick={undo}>
          {t('입력 취소')}
        </button>
      </dd>
    </div>
  );
  return (
    <section
      className="installation-inline-editor installation-section-editor"
      tabIndex={-1}
      aria-label={t('정보 수정')}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape' && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded('');
          return;
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (!busy && !policyPending && count) form.current?.requestSubmit();
        }
      }}
    >
      <header className="installation-inline-edit-header">
        <div>
          <h3>{t('{0} 수정', [t(section.title)])}</h3>
          <p>{t('필요한 항목을 찾아 수정하세요. 저장 범위는 현재 탭입니다.')}</p>
        </div>
      </header>
      <form
        ref={form}
        id={id + '-form'}
        autoComplete="off"
        spellCheck={false}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !policyPending && count) void onSave(draft, committed);
        }}
      >
        <div className="installation-group-toolbar">
          <label className="installation-group-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              disabled={busy || policyPending}
              placeholder={t('항목 이름·키로 찾기')}
              aria-label={t('수정 항목 검색')}
              onChange={(event) => {
                setQuery(event.target.value);
                setReview(false);
                setExpanded('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) event.preventDefault();
              }}
            />
          </label>
          <button
            type="button"
            className="button"
            aria-pressed={changedOnly}
            disabled={busy || policyPending}
            onClick={() => {
              setChangedOnly(!changedOnly);
              setReview(false);
            }}
          >
            {t('변경 항목만')}
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={review}
            disabled={busy || policyPending}
            onClick={() => {
              setReview(!review);
              setExpanded('');
            }}
          >
            {t('변경 내역 {0}', [count])}
          </button>
        </div>
        <div className="installation-group-layout">
          <nav className="installation-group-nav" aria-label={t('수정 항목 그룹')}>
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                disabled={busy || policyPending}
                aria-pressed={!search && !review && group.id === groupId}
                onClick={() => {
                  setSelectedGroup(group.id);
                  setQuery('');
                  setReview(false);
                  setExpanded('');
                }}
              >
                <span>{t(group.title)}</span>
                {groupCount(group.id) > 0 && (
                  <span className="installation-group-count">{groupCount(group.id)}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="installation-group-content">
            <h4>
              {review
                ? t('저장할 변경 내역')
                : search
                  ? t('검색 결과')
                  : t(groups.find((group) => group.id === groupId)?.title || '기타 항목')}
            </h4>
            {review ? (
              <>
                {section.rows.map((row) => {
                  const fields = row.fields.filter((field) => installationFieldChanged(field, values));
                  if (!fields.length && !titleChanged(row)) return null;
                  return (
                    <section key={row.id} className="installation-review-record">
                      <h5>{installationRowTitle(row)}</h5>
                      <dl>
                        {titleChanged(row) &&
                          diff(t('기록 이름'), row.title ?? section.title, titles[row.id], false, () =>
                            setTitles((current) => omit(current, [row.id])),
                          )}
                        {fields.map((field) => (
                          <div key={field.id}>
                            {diff(
                              installationFieldLabel(field),
                              field.value,
                              values[field.id],
                              field.secret || field.masked || policyPending,
                              () => reset(field.id),
                            )}
                          </div>
                        ))}
                      </dl>
                    </section>
                  );
                })}
                {sectionId === 'access' && (
                  <dl>
                    {(details.accessNotes ?? []).filter(noteChanged).map((note, index) => (
                      <div key={note.id}>
                        {diff(
                          t('참고사항 {0}', [index + 1]),
                          note.content,
                          notes[note.id],
                          note.masked || policyPending,
                          () => setNotes((current) => omit(current, [note.id])),
                        )}
                      </div>
                    ))}
                  </dl>
                )}
                {!count && <p className="installation-editor-empty">{t('변경된 내용이 없습니다.')}</p>}
              </>
            ) : (
              <>
                {section.rows.map((row, index) => {
                  const fields = row.fields.filter(matches);
                  const showTitle = titleChanged(row) && changedOnly && !search;
                  if (!fields.length && !showTitle) return null;
                  return (
                    <fieldset
                      key={row.id}
                      className="installation-section-edit-row"
                      disabled={busy || policyPending}
                    >
                      <legend>{installationRowTitle(row) || t('{0} 기록', [index + 1])}</legend>
                      {row.managed !== 'metadata' && (
                        <label className="installation-section-edit-title">
                          {t('기록 이름')}
                          <input
                            value={titles[row.id] ?? row.title ?? section.title}
                            maxLength={120}
                            onChange={(event) =>
                              setTitles((current) => ({ ...current, [row.id]: event.target.value }))
                            }
                          />
                          {titleChanged(row) && (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => setTitles((current) => omit(current, [row.id]))}
                            >
                              {t('입력 취소')}
                            </button>
                          )}
                        </label>
                      )}
                      <div className="installation-inline-edit-fields">{fields.map(renderField)}</div>
                    </fieldset>
                  );
                })}
                {showNotes &&
                  (details.accessNotes ?? [])
                    .filter((note) => !changedOnly || noteChanged(note) || active === note.id)
                    .map((note, index) => (
                      <fieldset
                        key={note.id}
                        className="installation-section-edit-row"
                        disabled={busy || policyPending}
                        onFocusCapture={() => setActive(note.id)}
                        onBlurCapture={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget)) setActive('');
                        }}
                      >
                        <legend>{t('참고사항 {0}', [index + 1])}</legend>
                        <div
                          className={
                            'installation-inline-edit-field is-wide' +
                            (noteChanged(note) ? ' is-changed' : '')
                          }
                        >
                          <label htmlFor={id + '-field-' + note.id}>{t('참고사항')}</label>
                          {note.masked ? (
                            <InstallationProtectedInput
                              id={id + '-field-' + note.id}
                              fieldKey="note"
                              value={policyPending ? '' : (notes[note.id] ?? '')}
                              touched={Object.hasOwn(notes, note.id)}
                              allowClear={false}
                              expanded={expanded === note.id}
                              disabled={busy || policyPending}
                              onChange={(next) => setNotes((current) => ({ ...current, [note.id]: next }))}
                              onReset={() => setNotes((current) => omit(current, [note.id]))}
                            />
                          ) : (
                            <InstallationFieldInput
                              id={id + '-field-' + note.id}
                              fieldKey="note"
                              rows={expanded === note.id ? 16 : 5}
                              value={policyPending ? '' : (notes[note.id] ?? note.content)}
                              expanded={expanded === note.id}
                              disabled={busy || policyPending}
                              onChange={(next) => setNotes((current) => ({ ...current, [note.id]: next }))}
                            />
                          )}
                          <div className="installation-field-tools">
                            <button
                              type="button"
                              className="text-button"
                              aria-expanded={expanded === note.id}
                              onClick={() => setExpanded(expanded === note.id ? '' : note.id)}
                            >
                              {t(expanded === note.id ? '기본 크기로' : '크게 편집')}
                            </button>
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
                        </div>
                      </fieldset>
                    ))}
                {!section.rows.some(
                  (row) => row.fields.some(matches) || (titleChanged(row) && changedOnly && !search),
                ) &&
                  !(
                    showNotes && (details.accessNotes ?? []).some((note) => !changedOnly || noteChanged(note))
                  ) && <p className="installation-editor-empty">{t('일치하는 항목이 없습니다.')}</p>}
              </>
            )}
          </div>
        </div>
        {error && (
          <p ref={errorMessage} className="installation-action-error" role="alert" tabIndex={-1}>
            {t(error)}
          </p>
        )}
        <InstallationEditorActions>
          <div className="installation-editor-summary" aria-live="polite">
            <strong>{count ? t('변경 {0}개 · 저장 전', [count]) : t('변경된 내용이 없습니다.')}</strong>
            <span>{t('저장 범위 · {0}', [t(section.title)])}</span>
          </div>
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {t('수정 취소')}
          </button>
          <button
            type="submit"
            form={id + '-form'}
            className="button primary"
            disabled={busy || policyPending || !count}
          >
            <Check size={15} />
            {t(busy ? '저장 중…' : '변경사항 저장')}
          </button>
        </InstallationEditorActions>
      </form>
    </section>
  );
}
