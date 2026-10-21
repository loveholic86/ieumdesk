import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { t } from './i18n';
import { useLocale } from './use-locale';
import InstallationFieldInput from './InstallationFieldInput';
import {
  installationOptionForFieldValue,
  installationOptionNameKey,
  installationOptionRegistrationMatchesTarget,
  normalizeInstallationOptionName,
  type InstallationOptionRegistrationAttempt,
  type InstallationOptionRegistrationTarget,
  type InstallationCodeGroup,
  type InstallationCodeOption,
} from './installation-code-options';

type Props = {
  id: string;
  group: InstallationCodeGroup;
  fieldLabel: string;
  value: string;
  displayValue: string;
  optionValue?: string;
  options: readonly InstallationCodeOption[];
  loading: boolean;
  optionsError: string;
  canAddSharedOptions: boolean;
  target: InstallationOptionRegistrationTarget;
  registration?: InstallationOptionRegistrationAttempt;
  disabled?: boolean;
  onChange: (value: string) => void;
  onAdd: (
    group: InstallationCodeGroup,
    name: string,
    target: InstallationOptionRegistrationTarget,
  ) => Promise<InstallationCodeOption | undefined>;
  onDismissRegistration: (id: string, target: InstallationOptionRegistrationTarget) => void;
  onRetryOptions: () => void;
};

