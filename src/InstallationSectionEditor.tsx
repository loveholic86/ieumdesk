import { useEffect, useId, useRef, useState } from 'react';
import { Check, LockKeyhole, Maximize2, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { t } from './i18n';
import { useLocale } from './use-locale';
import {
  installationFieldLabel,
  installationFieldTemplates,
  installationRowTitle,
} from './installation-labels';
import {
  visibleInstallationSection,
  type InstallationSectionOperation,
  type InstallationSectionDraft,
} from './installation-client';
import {
  commitLatestInstallationDraft,
  installationNoteReviewEntries,
  installationReviewValue,
} from './installation-draft-reconcile';
import {
  installationEditorGroups,
  installationFieldChanged,
  installationFieldGroup,
  installationLongField,
  installationInputDefinition,
  installationSectionChangeCount,
} from './installation-editor';
import type {
  InstallationDetailField,
  InstallationDetails,
  InstallationSectionId,
} from './installation-types';
import InstallationFieldInput from './InstallationFieldInput';
import InstallationProtectedInput from './InstallationProtectedInput';
import InstallationCodeOptionInput from './InstallationCodeOptionInput';
import {
  installationCodeGroupForField,
  installationOptionDisplayValue,
  installationOptionTargetKey,
  type InstallationOptionRegistrationAttempt,
  type InstallationOptionRegistrationTarget,
  type InstallationCodeGroup,
  type InstallationCodeOption,
} from './installation-code-options';
import { InstallationEditorActions, useInstallationDirty } from './InstallationEditorLayout';
import { focusInstallationField } from './installation-scroll';
import './installation-record-editor.css';
import './installation-editor.css';

type Props = {
  details: InstallationDetails;
  sectionId: InstallationSectionId;
  busy: boolean;
  policyPending: boolean;
  protectionEnabled: boolean;
  error: string;
  codeOptions: readonly InstallationCodeOption[];
  codeOptionsLoading: boolean;
  codeOptionsError: string;
  canAddSharedOptions: boolean;
  optionRegistrations: readonly InstallationOptionRegistrationAttempt[];
  onClose: () => void;
  onRetryOptions: () => void;
  onAddSharedOption: (
    group: InstallationCodeGroup,
    name: string,
    target: InstallationOptionRegistrationTarget,
  ) => Promise<InstallationCodeOption | undefined>;
  onConfirmOptionRegistration: (id: string) => void;
  onRetryOptionRegistration: (id: string) => void;
  onDismissOptionRegistration: (id: string, target: InstallationOptionRegistrationTarget) => void;
  onSave: (
    draft: InstallationSectionDraft,
    committed: (
      change: InstallationSectionOperation,
      latest: InstallationDetails,
      previous: InstallationDetails,
    ) => void,
  ) => Promise<{ uncertain?: InstallationSectionOperation; confirmedDetails?: InstallationDetails } | void>;
  onRefresh: () => Promise<boolean>;
};
const omit = (values: Record<string, string>, keys: string[]) =>
  Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key)));

