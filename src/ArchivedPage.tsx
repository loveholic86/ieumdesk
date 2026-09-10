import { t } from './i18n';
import { useLocale } from './use-locale';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArchiveRestore, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { api, dateLabel } from './api';
import { useAuth } from './auth';
import { archiveAreaLabels, type ArchivedEntry, type ArchiveArea } from './archive-types';

export function ArchiveButton({
  area,
  id,
  title,
  onArchived,
  notify,
}: {
  area: ArchiveArea;
  id: string;
  title: string;
  onArchived: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  useLocale();
  const { user } = useAuth();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (user?.role !== 'admin') return null;
  const archive = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/archive/${area}/${encodeURIComponent(id)}`, { method: 'POST', body: '{}' });
      setOpen(false);
      onArchived();
      notify('휴지통으로 이동했습니다. 환경설정의 휴지통에서 복원할 수 있습니다.');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError('');
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button className="button" type="button">
          <Trash2 size={15} />
          {t('휴지통으로 이동')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay form-overlay" />
        <Dialog.Content
          className="dialog"
          style={{ zIndex: 150, maxWidth: 480 }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <Dialog.Title>{t('휴지통으로 이동')}</Dialog.Title>
          <Dialog.Description>
            “{title}” {t(archiveAreaLabels[area])}
            {t(' 자료를 목록에서 숨깁니다. 저장된 내용은 유지되며 관리자가 복원할 수 있습니다.')}
          </Dialog.Description>
          {error && (
            <p className="error-box" role="alert">
              {t(error)}
            </p>
          )}
          <div className="dialog-footer">
            <Dialog.Close className="button" disabled={busy}>
              {t('취소')}
            </Dialog.Close>
            <button className="button primary" disabled={busy} onClick={() => void archive()}>
              {busy ? t('이동 중…') : t('휴지통으로 이동')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function ArchivedPage({
  notify,
  onRefresh,
  refresh = 0,
}: {
  notify: (message: string, error?: boolean) => void;
  onRefresh: () => void;
  refresh?: number;
}) {
  useLocale();
  const [items, setItems] = useState<ArchivedEntry[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [query, setQuery] = useState(''),
    [retry, setRetry] = useState(0),
    [restoring, setRestoring] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<{ items: ArchivedEntry[] }>('/archive', { signal: controller.signal })
      .then((result) => setItems(result.items))
      .catch((error) => {
        if (error.name !== 'AbortError') setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, retry]);
  const restore = async (item: ArchivedEntry) => {
    setRestoring(item.id);
    setError('');
    try {
      await api(`/archive/${item.area}/${encodeURIComponent(item.id)}/restore`, {
        method: 'POST',
        body: '{}',
      });
      setItems((previous) => previous.filter((row) => row.id !== item.id || row.area !== item.area));
      onRefresh();
      notify('자료를 복원했습니다.');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setRestoring(null);
    }
  };
  const filtered = items.filter((item) =>
    `${item.title} ${archiveAreaLabels[item.area]}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <section className="panel m-panel">
      <div className="m-toolbar">
        <div>
          <h2>{t('휴지통')}</h2>
          <p>
            {t(
              '관리자가 숨긴 자료를 확인하고 복원합니다. 고객사를 먼저 복원하면 연결 자료도 복원할 수 있습니다.',
            )}
          </p>
        </div>
        <button className="button" onClick={() => setRetry((value) => value + 1)} disabled={loading}>
          <RefreshCw size={16} />
          {t('새로고침')}
        </button>
      </div>
      <div className="m-toolbar">
        <label className="m-search">
          <Search size={17} />
          <input
            aria-label={t('휴지통 검색')}
            placeholder={t('자료 이름 또는 메뉴 검색')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button className="icon-button" aria-label={t('휴지통 검색 지우기')} onClick={() => setQuery('')}>
              <X size={15} />
            </button>
          )}
        </label>
        <span>
          {filtered.length}
          {t('건')}
        </span>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {t(error)}
        </p>
      )}
      {loading ? (
        <p className="m-loading" role="status">
          {t('휴지통을 불러오는 중입니다.')}
        </p>
      ) : filtered.length ? (
        <div className="m-table-wrap">
          <table className="m-table">
            <thead>
              <tr>
                <th>{t('메뉴')}</th>
                <th>{t('자료')}</th>
                <th>{t('이동일')}</th>
                <th>{t('작업')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={`${item.area}:${item.id}`}>
                  <td>{t(archiveAreaLabels[item.area])}</td>
                  <td>{item.title}</td>
                  <td>{dateLabel(item.archivedAt)}</td>
                  <td>
                    <button
                      className="button"
                      disabled={Boolean(restoring)}
                      onClick={() => void restore(item)}
                    >
                      <ArchiveRestore size={15} />
                      {restoring === item.id ? t('복원 중…') : t('복원')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <Trash2 size={25} />
          <p>{query ? t('검색 조건에 맞는 자료가 없습니다.') : t('휴지통이 비어 있습니다.')}</p>
        </div>
      )}
    </section>
  );
}
