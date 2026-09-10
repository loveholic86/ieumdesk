import { t, getLocaleTag } from './i18n';
import { useLocale } from './use-locale';
import { useEffect, useState } from 'react';
import { Check, History, LayoutGrid, RefreshCw, Settings2, ShieldCheck, Type } from 'lucide-react';
import { api } from './api';
import { useWorkspaceSettings } from './workspace-settings';
import {
  menuDefinitions,
  workspaceNameMaxLength,
  validWorkspaceName,
  type WorkspaceAudit,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from './workspace-types';
import './settings.css';
import { ProductCatalogPage, CodeCatalogPage } from './CatalogPage';
import ArchivedPage from './ArchivedPage';
import BackupPage from './BackupPage';

export default function SettingsPage({
  notify,
  onRefresh = () => {},
}: {
  notify?: (text: string, error?: boolean) => void;
  onRefresh?: () => void;
}) {
  useLocale();
  const { settings, loading, refreshing, error, refresh, save } = useWorkspaceSettings();
  const [draft, setDraft] = useState<WorkspaceSettings | null>(settings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'preferences' | 'audit' | 'products' | 'codes' | 'archive' | 'backups'>(
    'preferences',
  );
  const [audits, setAudits] = useState<WorkspaceAudit[]>([]);
  const [auditError, setAuditError] = useState('');
  const loadAudits = async () => {
    try {
      const value = await api<{ items: WorkspaceAudit[] }>('/settings/audit');
      setAudits(value.items);
      setAuditError('');
    } catch (reason) {
      setAuditError((reason as Error).message);
    }
  };
  useEffect(() => {
    if (settings && !dirty) setDraft(settings);
  }, [settings, dirty]);
  useEffect(() => {
    if (tab === 'audit') void loadAudits();
  }, [tab]);
  const change = (next: WorkspaceSettings) => {
    setDraft(next);
    setDirty(true);
    setMessage('');
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !settings) return;
    const brandName = draft.brandName.trim();
    const workspaceName = draft.workspaceName.trim();
    if (!validWorkspaceName(brandName) || !validWorkspaceName(workspaceName)) {
      setMessage('표시 이름은 공백 없이 시작하고 끝나는 1~60자의 한 줄 문구로 입력해 주세요.');
      setFailed(true);
      return;
    }
    setSaving(true);
    setMessage('');
    setFailed(false);
    const patch: WorkspaceSettingsPatch = { revision: draft.revision };
    if (brandName !== settings.brandName) patch.brandName = brandName;
    if (workspaceName !== settings.workspaceName) patch.workspaceName = workspaceName;
    if (draft.protectionEnabled !== settings.protectionEnabled)
      patch.protectionEnabled = draft.protectionEnabled;
    const menus = Object.fromEntries(
      menuDefinitions
        .filter(([key]) => draft.menus[key] !== settings.menus[key])
        .map(([key]) => [key, draft.menus[key]]),
    );
    if (Object.keys(menus).length) patch.menus = menus;
    if (
      patch.brandName === undefined &&
      patch.workspaceName === undefined &&
      patch.protectionEnabled === undefined &&
      !patch.menus
    ) {
      setDirty(false);
      setSaving(false);
      return;
    }
    try {
      const value = await save(patch);
      setDraft(value);
      setDirty(false);
      setMessage('환경설정을 저장했습니다. 변경한 설정이 전체 CRM에 적용됩니다.');
    } catch (reason) {
      setMessage((reason as Error).message);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="settings-page">
      <header className="settings-heading">
        <div className="settings-mark">
          <Settings2 size={25} />
        </div>
        <div>
          <div className="eyebrow">WORKSPACE SETTINGS</div>
          <h1>{t('환경설정')}</h1>
          <p>{t('정보 표시와 메뉴 구성을 관리합니다. 설정은 전체 사용자에게 공통 적용됩니다.')}</p>
        </div>
      </header>
      <div className="settings-tabs" role="tablist" aria-label={t('환경설정 구분')}>
        <button role="tab" aria-selected={tab === 'preferences'} onClick={() => setTab('preferences')}>
          <Settings2 size={17} />
          {t('표시 및 메뉴')}
        </button>
        <button role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>
          <History size={17} />
          {t('변경 이력')}
        </button>
        <button role="tab" aria-selected={tab === 'products'} onClick={() => setTab('products')}>
          {t('견적 상품')}
        </button>
        <button role="tab" aria-selected={tab === 'codes'} onClick={() => setTab('codes')}>
          {t('코드 관리')}
        </button>
        <button role="tab" aria-selected={tab === 'archive'} onClick={() => setTab('archive')}>
          {t('휴지통')}
        </button>
        <button role="tab" aria-selected={tab === 'backups'} onClick={() => setTab('backups')}>
          {t('백업 관리')}
        </button>
      </div>
      {(loading || !draft) && !error ? (
        <div className="empty" role="status">
          {t('환경설정을 불러오는 중입니다…')}
        </div>
      ) : null}
      {error && (
        <div className="error-box" role="alert">
          {t(error)}
          <button className="text-button" onClick={() => void refresh().catch(() => {})}>
            {t('다시 불러오기')}
          </button>
        </div>
      )}
      {tab === 'preferences' && draft && (
        <form onSubmit={submit} className="settings-form">
          <section className="settings-card">
            <div className="settings-card-title">
              <Type size={21} />
              <div>
                <h2>{t('화면 표시 이름')}</h2>
                <p>
                  {t(
                    '좌측 상단의 브랜드명과 워크스페이스명을 설정합니다. 저장하면 전체 사용자에게 적용됩니다.',
                  )}
                </p>
              </div>
            </div>
            <div className="settings-branding-fields">
              <label className="field" htmlFor="settings-brand-name">
                <span>{t('브랜드명')}</span>
                <input
                  id="settings-brand-name"
                  value={draft.brandName}
                  maxLength={workspaceNameMaxLength}
                  required
                  disabled={saving}
                  onChange={(event) => change({ ...draft, brandName: event.target.value })}
                />
              </label>
              <label className="field" htmlFor="settings-workspace-name">
                <span>{t('워크스페이스명')}</span>
                <input
                  id="settings-workspace-name"
                  value={draft.workspaceName}
                  maxLength={workspaceNameMaxLength}
                  required
                  disabled={saving}
                  onChange={(event) => change({ ...draft, workspaceName: event.target.value })}
                />
              </label>
            </div>
            <p className="settings-hint">
              {t('각 이름은 최대 60자이며, 입력한 문구는 한국어·영어 화면에서 동일하게 표시됩니다.')}
            </p>
          </section>
          <section className="settings-card">
            <div className="settings-card-title">
              <ShieldCheck size={21} />
              <div>
                <h2>{t('보호 정보')}</h2>
                <p>{t('접속정보·계정·비밀번호처럼 보호되는 값의 표시 방식을 선택합니다.')}</p>
              </div>
            </div>
            <fieldset className="protection-choices">
              <legend className="sr-only">{t('보호 기능')}</legend>
              <label className={draft.protectionEnabled ? 'selected' : ''}>
                <input
                  type="radio"
                  name="protection"
                  aria-label={t('보호 기능 활성화')}
                  checked={draft.protectionEnabled}
                  onChange={() => change({ ...draft, protectionEnabled: true })}
                />
                <span>
                  <strong>{t('활성화')}</strong>
                  <small>{t('민감정보를 ‘보호됨’으로 가립니다.')}</small>
                </span>
              </label>
              <label className={!draft.protectionEnabled ? 'selected' : ''}>
                <input
                  type="radio"
                  name="protection"
                  aria-label={t('보호 기능 비활성화')}
                  checked={!draft.protectionEnabled}
                  onChange={() => change({ ...draft, protectionEnabled: false })}
                />
                <span>
                  <strong>{t('비활성화')}</strong>
                  <small>
                    {t('관리자만 보호 정보 원문을 볼 수 있습니다. 담당자·조회 전용 계정은 계속 보호됩니다.')}
                  </small>
                </span>
              </label>
            </fieldset>
            <p className="settings-hint">
              {t(
                '선택 후 아래 ‘설정 저장’을 누르면 적용됩니다. 개별 상세창에서 별도로 열람할 필요가 없습니다.',
              )}
            </p>
          </section>
          <section className="settings-card">
            <div className="settings-card-title">
              <LayoutGrid size={21} />
              <div>
                <h2>{t('좌측 메뉴')}</h2>
                <p>{t('사용할 대메뉴를 선택하세요. 비활성화해도 등록된 자료와 고객사 연결은 유지됩니다.')}</p>
              </div>
            </div>
            <div className="menu-setting-list">
              {menuDefinitions.map(([key, label]) => (
                <label key={key} className="menu-setting-row">
                  <span>{t(label)}</span>
                  <span className="settings-toggle">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t('{0} 활성화', [t(label)])}
                      checked={draft.menus[key]}
                      onChange={(event) =>
                        change({ ...draft, menus: { ...draft.menus, [key]: event.target.checked } })
                      }
                    />
                    <i aria-hidden="true" />
                    <small>{draft.menus[key] ? t('활성화') : t('비활성화')}</small>
                  </span>
                </label>
              ))}
            </div>
            <p className="settings-hint">
              {t('내 계정과 환경설정은 항상 표시됩니다. 사용자 및 권한·환경설정은 관리자에게만 표시됩니다.')}
            </p>
          </section>
          {dirty && settings && draft.revision !== settings.revision && (
            <div className="error-box" role="alert">
              {t('다른 곳에서 환경설정이 변경되었습니다. 최신 설정을 불러온 뒤 다시 선택해 주세요.')}
            </div>
          )}
          {message && (
            <div className={failed ? 'error-box' : 'settings-success'} role={failed ? 'alert' : 'status'}>
              {!failed && <Check size={17} />} {t(message)}
            </div>
          )}
          <footer className="settings-actions">
            <span>{dirty ? t('저장하지 않은 변경 사항이 있습니다.') : t('모든 설정이 저장되었습니다.')}</span>
            <button
              type="button"
              className="button secondary"
              disabled={saving}
              onClick={async () => {
                setDirty(false);
                setMessage('');
                await refresh().catch(() => {});
              }}
            >
              <RefreshCw size={16} />
              {t('다시 불러오기')}
            </button>
            <button className="button primary" disabled={!dirty || saving || loading || refreshing}>
              {saving ? t('저장 중…') : t('설정 저장')}
            </button>
          </footer>
        </form>
      )}
      {tab === 'audit' && (
        <section className="settings-card">
          <div className="settings-card-title">
            <History size={21} />
            <div>
              <h2>{t('최근 변경 이력')}</h2>
              <p>
                {t('설정과 업무 변경 요청의 결과를 확인합니다. 비밀번호와 입력한 본문은 기록하지 않습니다.')}
              </p>
            </div>
            <button className="button secondary" onClick={() => void loadAudits()}>
              <RefreshCw size={16} />
              {t('새로고침')}
            </button>
          </div>
          {auditError && (
            <div className="error-box" role="alert">
              {t(auditError)}
            </div>
          )}
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>{t('일시')}</th>
                  <th>{t('사용자')}</th>
                  <th>{t('구분')}</th>
                  <th>{t('동작')}</th>
                  <th>{t('결과')}</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.createdAt).toLocaleString(getLocaleTag())}</td>
                    <td>{row.actorName}</td>
                    <td>{row.area}</td>
                    <td>{row.action}</td>
                    <td>{row.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!audits.length && !auditError && (
              <p className="settings-hint">{t('등록된 변경 이력이 없습니다.')}</p>
            )}
          </div>
        </section>
      )}
      {tab === 'products' && <ProductCatalogPage notify={notify} />}
      {tab === 'codes' && <CodeCatalogPage notify={notify} />}
      {tab === 'archive' && <ArchivedPage notify={notify ?? (() => {})} onRefresh={onRefresh} />}
      {tab === 'backups' && <BackupPage />}
    </section>
  );
}
