import { t, getLocaleTag } from './i18n';
import { useLocale } from './use-locale';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, CheckCircle2, Download, RefreshCw, ShieldCheck } from 'lucide-react';
import type {
  BackupHistory,
  BackupItem,
  BackupOverview,
  BackupPreview,
  BackupSchedule,
} from './backup-types';
import './BackupPage.css';
import { privateFetch, publicErrorMessage } from './client-security';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await privateFetch(`/api/backups${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (response.status === 401 || response.status === 403)
    window.dispatchEvent(new Event(response.status === 401 ? 'crm:unauthorized' : 'crm:permissions-changed'));
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(publicErrorMessage(body, response.status, '백업 작업을 완료하지 못했습니다.'));
  }
  if (!body || typeof body !== 'object') throw new Error('백업 응답을 확인하지 못했습니다.');
  return body as T;
}
const date = (value: string | null) => (value ? new Date(value).toLocaleString(getLocaleTag()) : '—');
const size = (value: number) =>
  value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;
const reasonLabels = { manual: '직접 백업', scheduled: '자동 백업', 'pre-restore': '복원 전 백업' };
const actionLabels: Record<string, string> = {
  create: '백업 생성',
  verify: '무결성 검사',
  download: '백업 다운로드',
  schedule: '자동 백업 설정',
  scheduler: '자동 백업',
  restore: '복원',
};
const blockerLabels: Record<string, string> = {
  BACKUP_SCHEMA_MISMATCH: '백업 시점과 현재 데이터 구조가 다릅니다.',
  BACKUP_EXTERNAL_REFERENCES: '백업 범위 밖의 데이터 연결을 먼저 확인해야 합니다.',
  BACKUP_FOREIGN_KEY_CYCLE: '순환 참조가 있어 별도 복원 절차가 필요합니다.',
};

export function BackupPage() {
  useLocale();
  const [overview, setOverview] = useState<BackupOverview | null>(null),
    [history, setHistory] = useState<BackupHistory[]>([]),
    [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(''),
    [preview, setPreview] = useState<BackupPreview | null>(null),
    [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const downloadRequest = useRef<AbortController | null>(null);
  const load = useCallback(async (resetDraft = false) => {
    const [data, events] = await Promise.all([
      request<BackupOverview>(''),
      request<{ items: BackupHistory[] }>('/history'),
    ]);
    if (
      !Array.isArray(data.items) ||
      !Array.isArray(data.issues) ||
      !data.schedule ||
      typeof data.schedule.enabled !== 'boolean' ||
      !Array.isArray(events.items)
    )
      throw new Error('백업 응답 형식이 올바르지 않습니다.');
    if (mounted.current) {
      setOverview(data);
      setHistory(events.items);
      if (resetDraft) setSchedule(data.schedule);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    load(true)
      .catch((error) => {
        if (mounted.current) setError(error.message);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      downloadRequest.current?.abort();
    };
  }, [load]);
  const run = async (key: string, action: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(key);
    setError('');
    setMessage('');
    try {
      const result = await action();
      if (mounted.current && result) setMessage(result);
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : '백업 작업을 완료하지 못했습니다.');
    } finally {
      if (mounted.current) setBusy('');
    }
  };
  const create = () =>
    run('create', async () => {
      await request<BackupItem>('', { method: 'POST', body: '{}' });
      await load();
      return '암호화 백업을 생성하고 무결성을 확인했습니다.';
    });
  const verify = (id: string) =>
    run(`verify:${id}`, async () => {
      const result = await request<{ id: string; verified: boolean }>(`/${id}/verify`, {
        method: 'POST',
        body: '{}',
      });
      if (result.verified !== true) throw new Error('백업 검증을 확인하지 못했습니다.');
      await load();
      return '백업의 암호화 인증과 전체 내용을 확인했습니다.';
    });
  const restorePreview = (id: string) =>
    run(`preview:${id}`, async () => {
      const result = await request<BackupPreview>(`/${id}/restore-preview`, { method: 'POST', body: '{}' });
      if (
        typeof result.canRestore !== 'boolean' ||
        !Array.isArray(result.blockedCodes) ||
        !/^[a-f\d]{64}$/.test(result.currentFingerprint)
      )
        throw new Error('복원 확인 결과가 올바르지 않습니다.');
      if (mounted.current) setPreview(result);
    });
  const download = (id: string) =>
    run(`download:${id}`, async () => {
      const controller = new AbortController();
      downloadRequest.current?.abort();
      downloadRequest.current = controller;
      const response = await privateFetch(`/api/backups/${encodeURIComponent(id)}/download`, {
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403)
        window.dispatchEvent(
          new Event(response.status === 401 ? 'crm:unauthorized' : 'crm:permissions-changed'),
        );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(publicErrorMessage(body, response.status, '백업을 내려받지 못했습니다.'));
      }
      if (!response.headers.get('content-type')?.includes('application/octet-stream'))
        throw new Error('백업 파일 응답이 올바르지 않습니다.');
      const blob = await response.blob();
      if (!mounted.current || controller.signal.aborted || downloadRequest.current !== controller) return;
      const url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ieumdesk-${id.replace(/[^a-z\d_-]/gi, '_')}.ycrm`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      await load();
      return '암호화 백업 파일을 내려받았습니다. 복원용 키는 별도로 보관해 주세요.';
    });
  const saveSchedule = () =>
    run('schedule', async () => {
      if (!schedule) return;
      const result = await request<BackupSchedule>('/schedule', {
        method: 'PATCH',
        body: JSON.stringify({
          revision: schedule.revision,
          enabled: schedule.enabled,
          intervalHours: schedule.intervalHours,
        }),
      });
      if (!Number.isInteger(result.revision) || typeof result.enabled !== 'boolean')
        throw new Error('자동 백업 설정 결과를 확인하지 못했습니다.');
      if (mounted.current) setSchedule(result);
      await load();
      return '자동 백업 설정을 저장했습니다.';
    });
  const dirty = Boolean(
    schedule &&
    overview &&
    (schedule.enabled !== overview.schedule.enabled ||
      schedule.intervalHours !== overview.schedule.intervalHours),
  );
  return (
    <section className="backup-page" aria-label={t('백업 관리')}>
      <div className="backup-heading">
        <div>
          <h2>
            <Archive size={22} />
            {t('백업 관리')}
          </h2>
          <p>{t('고객 자료·설치 정보·CS·첨부파일을 암호화하여 함께 보관합니다.')}</p>
        </div>
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() =>
            void run('refresh', async () => {
              await load(true);
              setPreview(null);
            })
          }
        >
          <RefreshCw size={15} />
          {t('새로고침')}
        </button>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {t(error)}
        </div>
      )}
      {message && (
        <div className="backup-success" role="status">
          <CheckCircle2 size={17} />
          {t(message)}
        </div>
      )}
      {loading && <p role="status">{t('백업 정보를 불러오는 중입니다…')}</p>}
      {overview && schedule && (
        <>
          {overview.issues.length > 0 && (
            <div className="error-box" role="alert">
              {t('백업 ')}
              {overview.issues.length}
              {t(
                '개의 무결성 또는 암호화 키를 확인해야 합니다. 정상 백업은 아래에서 계속 사용할 수 있습니다.',
              )}
              {overview.issues.map((issue) => (
                <div key={issue.id}>
                  <small>
                    {issue.id} · {issue.code}
                  </small>{' '}
                  <button className="text-button" disabled={!!busy} onClick={() => void verify(issue.id)}>
                    {t('다시 검사')}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="backup-summary">
            <ShieldCheck size={22} />
            <div>
              <strong>{t('암호화 원본과 첨부파일까지 포함')}</strong>
              <p>
                {t(
                  '암호화 키는 백업에 포함되지 않습니다. 키를 별도로 보관해야 복원할 수 있습니다. 백업 파일은 자동 삭제하지 않습니다.',
                )}
              </p>
            </div>
            <button className="button primary" disabled={!!busy} onClick={() => void create()}>
              {busy === 'create' ? t('백업 생성 중…') : t('지금 백업')}
            </button>
          </div>
          <form
            className="backup-schedule"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSchedule();
            }}
          >
            <div>
              <h3>{t('자동 백업')}</h3>
              <p>{t('CRM 서버가 실행 중일 때 지정한 주기로 백업합니다. 기본값은 꺼짐입니다.')}</p>
            </div>
            <label className="backup-enabled">
              <input
                type="checkbox"
                checked={schedule.enabled}
                disabled={!!busy}
                onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })}
              />
              {t('자동 백업 사용')}
            </label>
            <label>
              {t('백업 주기')}{' '}
              <select
                value={schedule.intervalHours}
                disabled={!!busy}
                onChange={(event) => setSchedule({ ...schedule, intervalHours: Number(event.target.value) })}
              >
                {[
                  1,
                  6,
                  12,
                  24,
                  48,
                  72,
                  168,
                  ...(![1, 6, 12, 24, 48, 72, 168].includes(schedule.intervalHours)
                    ? [schedule.intervalHours]
                    : []),
                ]
                  .sort((a, b) => a - b)
                  .map((hours) => (
                    <option key={hours} value={hours}>
                      {hours === 168 ? t('일주일') : t('{0}시간', [hours])}
                      {t('마다')}
                    </option>
                  ))}
              </select>
            </label>
            <span className="backup-next">
              {t('다음 백업: ')}
              {overview.schedule.enabled ? date(overview.schedule.nextRunAt) : t('사용 안 함')}
            </span>
            <button className="button secondary" disabled={!dirty || !!busy}>
              {busy === 'schedule' ? t('저장 중…') : t('설정 저장')}
            </button>
          </form>
          <div className="backup-table-wrap">
            <table className="backup-table">
              <caption>
                {t('저장한 백업 ')}
                {overview.items.length.toLocaleString()}
                {t('개')}
              </caption>
              <thead>
                <tr>
                  <th>{t('생성 일시')}</th>
                  <th>{t('종류')}</th>
                  <th>{t('내용')}</th>
                  <th>{t('파일 크기')}</th>
                  <th>{t('확인·다운로드')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {date(item.createdAt)}
                      <small>
                        {item.verifiedAt
                          ? t('검증 완료 {0}', [date(item.verifiedAt)])
                          : t('검증 기록은 서버 재시작 시 초기화됩니다.')}
                      </small>
                    </td>
                    <td>{t(reasonLabels[item.reason])}</td>
                    <td>
                      {item.counts.rows.toLocaleString()}
                      {t('행 · ')}
                      {item.counts.files.toLocaleString()}
                      {t('파일')}
                    </td>
                    <td>{size(item.bytes)}</td>
                    <td>
                      <div className="backup-actions">
                        <button
                          className="button secondary"
                          disabled={!!busy}
                          onClick={() => void verify(item.id)}
                        >
                          {busy === `verify:${item.id}` ? t('확인 중…') : t('무결성 검사')}
                        </button>
                        <button
                          className="button secondary"
                          disabled={!!busy}
                          onClick={() => void download(item.id)}
                        >
                          <Download size={14} />
                          {t('다운로드')}
                        </button>
                        <button
                          className="button secondary"
                          disabled={!!busy}
                          onClick={() => void restorePreview(item.id)}
                        >
                          {t('복원 준비 확인')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!overview.items.length && (
              <div className="empty">{t('저장한 백업이 없습니다. ‘지금 백업’으로 첫 백업을 만드세요.')}</div>
            )}
          </div>
          {preview && (
            <section className="backup-preview" aria-live="polite">
              <h3>
                {preview.canRestore ? t('복원할 데이터 구조가 일치합니다') : t('복원 전 확인이 필요합니다')}
              </h3>
              <p>
                {t('백업 ')}
                {preview.counts.rows.toLocaleString()}
                {t('행 · ')}
                {preview.counts.files.toLocaleString()}
                {t('파일 / 현재 ')}
                {preview.currentCounts.rows.toLocaleString()}
                {t('행 ·')} {preview.currentCounts.files.toLocaleString()}
                {t('파일')}
              </p>
              {preview.blockedCodes.map((code) => (
                <p className="error-box" key={code}>
                  {t(blockerLabels[code]) ?? code}
                </p>
              ))}
              <p>
                {t(
                  '실제 복원은 CRM 서버를 중지한 뒤 관리자 명령으로 실행합니다. 복원 전에 현재 상태를 자동 백업하며, 복원 후에는 다시 로그인해야 합니다.',
                )}
              </p>
              {preview.canRestore && (
                <details>
                  <summary>{t('관리자 복원 명령')}</summary>
                  <p>
                    {t(
                      '서버 중지 후 이 명령을 실행합니다. 이후 자료가 바뀌었다면 준비 확인부터 다시 진행하세요.',
                    )}
                  </p>
                  <code>
                    node --import tsx scripts/backup-restore.ts --backup {preview.id} --expected-fingerprint{' '}
                    {preview.currentFingerprint} --apply
                  </code>
                </details>
              )}
              <button className="text-button" onClick={() => setPreview(null)}>
                {t('확인 내용 닫기')}
              </button>
            </section>
          )}
          <section className="backup-history">
            <h3>{t('최근 백업 이력')}</h3>
            <div className="backup-table-wrap">
              <table className="backup-table">
                <thead>
                  <tr>
                    <th>{t('일시')}</th>
                    <th>{t('작업')}</th>
                    <th>{t('결과')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item) => (
                    <tr key={item.id}>
                      <td>{date(item.createdAt)}</td>
                      <td>{t(actionLabels[item.action]) ?? item.action}</td>
                      <td>
                        {item.outcome === 'success' ? t('완료') : t('실패')}
                        {item.code && <small>{item.code}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!history.length && <p className="backup-empty">{t('아직 백업 작업 이력이 없습니다.')}</p>}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
export default BackupPage;