export default function InstallationCodeOptionInput({
  id,
  group,
  fieldLabel,
  value,
  displayValue,
  optionValue,
  options,
  loading,
  optionsError,
  canAddSharedOptions,
  target,
  registration,
  disabled,
  onChange,
  onAdd,
  onDismissRegistration,
  onRetryOptions,
}: Props) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(registration?.draftName ?? '');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (registration) setOpen(true);
  }, [registration?.id]);
  const optionValueForSelection =
    optionValue ?? installationOptionForFieldValue(options, group, value)?.code ?? value;
  const currentTarget = { ...target, fieldValue: optionValueForSelection };
  const canApplyRegistration = Boolean(
    registration?.option &&
    installationOptionRegistrationMatchesTarget(
      registration,
      currentTarget,
      group,
      fieldLabel,
      optionValueForSelection,
    ),
  );
  const currentSelection = useRef({
    value: optionValueForSelection,
    target: currentTarget,
    group,
    fieldLabel,
  });
  currentSelection.current = { value: optionValueForSelection, target: currentTarget, group, fieldLabel };
  const matchingOptions = options
    .filter((option) => option.group === group)
    .filter(
      (option) =>
        !search.trim() || option.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    );
  const selectedOption = installationOptionForFieldValue(options, group, optionValueForSelection);
  const optionsForGroup = matchingOptions
    .concat(
      selectedOption && !matchingOptions.some((option) => option.code === selectedOption.code)
        ? [selectedOption]
        : [],
    )
    .map((option) => ({ value: option.code, label: option.name }));
  const normalizedName = normalizeInstallationOptionName(name);
  const duplicate = normalizedName
    ? options.find(
        (option) =>
          option.group === group &&
          installationOptionNameKey(option.name) === installationOptionNameKey(normalizedName),
      )
    : undefined;

  const submit = async () => {
    if (busyRef.current || disabled || loading || optionsError || registration) return;
    if (!normalizedName) {
      setError(t('공용 선택지 이름은 안전한 분류명으로 80자 이내로 입력해 주세요.'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const submitted = currentSelection.current;
      const option = duplicate ?? (await onAdd(group, normalizedName, submitted.target));
      if (!option) {
        setStatus(t('등록 결과를 확인해야 합니다. 입력한 이름은 보존했습니다.'));
        return;
      }
      const latest = currentSelection.current;
      const sameTarget =
        latest.group === submitted.group &&
        latest.fieldLabel === submitted.fieldLabel &&
        latest.target.recordId === submitted.target.recordId &&
        latest.target.sectionId === submitted.target.sectionId &&
        latest.target.targetId === submitted.target.targetId;
      if (sameTarget && latest.value === submitted.value) {
        onChange(option.code);
        setStatus(
          duplicate
            ? t('이미 등록된 공용 선택지를 선택했습니다.')
            : t('공용 선택지를 등록하고 선택했습니다.'),
        );
      } else {
        setStatus(
          t(
            '공용 선택지를 등록했습니다. 필드 값이 변경되어 자동으로 선택하지 않았습니다. 목록에서 확인해 주세요.',
          ),
        );
      }
      setName('');
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('공용 선택지를 등록하지 못했습니다.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="installation-code-option-control">
      <label className="installation-code-option-search" htmlFor={`${id}-search`}>
        {t('선택지 검색')}
        <input
          id={`${id}-search`}
          type="search"
          value={search}
          maxLength={80}
          disabled={disabled || loading || Boolean(optionsError)}
          placeholder={t('선택지 이름 검색')}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <InstallationFieldInput
        id={id}
        fieldKey={group}
        initialValue={displayValue}
        value={value}
        selectedValue={optionValueForSelection}
        preservedLabel={displayValue}
        selectOptions={optionsForGroup}
        disabled={disabled || loading || Boolean(optionsError)}
        onChange={onChange}
      />
      {optionsError ? (
        <div className="installation-code-option-load-error" role="status">
          <small className="installation-field-error">{t(optionsError)}</small>
          <button type="button" className="text-button" onClick={onRetryOptions}>
            {t('다시 불러오기')}
          </button>
        </div>
      ) : loading ? (
        <small className="installation-code-option-hint" role="status">
          {t('공용 선택지를 불러오고 있습니다.')}
        </small>
      ) : null}
      {canAddSharedOptions ? (
        <div className="installation-code-option-actions">
          <button
            type="button"
            className="text-button"
            aria-expanded={open}
            aria-controls={`${id}-add-shared`}
            disabled={disabled}
            onClick={() => {
              setOpen((current) => !current);
              setError('');
              setStatus('');
            }}
          >
            {open ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            {t(open ? '추가 닫기' : '공용 선택지 추가')}
          </button>
        </div>
      ) : (
        <small className="installation-code-option-hint" role="note">
          {t('공용 선택지를 추가하려면 관리자 권한이 필요합니다.')}
        </small>
      )}
      {open && (
        <div className="installation-code-option-add" id={`${id}-add-shared`}>
          <p>
            {t(
              '이 선택지는 같은 공통 코드 그룹의 모든 설치 기록에서 사용할 수 있습니다. 등록 후 이 기록의 수정을 취소해도 공용 선택지는 유지됩니다.',
            )}
          </p>
          <label htmlFor={`${id}-shared-name`}>{t('{0} 공용 선택지 이름', [t(fieldLabel)])}</label>
          <input
            id={`${id}-shared-name`}
            value={name}
            maxLength={80}
            disabled={busy || disabled || Boolean(registration)}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-shared-hint`}
            onChange={(event) => {
              setName(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <small id={`${id}-shared-hint`}>
            {t(
              '기록 저장과 공용 선택지 등록은 별도 작업입니다. 민감정보, 계정, 주소, URL, 메모는 등록할 수 없습니다.',
            )}
          </small>
          {error && (
            <p className="installation-field-error" role="alert">
              {t(error)}
            </p>
          )}
          {status && (
            <p className="installation-code-option-status" role="status">
              {t(status)}
            </p>
          )}
          {registration && (
            <div className="installation-code-option-registration" role="status">
              <p>{t(registration.message || '공용 선택지 등록 결과를 확인해야 합니다.')}</p>
              {canApplyRegistration && registration.option ? (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    onChange(registration.option!.code);
                    onDismissRegistration(registration.id, currentTarget);
                  }}
                >
                  {t('등록된 선택지를 이 항목에 선택')}
                </button>
              ) : null}
              {registration.state === 'found' && !canApplyRegistration && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onDismissRegistration(registration.id, currentTarget)}
                >
                  {t('확인 완료')}
                </button>
              )}
            </div>
          )}
          <div className="installation-code-option-add-actions">
            <button
              type="button"
              className="button"
              disabled={
                busy ||
                disabled ||
                loading ||
                Boolean(optionsError) ||
                !normalizedName ||
                Boolean(registration)
              }
              onClick={() => void submit()}
            >
              {busy ? t('등록 중…') : registration ? t('등록 확인 대기') : t('공용 선택지 추가')}
            </button>
            <button type="button" className="text-button" disabled={busy} onClick={() => setOpen(false)}>
              {t('닫기')}
            </button>
          </div>
        </div>
      )}
      {status && !open && (
        <small className="installation-code-option-status" role="status">
          {status}
        </small>
      )}
    </div>
  );
}
