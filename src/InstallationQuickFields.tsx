import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { t } from './i18n';
import type { Company } from './types';
import type { InstallationBasicDraft, installationBasicErrors } from './installation-editor';
import { installationInputDefinition } from './installation-editor';
import { focusInstallationField } from './installation-scroll';
import InstallationProtectedInput from './InstallationProtectedInput';
import './installation-editor.css';

type Props = {
  draft: InstallationBasicDraft;
  original: InstallationBasicDraft;
  companies: Company[];
  versions: string[];
  manual: boolean;
  companyRequired: boolean;
  disabled: boolean;
  errors: ReturnType<typeof installationBasicErrors>;
  onManual: (manual: boolean) => void;
  onChange: (patch: InstallationBasicDraft) => void;
};
export default function InstallationQuickFields({
  draft,
  original,
  companies,
  versions,
  manual,
  companyRequired,
  disabled,
  errors,
  onManual,
  onChange,
}: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [extraOpen, setExtraOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const directName = useRef(draft.companyName || '');
  const selectedCompany = useRef(draft.companyId || '');
  const matches = companies.filter(
    (company) =>
      company.id === draft.companyId ||
      company.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const protectedValue = (value: string | null | undefined) =>
    /^(?:[•●*]{3,}|보호됨|\[보호됨\])$/u.test(value || '');
  useEffect(() => {
    if (errors.domain) setExtraOpen(true);
  }, [errors]);
  useLayoutEffect(() => {
    if (!Object.keys(errors).length || (errors.domain && !extraOpen)) return;
    focusInstallationField(root.current?.querySelector<HTMLElement>('[aria-invalid="true"]'));
  }, [errors, extraOpen]);
  const switchCompany = (next: boolean) => {
    if (next === manual) return;
    if (manual) directName.current = draft.companyName || '';
    else selectedCompany.current = draft.companyId || '';
    onManual(next);
    onChange({ companyId: next ? '' : selectedCompany.current, companyName: next ? directName.current : '' });
  };
  const field = (
    key: Exclude<keyof InstallationBasicDraft, 'autoUpdate'>,
    label: string,
    type = 'text',
    placeholder = '',
    maxLength = 200,
  ) => (
    <div className="installation-quick-field">
      <label htmlFor={id + '-input-' + key}>
        {t(label)}
        {key === 'systemCode' && <em> *</em>}
      </label>
      {protectedValue(original[key]) ? (
        <InstallationProtectedInput
          id={id + '-input-' + key}
          fieldKey={key}
          value={draft[key] === original[key] ? '' : String(draft[key] ?? '')}
          touched={draft[key] !== original[key]}
          disabled={disabled}
          maxLength={maxLength}
          invalid={Boolean(errors[key])}
          describedBy={errors[key] ? id + '-error-' + key : undefined}
          onChange={(value) => onChange({ [key]: value })}
          onReset={() => onChange({ [key]: original[key] })}
        />
      ) : (
        <input
          id={id + '-input-' + key}
          name={key}
          type={type === 'date' ? installationInputDefinition(key, String(original[key] ?? '')).type : type}
          value={String(draft[key] ?? '')}
          maxLength={maxLength}
          required={key === 'systemCode'}
          placeholder={t(placeholder)}
          aria-invalid={Boolean(errors[key])}
          aria-describedby={errors[key] ? id + '-error-' + key : undefined}
          onInput={type === 'date' ? (event) => onChange({ [key]: event.currentTarget.value }) : undefined}
          onChange={(event) => onChange({ [key]: event.target.value })}
        />
      )}
      {errors[key] && (
        <small id={id + '-error-' + key} className="installation-field-error">
          {t(errors[key])}
        </small>
      )}
    </div>
  );
  return (
    <div className="installation-quick-fields" ref={root}>
      <fieldset disabled={disabled}>
        <legend>{t('기본 정보')}</legend>
        <div className="installation-quick-grid">
          <div className="installation-quick-field is-wide">
            <label htmlFor={id + '-company'}>
              {t('고객사')}
              {companyRequired && <em> *</em>}
            </label>
            <div className="installation-value-modes" role="group" aria-label={t('고객사 입력 방식')}>
              <button type="button" aria-pressed={!manual} onClick={() => switchCompany(false)}>
                {t('기존 고객사 선택')}
              </button>
              <button type="button" aria-pressed={manual} onClick={() => switchCompany(true)}>
                {t('이름 직접 입력')}
              </button>
            </div>
            {manual ? (
              <input
                id={id + '-company'}
                name="companyName"
                required={companyRequired}
                maxLength={150}
                value={draft.companyName || ''}
                placeholder={t('고객사명을 입력하세요')}
                aria-invalid={Boolean(errors.companyName)}
                aria-describedby={id + '-company-hint'}
                onChange={(event) => onChange({ companyName: event.target.value, companyId: '' })}
              />
            ) : (
              <div className="installation-customer-picker">
                <label className="installation-customer-search">
                  <Search size={16} aria-hidden="true" />
                  <input
                    type="search"
                    value={query}
                    placeholder={t('고객사 이름으로 검색')}
                    aria-label={t('고객사 이름으로 검색')}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.preventDefault();
                    }}
                  />
                </label>
                <select
                  id={id + '-company'}
                  name="companyId"
                  value={draft.companyId || ''}
                  required={companyRequired}
                  aria-invalid={Boolean(errors.companyName)}
                  aria-describedby={id + '-company-hint'}
                  onChange={(event) => onChange({ companyId: event.target.value, companyName: '' })}
                >
                  <option value="">{t(companyRequired ? '고객사를 선택하세요' : '고객사 연결 없음')}</option>
                  {draft.companyId && !companies.some((company) => company.id === draft.companyId) && (
                    <option value={draft.companyId}>{t('현재 연결된 고객사')}</option>
                  )}
                  {matches.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <small id={id + '-company-hint'} className={errors.companyName ? 'installation-field-error' : ''}>
              {errors.companyName
                ? t(errors.companyName)
                : t(
                    manual
                      ? '고객사 관리에 등록하지 않고 설치 정보에만 저장합니다.'
                      : '등록된 고객사를 검색해 연결합니다.',
                  )}
            </small>
          </div>
          {field('systemCode', '시스템 코드', 'text', '예: YETA-CLOUD-001', 80)}
          <label className="installation-quick-field">
            <span>{t('서비스')}</span>
            <select
              name="serviceVersion"
              value={draft.serviceVersion || ''}
              onChange={(event) => onChange({ serviceVersion: event.target.value })}
            >
              {!versions.includes(draft.serviceVersion || '') && (
                <option value={draft.serviceVersion || ''}>{draft.serviceVersion || t('미등록')}</option>
              )}
              {versions.map((version) => (
                <option key={version} value={version}>
                  {t(version)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>
          {t('설치 이력')} <small>{t('선택 입력')}</small>
        </legend>
        <div className="installation-quick-grid">
          {field('version', '설치 버전', 'text', '예: 2026.1.0', 80)}
          {field('engineer', '담당 엔지니어', 'text', '', 100)}
          {field('installedAt', '최초 설치일', 'date')}
          {field('patchedAt', '최근 패치일', 'date')}
        </div>
      </fieldset>
      <details
        className="installation-quick-extra"
        open={extraOpen}
        onToggle={(event) => setExtraOpen(event.currentTarget.open)}
      >
        <summary>
          <ChevronRight size={16} aria-hidden="true" />
          {t('운영 정보')}
          <small>{t('선택 입력')}</small>
        </summary>
        <fieldset disabled={disabled}>
          <div className="installation-quick-grid">
            <label className="installation-quick-field">
              <span>{t('접근 방식')}</span>
              <select
                name="accessType"
                value={draft.accessType || '알 수 없음'}
                onChange={(event) => onChange({ accessType: event.target.value })}
              >
                {draft.accessType &&
                  !['알 수 없음', '바로 접근', '원격', '불가', 'VPN/VDI'].includes(draft.accessType) && (
                    <option value={draft.accessType}>{draft.accessType}</option>
                  )}
                {['알 수 없음', '바로 접근', '원격', '불가', 'VPN/VDI'].map((value) => (
                  <option key={value} value={value}>
                    {t(value)}
                  </option>
                ))}
              </select>
            </label>
            <label className="installation-quick-field">
              <span>{t('자동 업데이트')}</span>
              <span className="m-checkbox">
                <input
                  name="autoUpdate"
                  type="checkbox"
                  checked={Boolean(draft.autoUpdate)}
                  onChange={(event) => onChange({ autoUpdate: event.target.checked })}
                />
                {t('자동 업데이트 사용')}
              </span>
            </label>
            <div className="is-wide">
              {field('domain', '서비스 도메인', 'text', '예: service.example.com', 253)}
            </div>
          </div>
        </fieldset>
      </details>
    </div>
  );
}
