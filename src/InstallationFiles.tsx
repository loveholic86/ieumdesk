import { t } from './i18n';
import { useLocale } from './use-locale';
import { useEffect, useId, useRef, useState } from 'react';
import { Download, FileCode2 } from 'lucide-react';
import { downloadInstallationFile } from './installation-api';

import type { InstallationDetailRow } from './installation-types';
import {
  installationConfigurationDraft,
  installationConfigurationScopes,
  normalizeInstallationConfiguration,
} from './installation-configuration';

type Props = {
  installationId: string;
  systemCode: string;
  configurationRows: InstallationDetailRow[];
  policyKey: string;
  policyPending: boolean;
  protectionEnabled: boolean;
  canManage: boolean;
};

export default function InstallationFiles({
  installationId,
  systemCode,
  configurationRows,
  policyKey,
  policyPending,
  protectionEnabled,
  canManage,
}: Props) {
  useLocale();
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');
  const defaults = JSON.stringify(installationConfigurationDraft(systemCode, configurationRows));
  const [config, setConfig] = useState(() => installationConfigurationDraft(systemCode, configurationRows));
  const configId = useId();
  const configScopes = installationConfigurationScopes(configurationRows);
  const generation = useRef(0);
  const active = useRef({ installationId, policyKey, policyPending, protectionEnabled });
  active.current = { installationId, policyKey, policyPending, protectionEnabled };
  const request = useRef<AbortController | null>(null);
  const base = `/records/installations/${encodeURIComponent(installationId)}`;

  useEffect(() => {
    ++generation.current;
    request.current?.abort();
    setBusy('');
    setError('');
    setStatus('');
    // Re-fetching identical rows (including on window focus) must preserve entered values.
    setConfig(JSON.parse(defaults));
    return () => {
      ++generation.current;
      request.current?.abort();
    };
  }, [installationId, policyKey, systemCode, defaults]);

  const run = async (
    name: string,
    operation: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) => {
    if (busy || policyPending) return;
    const token = ++generation.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const current = () =>
      generation.current === token &&
      active.current.installationId === installationId &&
      active.current.policyKey === policyKey;
    setBusy(name);
    setError('');
    setStatus('');
    try {
      await operation(controller.signal, current);
    } catch (reason) {
      if (current() && !controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.');
    } finally {
      if (generation.current === token) {
        setBusy('');
        request.current = null;
      }
    }
  };
  const canDownload = canManage && !policyPending && !protectionEnabled;

  return (
    <div className="installation-file-tools">
      <section className="installation-data-card">
        <header className="installation-card-heading">
          <span className="installation-small-icon">
            <FileCode2 size={17} />
          </span>
          <h3>{t('설정 파일 생성')}</h3>
        </header>
        <form
          className="installation-config-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canDownload || !canManage) return;
            void run('configuration', async (signal, current) => {
              const values = normalizeInstallationConfiguration(config);
              const downloaded = await downloadInstallationFile(
                `${base}/configuration`,
                'yeta-configuration.yts',
                { method: 'POST', body: JSON.stringify(values), signal },
                () => current() && !active.current.policyPending && !active.current.protectionEnabled,
              );
              if (current())
                setStatus(
                  downloaded
                    ? '설정 파일을 생성했습니다. 브라우저 다운로드를 확인하세요.'
                    : '보호 설정이 변경되거나 확인 중이어서 다운로드를 중단했습니다. 다시 시도해 주세요.',
                );
            });
          }}
        >
          <p>{t('선택·입력한 값으로 고객 서버에 적용할 .yts 설정 파일을 만듭니다.')}</p>
          <div className="installation-config-controls">
            <label>
              {t('시스템 코드')}
              <input
                value={config.system_code}
                maxLength={80}
                required
                list={`${configId}-systems`}
                onChange={(event) =>
                  setConfig(
                    installationConfigurationDraft(event.target.value, configurationRows, config.att_year),
                  )
                }
                disabled={Boolean(busy) || !canManage}
              />
              <datalist id={`${configId}-systems`}>
                {[...new Set([systemCode, ...configScopes.map((scope) => scope.system)])]
                  .filter(Boolean)
                  .map((system) => (
                    <option key={system} value={system} />
                  ))}
              </datalist>
            </label>
            <label>
              {t('귀속 연도')}
              <input
                value={config.att_year}
                maxLength={4}
                inputMode="numeric"
                required
                list={`${configId}-years`}
                onChange={(event) =>
                  setConfig(
                    installationConfigurationDraft(config.system_code, configurationRows, event.target.value),
                  )
                }
                disabled={Boolean(busy) || !canManage}
              />
              <datalist id={`${configId}-years`}>
                {[
                  ...new Set(
                    configScopes
                      .filter((scope) => scope.system === config.system_code)
                      .map((scope) => scope.year),
                  ),
                ]
                  .sort()
                  .reverse()
                  .map((year) => (
                    <option key={year} value={year} />
                  ))}
              </datalist>
            </label>
            <label>
              {t('YETA 사용 유형')}
              <select
                value={config.yeta_use_type}
                required
                disabled={Boolean(busy) || !canManage}
                onChange={(event) => setConfig({ ...config, yeta_use_type: event.target.value })}
              >
                <option value="">{t('선택')}</option>
                <option value="1">{t('일반')}</option>
                <option value="0">{t('중도퇴사자')}</option>
              </select>
            </label>
            <label>
              {t('최대 사용 인원')}
              <input
                value={config.system_max_user_count}
                inputMode="numeric"
                required
                maxLength={20}
                onChange={(event) => setConfig({ ...config, system_max_user_count: event.target.value })}
                disabled={Boolean(busy) || !canManage}
              />
            </label>
            <label>
              {t('최대 회사 수')}
              <input
                value={config.system_max_company_count}
                inputMode="numeric"
                required
                maxLength={20}
                onChange={(event) => setConfig({ ...config, system_max_company_count: event.target.value })}
                disabled={Boolean(busy) || !canManage}
              />
            </label>
            <label className="installation-config-boolean">
              <input
                type="checkbox"
                aria-label={t('간이지급명세서 사용')}
                checked={config.simplepay_use === 'Y'}
                ref={(element) => {
                  if (element) element.indeterminate = !['Y', 'N'].includes(config.simplepay_use);
                }}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    simplepay_use: event.target.checked ? 'Y' : 'N',
                    simplepay_use_cnt: event.target.checked ? config.simplepay_use_cnt : '0',
                  })
                }
                disabled={Boolean(busy) || !canManage}
              />
              {t('간이지급명세서 사용')}
              <span aria-hidden="true">
                {t(
                  config.simplepay_use === 'Y'
                    ? '사용'
                    : config.simplepay_use === 'N'
                      ? '미사용'
                      : '선택 필요',
                )}
              </span>
            </label>
            <label>
              {t('간이지급명세서 사용 인원')}
              <input
                value={config.simplepay_use_cnt}
                inputMode="numeric"
                required
                maxLength={20}
                onChange={(event) => setConfig({ ...config, simplepay_use_cnt: event.target.value })}
                disabled={Boolean(busy) || !canManage || config.simplepay_use !== 'Y'}
              />
            </label>
          </div>
          <div className="installation-config-actions">
            <button
              type="submit"
              className="button primary"
              disabled={!canDownload || !canManage || Boolean(busy)}
            >
              <Download size={15} />
              {busy === 'configuration' ? t('생성 중…') : t('생성·다운로드')}
            </button>
          </div>
          {!canDownload && (
            <p className="installation-edit-hint">
              {policyPending
                ? t('보호 설정을 확인하고 있습니다.')
                : t('보호 기능이 꺼져 있으면 관리자와 담당자가 파일을 다운로드할 수 있습니다.')}
            </p>
          )}
        </form>
      </section>
      {error && (
        <p className="installation-action-error" role="alert">
          {t(error)}
        </p>
      )}
      {status && (
        <p className="installation-action-status" role="status">
          {t(status)}
        </p>
      )}
    </div>
  );
}
