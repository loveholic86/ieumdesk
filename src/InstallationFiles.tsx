import { t, getLocaleTag } from './i18n';
import { useLocale } from './use-locale';
import { useEffect, useRef, useState } from 'react';
import { Download, File, FileCode2, Paperclip, RefreshCw, Trash2, Upload } from 'lucide-react';
import { downloadInstallationFile, fileBase64, installationRequest } from './installation-api';

type Attachment = { id: string; name: string; mime: string; size: number; createdAt: string };
type AttachmentList = {
  items: Attachment[];
  maxBytes: number;
  allowedExtensions: string[];
  downloadsEnabled: boolean;
};
type Props = {
  installationId: string;
  systemCode: string;
  policyKey: string;
  policyPending: boolean;
  protectionEnabled: boolean;
  canManage: boolean;
};
const sizeLabel = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / (1024 * 1024)).toFixed(1)} MB`;

export default function InstallationFiles({
  installationId,
  systemCode,
  policyKey,
  policyPending,
  protectionEnabled,
  canManage,
}: Props) {
  useLocale();
  const [data, setData] = useState<AttachmentList | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<File | null>(null);
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const [configSystem, setConfigSystem] = useState(systemCode);
  const [configYear, setConfigYear] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const generation = useRef(0);
  const active = useRef({ installationId, policyKey, policyPending, protectionEnabled });
  active.current = { installationId, policyKey, policyPending, protectionEnabled };
  const request = useRef<AbortController | null>(null);
  const base = `/records/installations/${encodeURIComponent(installationId)}`;

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError('');
    void installationRequest<AttachmentList>(`${base}/attachments`, { signal: controller.signal })
      .then((result) => {
        if (
          !Array.isArray(result.items) ||
          !Number.isSafeInteger(result.maxBytes) ||
          result.maxBytes <= 0 ||
          !Array.isArray(result.allowedExtensions) ||
          typeof result.downloadsEnabled !== 'boolean' ||
          result.items.some(
            (item) =>
              typeof item.id !== 'string' || typeof item.name !== 'string' || !Number.isFinite(item.size),
          )
        )
          throw new Error('첨부파일 목록을 확인하지 못했습니다. 다시 불러와 주세요.');
        if (current) setData(result);
      })
      .catch((reason) => {
        if (current && !controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '첨부파일 목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [base, policyKey, retry]);

  useEffect(() => {
    ++generation.current;
    request.current?.abort();
    setBusy('');
    setSelected(null);
    setDeleting(null);
    setStatus('');
    setConfigSystem(systemCode);
    setConfigYear('');
    if (input.current) input.current.value = '';
    return () => {
      ++generation.current;
      request.current?.abort();
    };
  }, [installationId, policyKey, systemCode]);

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
  const canDownload = !policyPending && !protectionEnabled && data?.downloadsEnabled === true;
  const chooseFile = (file: File | null) => {
    setError('');
    setSelected(null);
    if (!file || !data) return;
    const extension = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : '';
    if (!file.size || file.size > data.maxBytes) {
      setError(`빈 파일은 등록할 수 없으며, 파일 크기는 ${sizeLabel(data.maxBytes)} 이하여야 합니다.`);
      if (input.current) input.current.value = '';
      return;
    }
    const allowed = data.allowedExtensions.map((value) =>
      value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`,
    );
    if (!allowed.includes(extension)) {
      setError('허용된 형식의 파일을 선택해 주세요.');
      if (input.current) input.current.value = '';
      return;
    }
    setSelected(file);
  };

  return (
    <div className="installation-file-tools">
      <section className="installation-data-card">
        <header className="installation-card-heading">
          <span className="installation-small-icon">
            <FileCode2 size={17} />
          </span>
          <h3>{t('설정 파일 생성')}</h3>
        </header>
        <div className="installation-config-form">
          <p>
            {t(
              '저장된 설정 키와 값으로 Java .properties 파일을 만듭니다. 필요한 시스템과 연도를 지정하세요.',
            )}
          </p>
          <div className="installation-config-controls">
            <label>
              {t('시스템 코드')}
              <input
                value={configSystem}
                maxLength={80}
                placeholder={t('전체 시스템')}
                onChange={(event) => setConfigSystem(event.target.value)}
                disabled={Boolean(busy)}
              />
            </label>
            <label>
              {t('귀속 연도')}
              <input
                value={configYear}
                maxLength={4}
                inputMode="numeric"
                placeholder={t('전체 연도')}
                onChange={(event) => setConfigYear(event.target.value)}
                disabled={Boolean(busy)}
              />
            </label>
            <button
              type="button"
              className="button primary"
              disabled={!canDownload || Boolean(busy)}
              onClick={() =>
                void run('configuration', async (signal, current) => {
                  if (configYear && !/^(19|20|21)\d{2}$/.test(configYear))
                    throw new Error('귀속 연도를 네 자리 숫자로 입력해 주세요.');
                  const downloaded = await downloadInstallationFile(
                    `${base}/configuration`,
                    'installation.properties',
                    {
                      method: 'POST',
                      body: JSON.stringify({
                        ...(configSystem.trim() ? { systemCode: configSystem.trim() } : {}),
                        ...(configYear ? { year: configYear } : {}),
                      }),
                      signal,
                    },
                    () => current() && !active.current.policyPending && !active.current.protectionEnabled,
                  );
                  if (current())
                    setStatus(
                      downloaded
                        ? '설정 파일을 생성했습니다. 브라우저 다운로드를 확인하세요.'
                        : '보호 설정이 변경되거나 확인 중이어서 다운로드를 중단했습니다. 다시 시도해 주세요.',
                    );
                })
              }
            >
              <Download size={15} />
              {busy === 'configuration' ? t('생성 중…') : t('생성·다운로드')}
            </button>
          </div>
          {!canDownload && (
            <p className="installation-edit-hint">
              {policyPending
                ? t('보호 설정을 확인하고 있습니다.')
                : t('보호 기능이 꺼져 있는 관리자 계정에서만 파일을 다운로드할 수 있습니다.')}
            </p>
          )}
        </div>
      </section>
      <section className="installation-data-card">
        <header className="installation-card-heading">
          <span className="installation-small-icon">
            <Paperclip size={17} />
          </span>
          <h3>{t('첨부파일')}</h3>
          <span className="installation-count">
            {data?.items.length ?? 0}
            {t('개')}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={t('첨부파일 다시 불러오기')}
            disabled={loading || Boolean(busy)}
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={14} className={loading ? 'auth-spin' : ''} />
          </button>
        </header>
        <div className="installation-attachments-body">
          {canManage && (
            <div className="installation-upload">
              <label className="installation-file-input">
                <Upload size={17} />
                <span>
                  {selected ? `${selected.name} · ${sizeLabel(selected.size)}` : t('첨부할 파일 선택')}
                </span>
                <input
                  ref={input}
                  type="file"
                  accept={data?.allowedExtensions
                    .map((value) => (value.startsWith('.') ? value : `.${value}`))
                    .join(',')}
                  onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                  disabled={!data || Boolean(busy)}
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={!selected || Boolean(busy) || policyPending}
                onClick={() =>
                  void run('upload', async (signal, current) => {
                    if (!selected) return;
                    const contentBase64 = await fileBase64(selected);
                    if (!current() || signal.aborted) return;
                    await installationRequest<Attachment>(`${base}/attachments`, {
                      method: 'POST',
                      body: JSON.stringify({ name: selected.name, contentBase64 }),
                      signal,
                    });
                    if (current()) {
                      setSelected(null);
                      if (input.current) input.current.value = '';
                      setRetry((value) => value + 1);
                      setStatus('첨부파일을 등록했습니다.');
                    }
                  })
                }
              >
                {busy === 'upload' ? t('등록 중…') : t('파일 등록')}
              </button>
              {data && (
                <p>
                  {t('파일당 최대 ')}
                  {sizeLabel(data.maxBytes)} · {data.allowedExtensions.join(', ')}
                </p>
              )}
            </div>
          )}
          {loading && !data ? (
            <p className="installation-row-empty" role="status">
              {t('첨부파일을 불러오고 있습니다.')}
            </p>
          ) : data?.items.length ? (
            <ul className="installation-attachments-list">
              {data.items.map((item) => (
                <li key={item.id}>
                  <File size={19} />
                  <div>
                    <strong>{item.name}</strong>
                    <span>
                      {sizeLabel(item.size)}
                      {item.createdAt && ` · ${new Date(item.createdAt).toLocaleDateString(getLocaleTag())}`}
                    </span>
                  </div>
                  <div className="installation-attachment-actions">
                    <button
                      type="button"
                      className="button"
                      disabled={!canDownload || Boolean(busy)}
                      aria-label={t('{0} 다운로드', [item.name])}
                      onClick={() =>
                        void run(`download:${item.id}`, async (signal, current) => {
                          const downloaded = await downloadInstallationFile(
                            `${base}/attachments/${encodeURIComponent(item.id)}/download`,
                            item.name,
                            { signal },
                            () =>
                              current() && !active.current.policyPending && !active.current.protectionEnabled,
                          );
                          if (current())
                            setStatus(
                              downloaded
                                ? '브라우저 다운로드를 확인하세요.'
                                : '보호 설정이 변경되거나 확인 중이어서 다운로드를 중단했습니다. 다시 시도해 주세요.',
                            );
                        })
                      }
                    >
                      <Download size={14} />
                      <span>{t('다운로드')}</span>
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        className="icon-button danger-text"
                        disabled={Boolean(busy)}
                        aria-label={t('{0} 삭제', [item.name])}
                        onClick={() => setDeleting(item)}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="installation-row-empty">{t('등록된 첨부파일이 없습니다.')}</p>
          )}
          {deleting && (
            <div className="installation-inline-confirm">
              <p>
                <strong>{deleting.name}</strong>
                {t(' 파일을 삭제하시겠습니까?')}
              </p>
              <div>
                <button className="button" disabled={Boolean(busy)} onClick={() => setDeleting(null)}>
                  {t('취소')}
                </button>
                <button
                  className="button danger"
                  disabled={Boolean(busy) || policyPending}
                  onClick={() =>
                    void run(`delete:${deleting.id}`, async (signal, current) => {
                      await installationRequest(`${base}/attachments/${encodeURIComponent(deleting.id)}`, {
                        method: 'DELETE',
                        signal,
                      });
                      if (current()) {
                        setDeleting(null);
                        setRetry((value) => value + 1);
                        setStatus('첨부파일을 삭제했습니다.');
                      }
                    })
                  }
                >
                  {busy.startsWith('delete:') ? t('삭제 중…') : t('파일 삭제')}
                </button>
              </div>
            </div>
          )}
        </div>
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
