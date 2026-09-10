import { installationFieldTemplates as templates, installationFieldLabel } from './installation-labels';
import { t } from './i18n';
import { useLocale } from './use-locale';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, Check, LockKeyhole, Maximize2, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type {
  InstallationDetailField,
  InstallationDetailRow,
  InstallationSectionId,
} from './installation-types';

import { prepareInstallationRow, type RowDraftPayload } from './installation-client';
import './installation-record-editor.css';
export type { RowDraftPayload } from './installation-client';

type AddedField = { localId: number; key: string; label: string; value: string };
type FocusedField = { kind: 'existing'; key: string } | { kind: 'added'; localId: number };
const longContent = (label: string, key: string, value: string) =>
  value.includes('\n') ||
  value.length > 150 ||
  /비고|메모|설명|내용|설정 값|주소|note|description|etc|set_value/i.test(`${label} ${key}`);
type Props = {
  sectionId: InstallationSectionId;
  sectionTitle: string;
  row?: InstallationDetailRow;
  busy: boolean;
  error: string;
  policyPending: boolean;
  onClose: () => void;
  onSave: (payload: RowDraftPayload) => void;
};

export default function InstallationRecordEditor({
  sectionId,
  sectionTitle,
  row,
  busy,
  error,
  policyPending,
  onClose,
  onSave,
}: Props) {
  useLocale();
  const isMetadata = row?.managed === 'metadata';
  const [title, setTitle] = useState(row?.title || sectionTitle);
  const [values, setValues] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [nextId, setNextId] = useState(templates[sectionId].length);
  const [added, setAdded] = useState<AddedField[]>(
    row ? [] : templates[sectionId].map(([key, label], localId) => ({ localId, key, label, value: '' })),
  );
  const [localError, setLocalError] = useState('');
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [focused, setFocused] = useState<FocusedField | null>(null);
  const [activeCard, setActiveCard] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<number | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<HTMLElement>(null);
  const returnFocus = useRef<string | null>(null);
  const previousScroll = useRef(0);
  const id = useId();
  const isChanged = (field: InstallationDetailField) =>
    Object.hasOwn(values, field.key) && (field.masked || values[field.key] !== field.value);
  const changedCount =
    row?.fields.filter((field) => !removed.includes(field.key) && isChanged(field)).length ?? 0;
  const titleChanged = title.trim() !== (row?.title || sectionTitle);
  const hasChanges = !row || titleChanged || changedCount > 0 || removed.length > 0 || added.length > 0;
  const search = query.trim().toLocaleLowerCase();
  const matches = (label: string, key: string) =>
    !search || `${label} ${key}`.toLocaleLowerCase().includes(search);
  const visibleFields =
    row?.fields.filter(
      (field) =>
        activeCard === field.id ||
        (matches(field.label, field.key) &&
          (!changedOnly || isChanged(field) || removed.includes(field.key))),
    ) ?? [];
  const visibleAdded = added.filter(
    (field) => activeCard === `added-${field.localId}` || matches(field.label, field.key),
  );
  const totalFields = (row?.fields.length ?? 0) + added.length;
  const visibleCount = visibleFields.length + visibleAdded.length;
  const focusedExisting =
    focused?.kind === 'existing' ? row?.fields.find((field) => field.key === focused.key) : undefined;
  const focusedAdded =
    focused?.kind === 'added' ? added.find((field) => field.localId === focused.localId) : undefined;
  const inFocus = Boolean(focusedExisting || focusedAdded);

  useEffect(() => {
    editor.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (focused) {
      const input = document.getElementById(`${id}-focused-value`);
      input?.focus({ preventScroll: true });
      input?.scrollIntoView({ block: 'nearest' });
    } else if (returnFocus.current) {
      const candidate = document.getElementById(returnFocus.current);
      const target = candidate?.matches(':disabled') ? null : candidate;
      const scroll = editor.current?.closest<HTMLElement>('.installation-content-scroll');
      if (scroll) scroll.scrollTop = previousScroll.current;
      (target ?? document.getElementById(`${id}-search`))?.focus({ preventScroll: Boolean(target) });
      returnFocus.current = null;
    }
  }, [focused, id]);
  const expandField = (target: FocusedField, triggerId: string) => {
    previousScroll.current =
      editor.current?.closest<HTMLElement>('.installation-content-scroll')?.scrollTop ?? 0;
    returnFocus.current = triggerId;
    setFocused(target);
  };
  useEffect(() => {
    if (lastAdded !== null) {
      const input = document.getElementById(`${id}-added-${lastAdded}-label`);
      input?.focus();
      input?.scrollIntoView({ block: 'nearest' });
    }
  }, [lastAdded, id]);
  const updateAdded = (id: number, patch: Partial<AddedField>) =>
    setAdded((current) => current.map((field) => (field.localId === id ? { ...field, ...patch } : field)));
  const leaveCard = (event: React.FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setActiveCard(null);
  };
  const addField = () => {
    setQuery('');
    setChangedOnly(false);
    setFocused(null);
    setAdded((current) => [...current, { localId: nextId, key: '', label: '', value: '' }]);
    setLastAdded(nextId);
    setNextId(nextId + 1);
  };
  const valueCount = (value: string, preserved = false) =>
    preserved
      ? '기존 값 유지'
      : `${value.length.toLocaleString()} / 16,384자${value.includes('\n') ? ` · ${value.split('\n').length}줄` : ''}`;
  const renderField = (field: InstallationDetailField, expanded = false) => {
    const isRemoved = removed.includes(field.key);
    const touched = Object.hasOwn(values, field.key);
    const changed = isChanged(field);
    const hidden = policyPending && field.secret;
    const value = hidden ? '' : touched ? values[field.key] : field.masked ? '' : field.value;
    const wide = longContent(field.label, field.key, value);
    const inputId = expanded ? `${id}-focused-value` : `${id}-value-${field.id}`;
    return (
      <div
        key={field.id}
        onFocusCapture={() => setActiveCard(field.id)}
        onBlurCapture={leaveCard}
        className={`installation-inline-edit-field${wide ? ' is-wide' : ''}${expanded ? ' is-expanded' : ''}${changed ? ' is-changed' : ''}${isRemoved ? ' is-removed' : ''}`}
      >
        <div className="installation-inline-edit-field-heading">
          <label htmlFor={inputId}>
            {installationFieldLabel(field)}
            {field.secret && <LockKeyhole size={14} aria-hidden="true" />}
          </label>
          <span
            id={`${inputId}-state`}
            className={`installation-inline-edit-state${isRemoved ? ' is-delete' : changed ? ' is-change' : ''}`}
          >
            {isRemoved
              ? t('삭제 예정')
              : changed
                ? value === ''
                  ? t('비우기 예정')
                  : t('변경됨')
                : field.masked
                  ? t('보호된 값')
                  : ''}
          </span>
        </div>
        <textarea
          id={inputId}
          aria-describedby={`${inputId}-state`}
          maxLength={16384}
          rows={expanded ? 16 : wide ? 6 : 2}
          value={value}
          onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
          placeholder={field.masked ? t('현재 값 유지 · 변경할 때만 입력') : t('내용을 입력하세요')}
          disabled={busy || isRemoved || hidden}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="installation-inline-edit-value-meta">
          <span>{t(valueCount(value, Boolean(field.masked && !touched)))}</span>
          {!expanded && (
            <button
              type="button"
              disabled={busy || isRemoved || hidden}
              id={`${id}-expand-${field.id}`}
              onClick={() => expandField({ kind: 'existing', key: field.key }, `${id}-expand-${field.id}`)}
              aria-label={t('{0} 크게 편집', [installationFieldLabel(field)])}
            >
              <Maximize2 size={14} />
              {t('크게 편집')}
            </button>
          )}
        </div>
        <div className="installation-inline-edit-field-actions">
          {touched && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setValues((current) =>
                  Object.fromEntries(Object.entries(current).filter(([key]) => key !== field.key)),
                )
              }
            >
              <RotateCcw size={14} />
              {t('입력 취소')}
            </button>
          )}
          {!isRemoved && field.masked && !touched && (
            <button
              type="button"
              disabled={busy || policyPending}
              onClick={() => setValues((current) => ({ ...current, [field.key]: '' }))}
            >
              {t('값 비우기')}
            </button>
          )}
          {!isMetadata && (
            <button
              type="button"
              className={isRemoved ? '' : 'danger-text'}
              disabled={busy}
              onClick={() =>
                setRemoved((current) =>
                  isRemoved ? current.filter((key) => key !== field.key) : [...current, field.key],
                )
              }
            >
              {isRemoved ? <RotateCcw size={14} /> : <Trash2 size={14} />}
              {isRemoved ? t('항목 복원') : t('항목 삭제')}
            </button>
          )}
        </div>
      </div>
    );
  };
  const renderAdded = (field: AddedField, expanded = false) => {
    const value = policyPending ? '' : field.value;
    const valueId = expanded ? `${id}-focused-value` : `${id}-added-${field.localId}-value`;
    return (
      <fieldset
        key={field.localId}
        className={`installation-inline-new-field${expanded ? ' is-expanded' : ''}`}
        onFocusCapture={() => setActiveCard(`added-${field.localId}`)}
        onBlurCapture={leaveCard}
      >
        <legend>
          {t('새 항목 ')}
          {added.indexOf(field) + 1}
        </legend>
        <div className="installation-inline-new-field-definition">
          <label htmlFor={`${id}-added-${field.localId}-label`}>
            {t('항목 이름')}
            <input
              id={`${id}-added-${field.localId}-label`}
              value={field.label}
              maxLength={120}
              onChange={(event) => updateAdded(field.localId, { label: event.target.value })}
              disabled={busy}
            />
          </label>
          <label>
            {t('항목 키')}
            <input
              value={field.key}
              maxLength={80}
              placeholder={t('예: server_name')}
              onChange={(event) => updateAdded(field.localId, { key: event.target.value })}
              disabled={busy}
              spellCheck={false}
            />
          </label>
        </div>
        <label htmlFor={valueId} className="installation-inline-new-value-label">
          {t('값')}
        </label>
        <textarea
          id={valueId}
          aria-label={t('{0} 값', [field.label || t('새 항목')])}
          maxLength={16384}
          value={value}
          rows={expanded ? 16 : longContent(field.label, field.key, value) ? 6 : 3}
          onChange={(event) => updateAdded(field.localId, { value: event.target.value })}
          disabled={busy || policyPending}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="installation-inline-edit-value-meta">
          <span>{t(valueCount(value))}</span>
          {!expanded && (
            <button
              type="button"
              disabled={busy || policyPending}
              aria-label={t('{0} 크게 편집', [field.label || t('새 항목')])}
              id={`${id}-expand-added-${field.localId}`}
              onClick={() =>
                expandField({ kind: 'added', localId: field.localId }, `${id}-expand-added-${field.localId}`)
              }
            >
              <Maximize2 size={14} />
              {t('크게 편집')}
            </button>
          )}
        </div>
        <button
          type="button"
          className="icon-button danger-text"
          aria-label={t('{0} 삭제', [field.label || t('새 항목')])}
          onClick={() => {
            setAdded((current) => current.filter((item) => item.localId !== field.localId));
            if (expanded) setFocused(null);
          }}
          disabled={busy}
        >
          <Trash2 size={17} />
        </button>
      </fieldset>
    );
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || policyPending) return;
    try {
      const payload = prepareInstallationRow(row, title, values, removed, added);
      setLocalError('');
      onSave(payload);
    } catch (reason) {
      setQuery('');
      setChangedOnly(false);
      setFocused(null);
      setLocalError(reason instanceof Error ? reason.message : '입력한 항목을 확인해 주세요.');
    }
  };
  return (
    <section
      ref={editor}
      className="installation-inline-editor"
      tabIndex={-1}
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-description`}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape' && inFocus) {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) setFocused(null);
          return;
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (!busy && !policyPending && hasChanges) form.current?.requestSubmit();
        }
      }}
    >
      <header className="installation-inline-edit-header">
        <div>
          <h3 id={`${id}-heading`}>
            {t(sectionTitle)} {row ? t('수정') : t('추가')}
          </h3>
          <p id={`${id}-description`}>
            {t('이 기록의 항목을 수정하세요. 긴 내용도 이 영역에서 크게 펼쳐 편집할 수 있습니다.')}
          </p>
        </div>
        <div className="installation-inline-edit-window-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t('편집 닫기')}
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
      </header>
      <form
        autoComplete="off"
        spellCheck={false}
        ref={form}
        onSubmit={submit}
        className="installation-inline-edit-form"
      >
        {!inFocus && (
          <div className="installation-inline-edit-toolbar">
            <div className="installation-inline-edit-toolbar-top">
              {isMetadata ? (
                <div className="installation-inline-edit-title">
                  <span>{t('기록 이름')}</span>
                  <strong>{title}</strong>
                </div>
              ) : (
                <label className="installation-inline-edit-title">
                  {t('기록 이름')}
                  <input
                    value={title}
                    maxLength={120}
                    onChange={(event) => setTitle(event.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              <label className="installation-inline-edit-search">
                <Search size={18} />
                <input
                  type="search"
                  id={`${id}-search`}
                  aria-label={t('수정 항목 검색')}
                  placeholder={t('항목 이름·키로 찾기')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229 &&
                      !event.metaKey &&
                      !event.ctrlKey
                    )
                      event.preventDefault();
                  }}
                />
              </label>
            </div>
            <div className="installation-inline-edit-tools">
              <span className="installation-inline-edit-count">
                {t('전체 ')}
                <strong>{totalFields}</strong>
                {t('개')}
                {(search || changedOnly) && t(' · {0}개 표시', [visibleCount])}
              </span>
              <button
                type="button"
                className={`installation-inline-edit-filter${changedOnly ? ' is-active' : ''}`}
                aria-pressed={changedOnly}
                onClick={() => setChangedOnly((current) => !current)}
              >
                <Check size={15} />
                {t('변경한 항목만')}
                {changedCount + removed.length + added.length > 0
                  ? ` ${changedCount + removed.length + added.length}`
                  : ''}
              </button>
              {!isMetadata && (
                <button
                  type="button"
                  className="button installation-inline-add-field"
                  onClick={addField}
                  disabled={busy}
                >
                  <Plus size={16} />
                  {t('항목 추가')}
                </button>
              )}
            </div>
          </div>
        )}
        {inFocus && (
          <div className="installation-inline-edit-focus-bar">
            <button type="button" onClick={() => setFocused(null)}>
              <ArrowLeft size={17} />
              {t('전체 항목으로')}
            </button>
            <span>{t('작성한 내용은 돌아가도 유지됩니다.')}</span>
          </div>
        )}
        <div className={`installation-inline-edit-body${inFocus ? ' is-focused' : ''}`}>
          {row?.fields.some((field) => field.masked) && (
            <p className="installation-inline-edit-hint">
              <LockKeyhole size={14} />
              {t(' 보호된 값은 새 값을 입력한 항목만 교체합니다.')}
            </p>
          )}
          {inFocus ? (
            <>
              {focusedExisting && renderField(focusedExisting, true)}
              {focusedAdded && renderAdded(focusedAdded, true)}
            </>
          ) : (
            <>
              <div className="installation-inline-edit-fields">
                {visibleFields.map((field) => renderField(field))}
              </div>
              {visibleAdded.length > 0 && (
                <div className="installation-inline-new-fields">
                  {visibleAdded.map((field) => renderAdded(field))}
                </div>
              )}
              {visibleCount === 0 && (
                <div className="installation-inline-edit-empty">
                  <Search size={26} />
                  <strong>
                    {changedOnly && !search ? t('변경한 항목이 없습니다.') : t('일치하는 항목이 없습니다.')}
                  </strong>
                  <p>{t('항목 이름이나 키를 확인하거나 전체 항목을 표시하세요.')}</p>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setQuery('');
                      setChangedOnly(false);
                    }}
                  >
                    {t('전체 항목 보기')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {(localError || error) && (
          <p className="installation-inline-edit-error" role="alert">
            {t(localError) || t(error)}
          </p>
        )}
        {policyPending && (
          <p className="installation-inline-edit-policy" role="status">
            {t('보호 설정을 확인하고 있습니다.')}
          </p>
        )}
        <footer className="installation-inline-edit-footer">
          <div className="installation-inline-edit-save-summary" aria-live="polite">
            <strong>
              {hasChanges
                ? [
                    titleChanged && row ? '이름 변경' : '',
                    changedCount ? `변경 ${changedCount}` : '',
                    added.length ? `추가 ${added.length}` : '',
                    removed.length ? `삭제 ${removed.length}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ') || t('새 기록 작성 중')
                : t('변경된 내용이 없습니다.')}
            </strong>
            <span>{t('저장을 누르면 변경사항이 반영됩니다.')}</span>
          </div>
          <div className="installation-inline-edit-save-actions">
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              {t('취소')}
            </button>
            <button type="submit" className="button primary" disabled={busy || policyPending || !hasChanges}>
              {busy ? t('저장 중…') : t('저장')}
            </button>
          </div>
        </footer>
      </form>
    </section>
  );
}