export default function InstallationSectionEditor({
  details,
  sectionId,
  busy,
  policyPending,
  protectionEnabled,
  error,
  codeOptions,
  codeOptionsLoading,
  codeOptionsError,
  canAddSharedOptions,
  optionRegistrations,
  onClose,
  onRetryOptions,
  onAddSharedOption,
  onConfirmOptionRegistration,
  onRetryOptionRegistration,
  onDismissOptionRegistration,
  onSave,
  onRefresh,
}: Props) {
  useLocale();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const localSequence = useRef(0);
  const localId = (prefix: string) => `${prefix}-${Date.now()}-${++localSequence.current}`;
  const [values, setValues] = useState<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [addedRows, setAddedRows] = useState<NonNullable<InstallationSectionDraft['addedRows']>>([]);
  const [removedRows, setRemovedRows] = useState<string[]>([]);
  const [addedFields, setAddedFields] = useState<NonNullable<InstallationSectionDraft['addedFields']>>({});
  const [removedFields, setRemovedFields] = useState<NonNullable<InstallationSectionDraft['removedFields']>>(
    {},
  );
  const [addedNotes, setAddedNotes] = useState<NonNullable<InstallationSectionDraft['addedNotes']>>([]);
  const [removedNotes, setRemovedNotes] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [review, setReview] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState<{
    operation: InstallationSectionOperation;
    confirmedDetails: InstallationDetails;
  } | null>(null);
  const [refreshedAfterUncertain, setRefreshedAfterUncertain] = useState(false);
  const [expanded, setExpanded] = useState('');
  const [active, setActive] = useState('');
  const section = visibleInstallationSection(details.sections.find((item) => item.id === sectionId)!);
  const optionRegistrationForTarget = (target: InstallationOptionRegistrationTarget) => {
    const targetKey = installationOptionTargetKey(target);
    return optionRegistrations.find((attempt) =>
      attempt.targets.some((item) => installationOptionTargetKey(item) === targetKey),
    );
  };
  const scopedOptionRegistrations = optionRegistrations.filter((attempt) =>
    attempt.targets.some((target) => target.recordId === details.id && target.sectionId === sectionId),
  );
  const groups = installationEditorGroups(
    sectionId,
    section.rows.flatMap((row) => row.fields.map((field) => field.key)),
    Boolean(details.accessNotes?.length || addedNotes.length || removedNotes.length),
  );
  const [selectedGroup, setSelectedGroup] = useState(groups[0]?.id || 'other');
  const groupId = groups.some((group) => group.id === selectedGroup) ? selectedGroup : groups[0]?.id;
  const search = query.trim().toLocaleLowerCase();
  const draft: InstallationSectionDraft = {
    values,
    titles,
    notes,
    addedRows,
    removedRows,
    addedFields,
    removedFields,
    addedNotes,
    removedNotes,
  };
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);
  const count =
    installationSectionChangeCount({ ...details, sections: [section] }, sectionId, draft) +
    addedRows.length +
    removedRows.length +
    addedNotes.length +
    removedNotes.length +
    Object.values(addedFields).reduce((sum, fields) => sum + fields.length, 0) +
    Object.values(removedFields).reduce((sum, fields) => sum + fields.length, 0);
  const hasDeletions =
    removedRows.length +
      removedNotes.length +
      Object.values(removedFields).reduce((sum, fields) => sum + fields.length, 0) >
    0;
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
  const committed = (
    change: InstallationSectionOperation,
    latest: InstallationDetails,
    previous: InstallationDetails,
  ) => {
    const next = commitLatestInstallationDraft(latestDraft, change, previous, latest);
    setValues(next.values);
    setTitles(next.titles);
    setNotes(next.notes);
    setAddedRows(next.addedRows ?? []);
    setRemovedRows(next.removedRows ?? []);
    setAddedFields(next.addedFields ?? {});
    setRemovedFields(next.removedFields ?? {});
    setAddedNotes(next.addedNotes ?? []);
    setRemovedNotes(next.removedNotes ?? []);
  };
  const addRecord = () => {
    const serial = localId('new-row');
    setAddedRows((current) => [
      ...current,
      {
        localId: serial,
        title: section.title,
        fields: installationFieldTemplates[sectionId].map(([key, label]) => ({
          localId: localId('row-field'),
          key,
          label,
          value: '',
        })),
      },
    ]);
    setReview(false);
    setChangedOnly(false);
    setQuery('');
  };
  const addCustomField = (rowId: string) => {
    const row = section.rows.find((item) => item.id === rowId);
    if (!row || row.managed === 'metadata') return;
    const serial = localId('new-field');
    const used = new Set([
      ...row.fields.map((field) => field.key),
      ...(addedFields[rowId] ?? []).map((field) => field.key),
    ]);
    let key = `custom_${localSequence.current}`;
    while (used.has(key)) key += '_new';
    setAddedFields((current) => ({
      ...current,
      [rowId]: [...(current[rowId] ?? []), { localId: serial, key, label: '', value: '' }],
    }));
    setReview(false);
  };
  const addNote = () => {
    setAddedNotes((current) => [...current, { localId: localId('new-note'), content: '' }]);
    setSelectedGroup('notes');
    setReview(false);
    setChangedOnly(false);
    setQuery('');
  };
  const updateAddedRow = (
    localId: string,
    patch: Partial<NonNullable<InstallationSectionDraft['addedRows']>[number]>,
  ) =>
    setAddedRows((current) => current.map((row) => (row.localId === localId ? { ...row, ...patch } : row)));
  const updateAddedRowField = (rowId: string, localId: string, patch: Record<string, string>) =>
    setAddedRows((current) =>
      current.map((row) =>
        row.localId === rowId
          ? {
              ...row,
              fields: row.fields.map((field) => (field.localId === localId ? { ...field, ...patch } : field)),
            }
          : row,
      ),
    );
  const reset = (fieldId: string) => setValues((current) => omit(current, [fieldId]));
  const renderField = (field: InstallationDetailField, rowId: string, rowDeleting = false) => {
    const touched = Object.hasOwn(values, field.id);
    const changed = installationFieldChanged(field, values);
    const hidden = policyPending && field.secret;
    const value = hidden ? '' : touched ? values[field.id] : field.masked ? '' : field.value;
    const isExpanded = expanded === field.id;
    const isRemoved = (removedFields[rowId] ?? []).includes(field.key);
    const optionGroup =
      !field.secret && !field.masked
        ? installationCodeGroupForField(sectionId, field.key, field.label)
        : undefined;
    const wide = isExpanded || installationLongField(field.key, value) || field.masked;
    const inputId = id + '-field-' + field.id;
    return (
      <div
        key={field.id}
        className={
          'installation-inline-edit-field' +
          (wide ? ' is-wide' : '') +
          (changed ? ' is-changed' : '') +
          (isRemoved ? ' is-removed' : '') +
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
          {isRemoved && <span className="installation-inline-edit-state is-delete">{t('삭제 예정')}</span>}
        </div>
        {field.masked ? (
          <InstallationProtectedInput
            id={inputId}
            fieldKey={field.key}
            value={value}
            touched={touched}
            rows={isExpanded ? 16 : 4}
            expanded={isExpanded}
            disabled={busy || policyPending || isRemoved || rowDeleting}
            onChange={(next) => setValues((current) => ({ ...current, [field.id]: next }))}
            onReset={() => reset(field.id)}
          />
        ) : optionGroup ? (
          <InstallationCodeOptionInput
            id={inputId}
            group={optionGroup}
            fieldLabel={field.label}
            value={value}
            displayValue={touched ? value : field.value}
            optionValue={touched ? value : field.optionValue}
            options={codeOptions}
            loading={codeOptionsLoading}
            optionsError={codeOptionsError}
            canAddSharedOptions={canAddSharedOptions}
            target={{
              recordId: details.id,
              sectionId,
              targetId: field.id,
              fieldLabel: field.label,
              fieldValue: touched ? value : (field.optionValue ?? field.value),
            }}
            registration={optionRegistrationForTarget({
              recordId: details.id,
              sectionId,
              targetId: field.id,
              fieldLabel: field.label,
              fieldValue: touched ? value : (field.optionValue ?? field.value),
            })}
            disabled={busy || policyPending || isRemoved || rowDeleting}
            onChange={(next) => setValues((current) => ({ ...current, [field.id]: next }))}
            onAdd={onAddSharedOption}
            onDismissRegistration={onDismissOptionRegistration}
            onRetryOptions={onRetryOptions}
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
            disabled={busy || policyPending || isRemoved || rowDeleting}
            onChange={(next) => setValues((current) => ({ ...current, [field.id]: next }))}
          />
        )}
        <div className="installation-field-tools">
          <button
            type="button"
            className="text-button"
            disabled={busy || policyPending || rowDeleting}
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
              disabled={busy || policyPending || rowDeleting}
              onClick={() => reset(field.id)}
            >
              <RotateCcw size={13} />
              {t('입력 취소')}
            </button>
          )}
          {section.rows.find((row) => row.id === rowId)?.managed !== 'metadata' && (
            <button
              type="button"
              className="text-button"
              disabled={busy || policyPending || rowDeleting}
              onClick={() => {
                setDeleteConfirmed(false);
                setRemovedFields((current) => {
                  const keys = current[rowId] ?? [];
                  return {
                    ...current,
                    [rowId]: keys.includes(field.key)
                      ? keys.filter((key) => key !== field.key)
                      : [...keys, field.key],
                  };
                });
              }}
            >
              {isRemoved ? <RotateCcw size={13} /> : <Trash2 size={13} />}
              {t(isRemoved ? '항목 복원' : '항목 삭제')}
            </button>
          )}
        </div>
      </div>
    );
  };
  const renderAddedField = (
    field: { localId: string; key: string; label: string; value: string },
    onChange: (patch: Partial<typeof field>) => void,
    onRemove: () => void,
    sensitive = protectionEnabled,
  ) => {
    const optionGroup = installationCodeGroupForField(sectionId, field.key, field.label);
    const canonicalTemplate = installationFieldTemplates[sectionId].some(
      ([key, label]) => key === field.key && label === field.label,
    );
    const inputType = installationInputDefinition(field.key, field.value).type;
    const safeBuiltInChoice = canonicalTemplate && (inputType === 'select' || inputType === 'boolean');
    const protectedValue = sensitive && !optionGroup && !safeBuiltInChoice;
    return (
      <div className="installation-section-edit-row" key={field.localId}>
        <label className="installation-section-edit-title">
          {t('항목 이름')}
          <input
            value={field.label}
            maxLength={120}
            onChange={(event) => onChange({ label: event.target.value })}
            disabled={busy}
          />
        </label>
        <label className="installation-section-edit-title">
          {t('항목 키')}
          <input
            value={field.key}
            maxLength={80}
            onChange={(event) => onChange({ key: event.target.value })}
            disabled={busy}
            spellCheck={false}
          />
        </label>
        <div className="installation-inline-edit-field is-wide">
          <label htmlFor={`${id}-${field.localId}-value`}>
            {field.label || t('새 항목 이름을 설정하세요')}
          </label>
          {protectedValue ? (
            <InstallationProtectedInput
              id={`${id}-${field.localId}-value`}
              fieldKey={field.key}
              value={field.value}
              touched={Boolean(field.value)}
              rows={installationLongField(field.key, field.value) ? 6 : 3}
              disabled={busy || policyPending}
              onChange={(value) => onChange({ value })}
              onReset={() => onChange({ value: '' })}
            />
          ) : optionGroup ? (
            (() => {
              const target: InstallationOptionRegistrationTarget = {
                recordId: details.id,
                sectionId,
                targetId: field.localId,
                fieldLabel: field.label,
                fieldValue: field.value,
              };
              return (
                <InstallationCodeOptionInput
                  id={`${id}-${field.localId}-value`}
                  group={optionGroup}
                  fieldLabel={field.label}
                  value={field.value}
                  displayValue={field.value}
                  optionValue={field.value}
                  options={codeOptions}
                  loading={codeOptionsLoading}
                  optionsError={codeOptionsError}
                  canAddSharedOptions={canAddSharedOptions}
                  target={target}
                  registration={optionRegistrationForTarget(target)}
                  disabled={busy || policyPending}
                  onChange={(value) => onChange({ value })}
                  onAdd={onAddSharedOption}
                  onDismissRegistration={onDismissOptionRegistration}
                  onRetryOptions={onRetryOptions}
                />
              );
            })()
          ) : (
            <InstallationFieldInput
              id={`${id}-${field.localId}-value`}
              fieldKey={field.key}
              initialValue=""
              value={field.value}
              rows={installationLongField(field.key, field.value) ? 6 : 3}
              disabled={busy || policyPending}
              onChange={(value) => onChange({ value })}
            />
          )}
          <div className="installation-field-tools">
            <button type="button" className="text-button danger-text" disabled={busy} onClick={onRemove}>
              <Trash2 size={13} />
              {t('항목 삭제')}
            </button>
          </div>
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
          if (!busy && !policyPending && count && (!hasDeletions || deleteConfirmed) && !uncertain) {
            void onSave(draft, committed).then((result) => {
              if (result?.uncertain) {
                setUncertain({
                  operation: result.uncertain,
                  confirmedDetails: result.confirmedDetails ?? details,
                });
                setRefreshedAfterUncertain(false);
              }
            });
          }
        }}
      >
        {scopedOptionRegistrations.length > 0 && (
          <div className="installation-code-option-registration-list" aria-label={t('공용 선택지 등록 확인')}>
            {scopedOptionRegistrations.map((attempt) => {
              const scopedTargets = attempt.targets.filter(
                (target) => target.recordId === details.id && target.sectionId === sectionId,
              );
              return (
                <div key={attempt.id} className="installation-code-option-registration" role="status">
                  <strong>{t('{0} 공용 선택지', [attempt.name])}</strong>
                  <p>{t(attempt.message || '공용 선택지 등록 결과를 확인해야 합니다.')}</p>
                  {attempt.state === 'uncertain' && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => onConfirmOptionRegistration(attempt.id)}
                    >
                      {t('등록 여부 다시 확인')}
                    </button>
                  )}
                  {attempt.state === 'absent' && (
                    <div className="installation-code-option-registration-actions">
                      <button
                        type="button"
                        className="button"
                        disabled={busy || !canAddSharedOptions}
                        onClick={() => onRetryOptionRegistration(attempt.id)}
                      >
                        {t('확인 후 등록 재시도')}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          scopedTargets.forEach((target) => onDismissOptionRegistration(attempt.id, target))
                        }
                      >
                        {t('확인했고 요청 정리')}
                      </button>
                    </div>
                  )}
                  {attempt.state === 'found' && (
                    <div className="installation-code-option-registration-actions">
                      <small>
                        {t('선택지 목록에 반영했습니다. 원래 값이 바뀌었으면 필드에서 직접 선택해 주세요.')}
                      </small>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          scopedTargets.forEach((target) => onDismissOptionRegistration(attempt.id, target))
                        }
                      >
                        {t('확인 완료')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
          {sectionId !== 'files' && (
            <button type="button" className="button" disabled={busy || policyPending} onClick={addRecord}>
              <Plus size={14} />
              {t('기록 추가')}
            </button>
          )}
          {sectionId === 'access' && (
            <button type="button" className="button" disabled={busy || policyPending} onClick={addNote}>
              <Plus size={14} />
              {t('참고사항 추가')}
            </button>
          )}
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
                  const removed = removedFields[row.id] ?? [];
                  const rowDeleting = removedRows.includes(row.id);
                  if (
                    !fields.length &&
                    !titleChanged(row) &&
                    !removed.length &&
                    !rowDeleting &&
                    !addedFields[row.id]?.length
                  )
                    return null;
                  return (
                    <section key={row.id} className="installation-review-record">
                      <h5>{installationRowTitle(row)}</h5>
                      {rowDeleting && (
                        <p className="installation-inline-edit-state is-delete">{t('기록 삭제 예정')}</p>
                      )}
                      <dl>
                        {titleChanged(row) &&
                          diff(t('기록 이름'), row.title ?? section.title, titles[row.id], false, () =>
                            setTitles((current) => omit(current, [row.id])),
                          )}
                        {fields.map((field) => (
                          <div key={field.id}>
                            {diff(
                              installationFieldLabel(field),
                              installationOptionDisplayValue(
                                codeOptions,
                                installationCodeGroupForField(sectionId, field.key, field.label),
                                field.value,
                                field.optionValue,
                              ),
                              installationOptionDisplayValue(
                                codeOptions,
                                installationCodeGroupForField(sectionId, field.key, field.label),
                                values[field.id],
                                values[field.id],
                              ),
                              field.secret || field.masked || policyPending,
                              () => reset(field.id),
                            )}
                          </div>
                        ))}
                        {removed.map((key) => {
                          const field = row.fields.find((item) => item.key === key);
                          return field ? (
                            <div key={`removed-${field.id}`} className="installation-change-row">
                              <dt>{installationFieldLabel(field)}</dt>
                              <dd>{t('항목 삭제 예정')}</dd>
                            </div>
                          ) : null;
                        })}
                        {(addedFields[row.id] ?? []).map((field) => (
                          <div key={field.localId} className="installation-change-row">
                            <dt>{field.label || t('새 항목')}</dt>
                            <dd>
                              {installationCodeGroupForField(sectionId, field.key, field.label) ? (
                                installationOptionDisplayValue(
                                  codeOptions,
                                  installationCodeGroupForField(sectionId, field.key, field.label),
                                  field.value,
                                  field.value,
                                ) || t('미등록')
                              ) : installationReviewValue(field.value, protectionEnabled) === undefined ? (
                                <>
                                  <LockKeyhole size={13} aria-hidden="true" />
                                  {t('보호된 값 변경')}
                                </>
                              ) : (
                                installationReviewValue(field.value, false) || t('미등록')
                              )}
                              {' · '}
                              {t('추가 예정')}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  );
                })}
                {addedRows.map((row) => (
                  <section key={row.localId} className="installation-review-record">
                    <h5>{row.title || t('새 기록')}</h5>
                    <p>
                      {t('기록 추가 예정')} · {t('{0}개 항목', [row.fields.length])}
                    </p>
                  </section>
                ))}
                {sectionId === 'access' && (
                  <dl>
                    {installationNoteReviewEntries(details.accessNotes ?? [], removedNotes).map(
                      ({ note, index }) => (
                        <div key={`remove-${note.id}`} className="installation-change-row">
                          <dt>{t('참고사항 {0}', [index + 1])}</dt>
                          <dd>{t('삭제 예정')}</dd>
                        </div>
                      ),
                    )}
                    {(details.accessNotes ?? []).filter(noteChanged).map((note, index) => (
                      <div key={`edit-${note.id}`}>
                        {diff(
                          t('참고사항 {0}', [index + 1]),
                          note.content,
                          notes[note.id],
                          note.masked || policyPending,
                          () => setNotes((current) => omit(current, [note.id])),
                        )}
                      </div>
                    ))}
                    {addedNotes.map((note, index) => (
                      <div key={note.localId} className="installation-change-row">
                        <dt>{t('새 참고사항 {0}', [index + 1])}</dt>
                        <dd>
                          {installationReviewValue(note.content, protectionEnabled) === undefined ? (
                            <>
                              <LockKeyhole size={13} aria-hidden="true" />
                              {t('보호된 값 변경')}
                            </>
                          ) : (
                            installationReviewValue(note.content, false) || t('미등록')
                          )}
                          {' · '}
                          {t('추가 예정')}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {!count && <p className="installation-editor-empty">{t('변경된 내용이 없습니다.')}</p>}
                {hasDeletions && (
                  <label className="installation-delete-confirm">
                    <input
                      type="checkbox"
                      checked={deleteConfirmed}
                      onChange={(event) => setDeleteConfirmed(event.target.checked)}
                      disabled={busy}
                    />
                    {t('삭제할 기록과 항목을 확인했습니다.')}
                  </label>
                )}
              </>
            ) : (
              <>
                {section.rows.map((row, index) => {
                  const fields = row.fields.filter(
                    (field) => matches(field) || (removedFields[row.id] ?? []).includes(field.key),
                  );
                  const showTitle = titleChanged(row) && changedOnly && !search;
                  const deleting = removedRows.includes(row.id);
                  const createdFields = addedFields[row.id] ?? [];
                  if (!fields.length && !showTitle && !deleting && !createdFields.length) return null;
                  return (
                    <fieldset
                      key={row.id}
                      className={`installation-section-edit-row${deleting ? ' is-removed' : ''}`}
                      disabled={busy || policyPending}
                    >
                      <legend>{installationRowTitle(row) || t('{0} 기록', [index + 1])}</legend>
                      {row.managed !== 'metadata' && (
                        <label className="installation-section-edit-title">
                          {t('기록 이름')}
                          <input
                            value={titles[row.id] ?? row.title ?? section.title}
                            maxLength={120}
                            disabled={deleting}
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
                          <button
                            type="button"
                            className="text-button danger-text"
                            disabled={busy}
                            onClick={() => {
                              setDeleteConfirmed(false);
                              setRemovedRows((current) =>
                                deleting ? current.filter((id) => id !== row.id) : [...current, row.id],
                              );
                              setReview(false);
                            }}
                          >
                            {deleting ? <RotateCcw size={13} /> : <Trash2 size={13} />}
                            {t(deleting ? '기록 복원' : '기록 삭제')}
                          </button>
                        </label>
                      )}
                      <div className="installation-inline-edit-fields">
                        {fields.map((field) => renderField(field, row.id, deleting))}
                      </div>
                      {createdFields.map((field) =>
                        renderAddedField(
                          field,
                          (patch) =>
                            setAddedFields((current) => ({
                              ...current,
                              [row.id]: (current[row.id] ?? []).map((item) =>
                                item.localId === field.localId ? { ...item, ...patch } : item,
                              ),
                            })),
                          () =>
                            setAddedFields((current) => ({
                              ...current,
                              [row.id]: (current[row.id] ?? []).filter(
                                (item) => item.localId !== field.localId,
                              ),
                            })),
                        ),
                      )}
                      {row.managed !== 'metadata' && (
                        <button
                          type="button"
                          className="button"
                          disabled={busy || policyPending || deleting}
                          onClick={() => addCustomField(row.id)}
                        >
                          <Plus size={14} />
                          {t('항목 추가')}
                        </button>
                      )}
                    </fieldset>
                  );
                })}
                {addedRows.map((row, index) => (
                  <fieldset
                    key={row.localId}
                    className="installation-section-edit-row"
                    disabled={busy || policyPending}
                  >
                    <legend>{t('새 기록 {0}', [index + 1])}</legend>
                    <label className="installation-section-edit-title">
                      {t('기록 이름')}
                      <input
                        value={row.title}
                        maxLength={120}
                        onChange={(event) => updateAddedRow(row.localId, { title: event.target.value })}
                      />
                      <button
                        type="button"
                        className="text-button danger-text"
                        disabled={busy}
                        onClick={() =>
                          setAddedRows((current) => current.filter((item) => item.localId !== row.localId))
                        }
                      >
                        <Trash2 size={13} />
                        {t('기록 삭제')}
                      </button>
                    </label>
                    <div className="installation-inline-edit-fields">
                      {row.fields.map((field, fieldIndex) =>
                        renderAddedField(
                          { ...field, localId: field.localId ?? `new-field-${row.localId}-${fieldIndex}` },
                          (patch) =>
                            updateAddedRowField(
                              row.localId,
                              field.localId ?? `new-field-${row.localId}-${fieldIndex}`,
                              patch,
                            ),
                          () =>
                            updateAddedRow(row.localId, {
                              fields: row.fields.filter((item) => item.localId !== field.localId),
                            }),
                        ),
                      )}
                    </div>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || policyPending}
                      onClick={() => {
                        localSequence.current += 1;
                        const used = new Set(row.fields.map((field) => field.key));
                        let key = `custom_${localSequence.current}`;
                        while (used.has(key)) key += '_new';
                        updateAddedRow(row.localId, {
                          fields: [
                            ...row.fields,
                            { localId: localId('row-field'), key, label: '', value: '' },
                          ],
                        });
                      }}
                    >
                      <Plus size={14} />
                      {t('항목 추가')}
                    </button>
                  </fieldset>
                ))}
                {showNotes &&
                  (details.accessNotes ?? [])
                    .filter(
                      (note) =>
                        !changedOnly ||
                        noteChanged(note) ||
                        removedNotes.includes(note.id) ||
                        active === note.id,
                    )
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
                        <legend>
                          {t('참고사항 {0}', [index + 1])}
                          {removedNotes.includes(note.id) ? ` · ${t('삭제 예정')}` : ''}
                        </legend>
                        <div
                          className={
                            'installation-inline-edit-field is-wide' +
                            (noteChanged(note) ? ' is-changed' : '') +
                            (removedNotes.includes(note.id) ? ' is-removed' : '')
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
                              disabled={busy || policyPending || removedNotes.includes(note.id)}
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
                              disabled={busy || policyPending || removedNotes.includes(note.id)}
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
                            <button
                              type="button"
                              className="text-button danger-text"
                              onClick={() => {
                                setRemovedNotes((current) =>
                                  removedNotes.includes(note.id)
                                    ? current.filter((id) => id !== note.id)
                                    : [...current, note.id],
                                );
                                setDeleteConfirmed(false);
                                setReview(false);
                              }}
                            >
                              {removedNotes.includes(note.id) ? (
                                <RotateCcw size={13} />
                              ) : (
                                <Trash2 size={13} />
                              )}
                              {t(removedNotes.includes(note.id) ? '참고사항 복원' : '참고사항 삭제')}
                            </button>
                          </div>
                        </div>
                      </fieldset>
                    ))}
                {addedNotes.map((note, index) => (
                  <fieldset
                    key={note.localId}
                    className="installation-section-edit-row"
                    disabled={busy || policyPending}
                  >
                    <legend>{t('새 참고사항 {0}', [index + 1])}</legend>
                    <div className="installation-inline-edit-field is-wide is-changed">
                      <label htmlFor={`${id}-${note.localId}`}>{t('참고사항')}</label>
                      {protectionEnabled ? (
                        <InstallationProtectedInput
                          id={`${id}-${note.localId}`}
                          fieldKey="note"
                          value={note.content}
                          touched={Boolean(note.content)}
                          rows={5}
                          maxLength={16384}
                          allowClear={false}
                          disabled={busy || policyPending}
                          onChange={(value) =>
                            setAddedNotes((current) =>
                              current.map((item) =>
                                item.localId === note.localId ? { ...item, content: value } : item,
                              ),
                            )
                          }
                          onReset={() =>
                            setAddedNotes((current) =>
                              current.map((item) =>
                                item.localId === note.localId ? { ...item, content: '' } : item,
                              ),
                            )
                          }
                        />
                      ) : (
                        <textarea
                          id={`${id}-${note.localId}`}
                          rows={5}
                          maxLength={16384}
                          value={note.content}
                          onChange={(event) =>
                            setAddedNotes((current) =>
                              current.map((item) =>
                                item.localId === note.localId
                                  ? { ...item, content: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      )}
                      <div className="installation-field-tools">
                        <span>{note.content.length.toLocaleString()} / 16,384</span>
                        <button
                          type="button"
                          className="text-button danger-text"
                          disabled={busy}
                          onClick={() =>
                            setAddedNotes((current) =>
                              current.filter((item) => item.localId !== note.localId),
                            )
                          }
                        >
                          <Trash2 size={13} />
                          {t('참고사항 삭제')}
                        </button>
                      </div>
                    </div>
                  </fieldset>
                ))}
                {!section.rows.some(
                  (row) => row.fields.some(matches) || (titleChanged(row) && changedOnly && !search),
                ) &&
                  !addedRows.length &&
                  !addedNotes.length &&
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
            disabled={
              busy || policyPending || !count || (hasDeletions && !deleteConfirmed) || Boolean(uncertain)
            }
          >
            <Check size={15} />
            {t(busy ? '저장 중…' : '변경사항 저장')}
          </button>
        </InstallationEditorActions>
        {(error || uncertain) && (
          <div className="installation-section-reconcile" role="status">
            {uncertain && (
              <p>
                {t(
                  '저장 결과를 확인하지 못해 재시도하지 않았습니다. 최신 정보를 불러와 서버 반영 여부를 확인하세요.',
                )}
              </p>
            )}
            {error && !uncertain && <p>{t('최신 정보를 확인한 뒤 다시 저장할 수 있습니다.')}</p>}
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                void onRefresh().then((success) => {
                  if (success && uncertain) setRefreshedAfterUncertain(true);
                });
              }}
            >
              {t('최신 정보 다시 불러오기')}
            </button>
            {uncertain && refreshedAfterUncertain && (
              <>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    committed(uncertain.operation, details, uncertain.confirmedDetails);
                    setUncertain(null);
                    setRefreshedAfterUncertain(false);
                  }}
                >
                  {t('이미 반영됨')}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setUncertain(null);
                    setRefreshedAfterUncertain(false);
                  }}
                >
                  {t('반영되지 않음을 확인하고 다시 시도')}
                </button>
              </>
            )}
          </div>
        )}
      </form>
    </section>
  );
}
