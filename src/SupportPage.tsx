import { t, getLocaleTag } from './i18n';
import { useLocale } from './use-locale';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bell,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  ArchiveRestore,
  Trash2,
  Upload,
  File,
  Flag,
  Headphones,
  LockKeyhole,
  MessageCircle,
  MessagesSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  X,
} from 'lucide-react';
import { useAuth } from './auth';
import { useWorkspaceSettings } from './workspace-settings';
import { downloadInstallationFile, fileBase64, installationRequest as request } from './installation-api';
import type { Company } from './types';
import { prepareSupportDiscussionPatch, prepareSupportForm, supportProtectedFields } from './support-client';
import './catalog-support.css';

type SupportKind = 'tickets' | 'notices';
type SupportStatus = 'received' | 'in_progress' | 'on_hold' | 'answered' | 'closed';
type Answer = {
  id: string;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  canEdit?: boolean;
};
type Reply = { id: string; body: string; author: string; createdAt: string; canEdit?: boolean };
type DiscussionKind = 'answers' | 'replies';
type DiscussionTarget = {
  kind: DiscussionKind;
  entry: Answer | Reply;
  revision: number;
  masked: boolean;
  mode: 'edit' | 'delete';
};
type Attachment = { id: string; name: string; bytes: number; available: boolean };
export type SupportRecord = {
  id: string;
  kind: SupportKind;
  revision: number;
  title: string;
  body: string;
  companyId: string;
  status: SupportStatus;
  category: string;
  urgent: boolean;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  contactMobile?: string;
  inquireType?: string;
  answerPreference?: string;
  mailRequested?: boolean;
  sourceStatusLabel?: string;
  assignee: string;
  visible: boolean;
  highlighted: boolean;
  createdAt: string;
  updatedAt: string;
  imported: boolean;
  masked: boolean;
  deleted?: boolean;
  answers: Answer[];
  replies: Reply[];
  attachments: Attachment[];
};
type Props = {
  companies: Company[];
  notify: (text: string, error?: boolean) => void;
  onRefresh?: () => void;
};
const statuses: [SupportStatus, string][] = [
  ['received', '접수'],
  ['in_progress', '처리 중'],
  ['on_hold', '보류'],
  ['answered', '답변 완료'],
  ['closed', '종료'],
];
const statusName = (value: SupportStatus) => statuses.find(([key]) => key === value)?.[1] || '미분류';
const date = (value: string, time = false) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? time
      ? parsed.toLocaleString(getLocaleTag())
      : parsed.toLocaleDateString(getLocaleTag())
    : '미등록';
};
const validSummary = (value: unknown): value is SupportRecord =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as SupportRecord).id === 'string' &&
  typeof (value as SupportRecord).title === 'string' &&
  ['tickets', 'notices'].includes((value as SupportRecord).kind) &&
  typeof (value as SupportRecord).masked === 'boolean';
const validDetail = (value: unknown, id: string): value is SupportRecord =>
  validSummary(value) &&
  value.id === id &&
  Number.isSafeInteger(value.revision) &&
  typeof value.body === 'string' &&
  Array.isArray(value.answers) &&
  value.answers.every((item) => typeof item.id === 'string' && typeof item.body === 'string') &&
  Array.isArray(value.replies) &&
  value.replies.every((item) => typeof item.id === 'string' && typeof item.body === 'string') &&
  Array.isArray(value.attachments);

export default function SupportPage({ companies, notify, onRefresh }: Props) {
  useLocale();
  const { user, canWrite } = useAuth();
  const isAdmin = user?.role === 'admin' && user.status === 'active';
  const {
    settings,
    loading: policyLoading,
    refreshing: policyRefreshing,
    error: policyError,
    refresh: refreshPolicy,
  } = useWorkspaceSettings();
  const policyPending = !settings || policyLoading || policyRefreshing;
  const policyKey = settings ? `${settings.revision}:${settings.protectionEnabled}` : 'pending';
  const scopeKey = `${user?.id || ''}:${user?.role || ''}:${user?.status || ''}:${policyKey}`;
  const [kind, setKind] = useState<SupportKind>('tickets');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [archiveFilter, setArchiveFilter] = useState('active');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<{ key: string; items: SupportRecord[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ key: string; item: SupportRecord } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [editing, setEditing] = useState<{
    key: string;
    record: SupportRecord | null;
    kind: SupportKind;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [detailMessage, setDetailMessage] = useState('');
  const operation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const identity = useRef({ scopeKey, policyPending });
  identity.current = { scopeKey, policyPending };
  const opener = useRef<HTMLElement | null>(null);
  const editOpener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const companyNames = useMemo(
    () => new Map(companies.map((company) => [company.id, company.name])),
    [companies],
  );
  const listKey = `${scopeKey}:${kind}:${search}:${statusFilter}:${archiveFilter}`;
  const visibleItems = (list?.key === listKey ? list.items : []).filter(
    (item) => archiveFilter === 'all' || Boolean(item.deleted) === (archiveFilter === 'archived'),
  );
  const detailKey = `${scopeKey}:${selectedId || ''}`;
  const visibleDetail = detail?.key === detailKey ? detail.item : null;
  const visibleEditing = canWrite && editing?.key === scopeKey ? editing : null;
  const rememberFocus = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const restoreFocus = () => (opener.current?.isConnected ? opener.current : addButton.current)?.focus();

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);
  useEffect(() => {
    setPage(1);
  }, [kind, search, statusFilter, archiveFilter]);
  useEffect(() => {
    ++generation.current;
    operation.current?.abort();
    setEditing(null);
    setDetail(null);
    setDetailMessage('');
    setSaveError('');
    setBusy(false);
    if (!isAdmin) setArchiveFilter('active');
    return () => {
      ++generation.current;
      operation.current?.abort();
    };
  }, [scopeKey]);
  useEffect(() => {
    if (!user || user.status !== 'active' || policyPending) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      kind,
      search,
      status: kind === 'tickets' ? statusFilter : '',
      ...(isAdmin && archiveFilter !== 'active' ? { includeArchived: 'true' } : {}),
    });
    void request<{ items: SupportRecord[] }>(`/support?${params.toString()}`, { signal: controller.signal })
      .then((result) => {
        if (!Array.isArray(result.items) || !result.items.every(validSummary))
          throw new Error('고객지원 목록 응답을 확인하지 못했습니다.');
        if (
          !controller.signal.aborted &&
          identity.current.scopeKey === scopeKey &&
          !identity.current.policyPending
        )
          setList({ key: listKey, items: result.items });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '고객지원 목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    kind,
    search,
    statusFilter,
    archiveFilter,
    isAdmin,
    retry,
    scopeKey,
    listKey,
    policyPending,
    user?.id,
    user?.status,
  ]);
  useEffect(() => {
    if (!selectedId || policyPending) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError('');
    void request<SupportRecord>(`/support/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then((result) => {
        if (!validDetail(result, selectedId)) throw new Error('고객지원 상세 응답을 확인하지 못했습니다.');
        if (
          !controller.signal.aborted &&
          identity.current.scopeKey === scopeKey &&
          !identity.current.policyPending
        )
          setDetail({ key: detailKey, item: result });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setDetailError(reason instanceof Error ? reason.message : '고객지원 상세를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, detailKey, detailRetry, scopeKey, policyPending]);
  useEffect(() => {
    const clear = () => {
      ++generation.current;
      operation.current?.abort();
      setList(null);
      setDetail(null);
      setEditing(null);
      setBusy(false);
    };
    window.addEventListener('crm:unauthorized', clear);
    window.addEventListener('crm:permissions-changed', clear);
    return () => {
      window.removeEventListener('crm:unauthorized', clear);
      window.removeEventListener('crm:permissions-changed', clear);
    };
  }, []);

  const mutate = async (
    path: string,
    method: string,
    body: Record<string, unknown>,
    message: string,
    closeEditor = false,
  ) => {
    if (!canWrite || busy || policyPending) return false;
    const token = ++generation.current,
      controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setBusy(true);
    setSaveError('');
    setDetailError('');
    setDetailMessage('');
    try {
      const result = await request<SupportRecord>(path, {
        method,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (token !== generation.current || identity.current.scopeKey !== scopeKey || controller.signal.aborted)
        return false;
      if (closeEditor) setEditing(null);
      if (validSummary(result) && (!selectedId || result.id === selectedId)) {
        if (!selectedId) {
          setSelectedId(result.id);
          setDetail(null);
        } else if (validDetail(result, selectedId) && !identity.current.policyPending)
          setDetail({ key: detailKey, item: result });
      }
      setRetry((value) => value + 1);
      setDetailRetry((value) => value + 1);
      setDetailMessage(message);
      notify(message);
      onRefresh?.();
      return true;
    } catch (reason) {
      if (token === generation.current && !controller.signal.aborted) {
        const text = reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 확인해 주세요.';
        if (closeEditor) setSaveError(text);
        else setDetailError(text);
      }
      return false;
    } finally {
      if (token === generation.current) {
        setBusy(false);
        operation.current = null;
      }
    }
  };
  const switchKind = (value: SupportKind) => {
    setKind(value);
    setQuery('');
    setSearch('');
    setStatusFilter('');
    setArchiveFilter('active');
    setSelectedId(null);
    setDetail(null);
    setError('');
  };
  const pages = Math.max(1, Math.ceil(visibleItems.length / 20)),
    currentPage = Math.min(page, pages);
  return (
    <section className="support-page">
      <header className="support-heading">
        <div>
          <div className="eyebrow">CUSTOMER SUPPORT</div>
          <h1>{t('고객지원')}</h1>
          <p>{t('고객 문의의 처리 흐름과 공지사항을 관리합니다.')}</p>
        </div>
        {canWrite && (
          <button
            ref={addButton}
            className="button primary"
            disabled={busy || policyPending}
            onClick={() => {
              rememberFocus();
              editOpener.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setSaveError('');
              setEditing({ key: scopeKey, record: null, kind });
            }}
          >
            <Plus size={17} />
            {kind === 'tickets' ? t('문의 등록') : t('공지 등록')}
          </button>
        )}
      </header>
      <div className="support-kind-tabs" role="tablist" aria-label={t('고객지원 구분')}>
        <button role="tab" aria-selected={kind === 'tickets'} onClick={() => switchKind('tickets')}>
          <Headphones size={17} />
          {t('문의·답변')}
        </button>
        <button role="tab" aria-selected={kind === 'notices'} onClick={() => switchKind('notices')}>
          <Bell size={17} />
          {t('공지사항')}
        </button>
      </div>
      <div className="support-panel">
        <div className="catalog-toolbar">
          <label className="catalog-search">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('고객지원 검색')}
              placeholder={kind === 'tickets' ? t('제목·분류·고객사 검색') : t('공지 제목·분류 검색')}
            />
            {query && (
              <button className="icon-button" aria-label={t('검색어 지우기')} onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )}
          </label>
          {kind === 'tickets' && (
            <select
              aria-label={t('문의 처리 상태')}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">{t('전체 상태')}</option>
              {statuses.map(([key, label]) => (
                <option key={key} value={key}>
                  {t(label)}
                </option>
              ))}
            </select>
          )}
          {isAdmin && (
            <select
              aria-label={t('고객지원 보관 상태')}
              value={archiveFilter}
              onChange={(event) => setArchiveFilter(event.target.value)}
            >
              <option value="active">{t('사용 중인 자료')}</option>
              <option value="archived">{t('휴지통')}</option>
              <option value="all">{t('휴지통 포함 전체')}</option>
            </select>
          )}
          <button
            className="button"
            disabled={loading || policyPending}
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={15} className={loading ? 'auth-spin' : ''} />
            {t('새로고침')}
          </button>
        </div>
        {policyError && !settings && (
          <div className="catalog-message is-error" role="alert">
            {t(policyError)}
            <button className="catalog-text-button" onClick={() => void refreshPolicy().catch(() => {})}>
              {t('다시 확인')}
            </button>
          </div>
        )}
        {error && (
          <p className="catalog-message is-error" role="alert">
            {t(error)}
          </p>
        )}
        <div
          className="catalog-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={kind === 'tickets' ? t('문의 목록') : t('공지 목록')}
        >
          <table className="catalog-table support-table">
            <thead>
              <tr>
                <th scope="col">{kind === 'tickets' ? t('문의 제목') : t('공지 제목')}</th>
                <th scope="col">{t('고객사')}</th>
                <th scope="col">{t('분류')}</th>
                <th scope="col">{kind === 'tickets' ? t('담당자') : t('표시')}</th>
                <th scope="col">{kind === 'tickets' ? t('처리 상태') : t('상단 고정')}</th>
                <th scope="col">{t('최근 수정')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.slice((currentPage - 1) * 20, currentPage * 20).map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      className="support-list-title"
                      onClick={() => {
                        rememberFocus();
                        setSelectedId(item.id);
                        setDetailMessage('');
                        setDetailError('');
                      }}
                    >
                      {item.urgent && (
                        <span className="support-urgent">
                          <Flag size={10} />
                          {t('긴급')}
                        </span>
                      )}
                      {item.highlighted && <Bell size={12} />}
                      <span>{policyPending ? t('보호 설정 확인 중') : item.title || t('제목 없음')}</span>
                      {item.deleted && <small className="support-source-badge">{t('휴지통')}</small>}
                    </button>
                    {item.imported && <small className="catalog-subtext">{t('기존 자료')}</small>}
                  </td>
                  <td>
                    {item.companyId
                      ? companyNames.get(item.companyId) || t('고객사 확인 필요')
                      : t('연결 없음')}
                  </td>
                  <td>{item.category || t('미분류')}</td>
                  <td>
                    {kind === 'tickets' ? item.assignee || t('미지정') : item.visible ? t('표시') : t('숨김')}
                  </td>
                  <td>
                    {kind === 'tickets' ? (
                      <span className={`support-status is-${item.status}`}>{t(statusName(item.status))}</span>
                    ) : item.highlighted ? (
                      t('고정')
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{date(item.updatedAt || item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visibleItems.length && (
          <div className="catalog-empty" role={loading || policyPending ? 'status' : undefined}>
            {loading || policyPending ? (
              <>
                <RefreshCw size={25} className="auth-spin" />
                <p>
                  {policyPending
                    ? t('보호 설정을 확인하고 있습니다.')
                    : t('고객지원 목록을 불러오고 있습니다.')}
                </p>
              </>
            ) : (
              <>
                <MessagesSquare size={29} />
                <h3>
                  {search || statusFilter
                    ? t('조건에 맞는 자료가 없습니다.')
                    : kind === 'tickets'
                      ? t('등록된 문의가 없습니다.')
                      : t('등록된 공지사항이 없습니다.')}
                </h3>
                <p>
                  {search || statusFilter
                    ? t('검색어나 필터를 변경해 주세요.')
                    : t('새로운 자료가 등록되면 이곳에서 확인할 수 있습니다.')}
                </p>
              </>
            )}
          </div>
        )}
        <footer className="catalog-pagination">
          <span>
            {t('조회 결과 ')}
            <strong>{visibleItems.length.toLocaleString()}</strong>
            {t('건')}
          </span>
          <div>
            <button
              className="icon-button"
              aria-label={t('이전 페이지')}
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {currentPage} / {pages}
            </span>
            <button
              className="icon-button"
              aria-label={t('다음 페이지')}
              disabled={currentPage === pages}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </footer>
      </div>
      {selectedId && (
        <SupportDetail
          key={`${scopeKey}:${selectedId}`}
          record={visibleDetail}
          loading={detailLoading || (policyPending && !visibleDetail)}
          error={detailError}
          message={detailMessage}
          policyPending={policyPending}
          canWrite={canWrite && !visibleDetail?.deleted}
          isAdmin={isAdmin}
          protectionEnabled={(settings?.protectionEnabled ?? true) || !isAdmin}
          busy={busy}
          companyName={
            visibleDetail?.companyId
              ? companyNames.get(visibleDetail.companyId) || '고객사 확인 필요'
              : '고객사 연결 없음'
          }
          onClose={() => {
            if (!busy) {
              ++generation.current;
              operation.current?.abort();
              setSelectedId(null);
              setDetail(null);
              setDetailMessage('');
            }
          }}
          onRestoreFocus={restoreFocus}
          onRetry={() => setDetailRetry((value) => value + 1)}
          onEdit={() => {
            if (visibleDetail) {
              editOpener.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setSaveError('');
              setEditing({ key: scopeKey, record: visibleDetail, kind: visibleDetail.kind });
            }
          }}
          onStatus={(status) =>
            visibleDetail
              ? mutate(
                  `/support/${encodeURIComponent(visibleDetail.id)}`,
                  'PATCH',
                  { revision: visibleDetail.revision, status },
                  '문의 처리 상태를 변경했습니다.',
                )
              : Promise.resolve(false)
          }
          onAnswer={(title, body) =>
            mutate(
              `/support/${encodeURIComponent(selectedId)}/answers`,
              'POST',
              { title, body },
              '답변을 등록했습니다.',
            )
          }
          onReply={(body) =>
            mutate(
              `/support/${encodeURIComponent(selectedId)}/replies`,
              'POST',
              { body },
              '댓글을 등록했습니다.',
            )
          }
          onDiscussionUpdate={(discussionKind, entryId, payload) =>
            mutate(
              `/support/${encodeURIComponent(selectedId)}/${discussionKind}/${encodeURIComponent(entryId)}`,
              'PATCH',
              payload,
              discussionKind === 'answers' ? '답변을 수정했습니다.' : '댓글을 수정했습니다.',
            )
          }
          onDiscussionDelete={(discussionKind, entryId, revision) =>
            mutate(
              `/support/${encodeURIComponent(selectedId)}/${discussionKind}/${encodeURIComponent(entryId)}`,
              'DELETE',
              { revision },
              discussionKind === 'answers' ? '답변을 삭제했습니다.' : '댓글을 삭제했습니다.',
            )
          }
          onArchiveRestore={() =>
            visibleDetail
              ? mutate(
                  `/support/${encodeURIComponent(visibleDetail.id)}/${visibleDetail.deleted ? 'restore' : 'archive'}`,
                  'POST',
                  { revision: visibleDetail.revision },
                  visibleDetail.deleted
                    ? '고객지원 자료를 복원했습니다.'
                    : '휴지통으로 이동했습니다. 보관 상태 필터에서 확인할 수 있습니다.',
                )
              : Promise.resolve(false)
          }
          onAttachmentUpload={(name, contentBase64) =>
            mutate(
              `/support/${encodeURIComponent(selectedId)}/attachments`,
              'POST',
              { name, contentBase64 },
              '첨부파일을 등록했습니다.',
            )
          }
          onAttachmentDelete={(attachmentId) =>
            mutate(
              `/support/${encodeURIComponent(selectedId)}/attachments/${encodeURIComponent(attachmentId)}`,
              'DELETE',
              {},
              '첨부파일을 삭제했습니다.',
            )
          }
        />
      )}
      {visibleEditing && (
        <SupportEditor
          key={`${scopeKey}:${visibleEditing.record?.id || 'new'}:${visibleEditing.kind}`}
          record={visibleEditing.record}
          kind={visibleEditing.kind}
          companies={companies}
          busy={busy}
          policyPending={policyPending}
          error={saveError}
          onClose={() => {
            setEditing(null);
            setSaveError('');
          }}
          onRestoreFocus={() => {
            if (editOpener.current?.isConnected) editOpener.current.focus();
            else if (!selectedId) restoreFocus();
          }}
          onSave={(payload) =>
            void mutate(
              visibleEditing.record ? `/support/${encodeURIComponent(visibleEditing.record.id)}` : '/support',
              visibleEditing.record ? 'PATCH' : 'POST',
              {
                ...payload,
                ...(visibleEditing.record
                  ? { revision: visibleEditing.record.revision }
                  : { kind: visibleEditing.kind }),
              },
              visibleEditing.kind === 'tickets' ? '문의 정보를 저장했습니다.' : '공지사항을 저장했습니다.',
              true,
            )
          }
        />
      )}
    </section>
  );
}

function ProtectedText({
  value,
  masked,
  multiline = false,
}: {
  value: string;
  masked: boolean;
  multiline?: boolean;
}) {
  useLocale();
  if (masked)
    return (
      <span className="support-protected">
        <LockKeyhole size={13} />
        {t('보호됨')}
      </span>
    );
  return (
    <span className={multiline ? 'support-body-text' : ''}>
      {value || <span className="support-missing">{t('미등록')}</span>}
    </span>
  );
}

function SupportDetail({
  record,
  loading,
  error,
  message,
  policyPending,
  canWrite,
  isAdmin,
  protectionEnabled,
  busy,
  companyName,
  onClose,
  onRestoreFocus,
  onRetry,
  onEdit,
  onStatus,
  onAnswer,
  onReply,
  onDiscussionUpdate,
  onDiscussionDelete,
  onArchiveRestore,
  onAttachmentUpload,
  onAttachmentDelete,
}: {
  record: SupportRecord | null;
  loading: boolean;
  error: string;
  message: string;
  policyPending: boolean;
  canWrite: boolean;
  isAdmin: boolean;
  protectionEnabled: boolean;
  busy: boolean;
  companyName: string;
  onClose: () => void;
  onRestoreFocus: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onStatus: (value: SupportStatus) => Promise<boolean>;
  onAnswer: (title: string, body: string) => Promise<boolean>;
  onReply: (body: string) => Promise<boolean>;
  onDiscussionUpdate: (
    kind: DiscussionKind,
    entryId: string,
    payload: { revision: number; body: string; title?: string },
  ) => Promise<boolean>;
  onDiscussionDelete: (kind: DiscussionKind, entryId: string, revision: number) => Promise<boolean>;
  onArchiveRestore: () => Promise<boolean>;
  onAttachmentUpload: (name: string, contentBase64: string) => Promise<boolean>;
  onAttachmentDelete: (attachmentId: string) => Promise<boolean>;
}) {
  useLocale();
  const [answerTitle, setAnswerTitle] = useState(''),
    [answerBody, setAnswerBody] = useState(''),
    [replyBody, setReplyBody] = useState('');
  const [composer, setComposer] = useState<'answer' | 'reply'>('answer');
  const [draftStatus, setDraftStatus] = useState<SupportStatus>(record?.status || 'received');
  const [localError, setLocalError] = useState('');
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [discussionTarget, setDiscussionTarget] = useState<DiscussionTarget | null>(null);
  const discussionOpener = useRef<HTMLElement | null>(null);
  const detailClose = useRef<HTMLButtonElement | null>(null);
  const openDiscussion = (kind: DiscussionKind, entry: Answer | Reply, mode: 'edit' | 'delete') => {
    if (!record || !canWrite || entry.canEdit !== true || busy || policyPending) return;
    discussionOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDiscussionTarget({ kind, entry, mode, revision: record.revision, masked: record.masked });
  };
  const activeDiscussion =
    canWrite &&
    discussionTarget &&
    record?.[discussionTarget.kind].some(
      (entry) => entry.id === discussionTarget.entry.id && entry.canEdit === true,
    )
      ? discussionTarget
      : null;
  useEffect(() => {
    if (record) setDraftStatus(record.status);
  }, [record?.status]);
  const masked = Boolean(record?.masked || policyPending);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || policyPending) return;
    const body = (composer === 'answer' ? answerBody : replyBody).trim();
    if (!body) return setLocalError('내용을 입력해 주세요.');
    setLocalError('');
    if (await (composer === 'answer' ? onAnswer(answerTitle.trim() || '답변', body) : onReply(body))) {
      setAnswerTitle('');
      setAnswerBody('');
      setReplyBody('');
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="support-detail-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <header className="support-detail-header">
            <span className="support-detail-icon">
              {record?.kind === 'notices' ? <Bell size={24} /> : <Headphones size={24} />}
            </span>
            <div>
              <Dialog.Title>
                {policyPending ? t('고객지원 상세') : record?.title || t('고객지원 상세')}
              </Dialog.Title>
              <Dialog.Description>
                {record?.kind === 'notices'
                  ? t('공지사항 내용과 표시 설정을 확인합니다.')
                  : t('문의 내용과 답변·댓글을 확인합니다.')}
              </Dialog.Description>
            </div>
            <button
              ref={detailClose}
              className="icon-button"
              aria-label={t('고객지원 상세 닫기')}
              disabled={busy}
              onClick={onClose}
            >
              <X size={21} />
            </button>
          </header>
          <div className="support-detail-scroll">
            {message && (
              <p className="catalog-message" role="status">
                <Check size={15} />
                {t(message)}
              </p>
            )}
            {error && (
              <p className="catalog-message is-error" role="alert">
                {t(error)}
                <button className="catalog-text-button" disabled={busy} onClick={onRetry}>
                  {t('다시 불러오기')}
                </button>
              </p>
            )}
            {!record ? (
              <div className="catalog-empty" role="status">
                {loading ? (
                  <>
                    <RefreshCw size={26} className="auth-spin" />
                    <p>{t('상세 정보를 불러오고 있습니다.')}</p>
                  </>
                ) : (
                  <p>{t('상세 정보를 확인하지 못했습니다.')}</p>
                )}
              </div>
            ) : (
              <div className="support-detail-layout">
                <main className="support-main-content">
                  <section className="support-content-card">
                    <header>
                      <h3>{record.kind === 'tickets' ? t('문의 내용') : t('공지 내용')}</h3>
                      {record.urgent && (
                        <span className="support-urgent">
                          <Flag size={11} />
                          {t('긴급')}
                        </span>
                      )}
                      {record.imported && <span className="support-source-badge">{t('기존 자료')}</span>}
                    </header>
                    <div className="support-content-body">
                      <ProtectedText value={record.body} masked={masked} multiline />
                    </div>
                  </section>
                  <section className="support-content-card">
                    <header>
                      <h3>
                        <MessagesSquare size={16} />
                        {t('답변')}
                      </h3>
                      <span>
                        {record.answers.length}
                        {t('개')}
                      </span>
                    </header>
                    <div className="support-discussion-list">
                      {record.answers.length ? (
                        record.answers.map((answer) => (
                          <article key={answer.id}>
                            <div>
                              <strong>{policyPending ? t('보호됨') : answer.title || t('답변')}</strong>
                              <small>
                                {answer.author || t('작성자 미등록')} · {date(answer.createdAt, true)}
                              </small>
                            </div>
                            <ProtectedText value={answer.body} masked={masked} multiline />
                            {canWrite && answer.canEdit === true && (
                              <div className="support-discussion-actions">
                                <button
                                  className="catalog-text-button"
                                  disabled={busy || policyPending}
                                  onClick={() => openDiscussion('answers', answer, 'edit')}
                                >
                                  <Pencil size={12} />
                                  {t('답변 수정')}
                                </button>
                                <button
                                  className="catalog-text-button is-danger"
                                  disabled={busy || policyPending}
                                  onClick={() => openDiscussion('answers', answer, 'delete')}
                                >
                                  <Trash2 size={12} />
                                  {t('답변 삭제')}
                                </button>
                              </div>
                            )}
                          </article>
                        ))
                      ) : (
                        <p className="support-empty-line">{t('등록된 답변이 없습니다.')}</p>
                      )}
                    </div>
                  </section>
                  <section className="support-content-card">
                    <header>
                      <h3>
                        <MessageCircle size={16} />
                        {t('댓글')}
                      </h3>
                      <span>
                        {record.replies.length}
                        {t('개')}
                      </span>
                    </header>
                    <div className="support-discussion-list">
                      {record.replies.length ? (
                        record.replies.map((reply) => (
                          <article key={reply.id}>
                            <div>
                              <strong>{reply.author || t('작성자 미등록')}</strong>
                              <small>{date(reply.createdAt, true)}</small>
                            </div>
                            <ProtectedText value={reply.body} masked={masked} multiline />
                            {canWrite && reply.canEdit === true && (
                              <div className="support-discussion-actions">
                                <button
                                  className="catalog-text-button"
                                  disabled={busy || policyPending}
                                  onClick={() => openDiscussion('replies', reply, 'edit')}
                                >
                                  <Pencil size={12} />
                                  {t('댓글 수정')}
                                </button>
                                <button
                                  className="catalog-text-button is-danger"
                                  disabled={busy || policyPending}
                                  onClick={() => openDiscussion('replies', reply, 'delete')}
                                >
                                  <Trash2 size={12} />
                                  {t('댓글 삭제')}
                                </button>
                              </div>
                            )}
                          </article>
                        ))
                      ) : (
                        <p className="support-empty-line">{t('등록된 댓글이 없습니다.')}</p>
                      )}
                    </div>
                  </section>
                  {canWrite && (
                    <section className="support-content-card support-composer">
                      <header>
                        <div role="tablist" aria-label={t('작성할 내용')}>
                          <button
                            role="tab"
                            aria-selected={composer === 'answer'}
                            onClick={() => {
                              setComposer('answer');
                              setLocalError('');
                            }}
                          >
                            {t('답변 작성')}
                          </button>
                          <button
                            role="tab"
                            aria-selected={composer === 'reply'}
                            onClick={() => {
                              setComposer('reply');
                              setLocalError('');
                            }}
                          >
                            {t('댓글 작성')}
                          </button>
                        </div>
                      </header>
                      <form autoComplete="off" spellCheck={false} onSubmit={submit}>
                        {composer === 'answer' && (
                          <label className="catalog-form-field">
                            {t('답변 제목')}
                            <input
                              value={policyPending ? '' : answerTitle}
                              maxLength={300}
                              onChange={(event) => setAnswerTitle(event.target.value)}
                              disabled={busy || policyPending}
                              placeholder={t('답변 제목 (선택)')}
                            />
                          </label>
                        )}
                        <label className="catalog-form-field">
                          {composer === 'answer' ? t('답변 내용') : t('댓글 내용')}
                          <textarea
                            rows={5}
                            maxLength={100000}
                            value={policyPending ? '' : composer === 'answer' ? answerBody : replyBody}
                            onChange={(event) =>
                              composer === 'answer'
                                ? setAnswerBody(event.target.value)
                                : setReplyBody(event.target.value)
                            }
                            disabled={busy || policyPending}
                            placeholder={t('내용을 입력하세요.')}
                          />
                        </label>
                        {localError && (
                          <p className="catalog-message is-error" role="alert">
                            {t(localError)}
                          </p>
                        )}
                        <footer>
                          <span>
                            {policyPending
                              ? t('보호 설정을 확인하고 있습니다.')
                              : t('작성한 내용은 현재 사용자 이름으로 등록됩니다.')}
                          </span>
                          <button className="button primary" disabled={busy || policyPending}>
                            <Send size={14} />
                            {busy ? t('등록 중…') : composer === 'answer' ? t('답변 등록') : t('댓글 등록')}
                          </button>
                        </footer>
                      </form>
                    </section>
                  )}
                </main>
                <aside className="support-side-content">
                  <section className="support-content-card">
                    <header>
                      <h3>
                        <Building2 size={16} />
                        {record.kind === 'notices' ? t('공지 정보') : t('문의 정보')}
                      </h3>
                    </header>
                    <dl>
                      <div>
                        <dt>{t('고객사')}</dt>
                        <dd>{companyName}</dd>
                      </div>
                      <div>
                        <dt>{t('분류')}</dt>
                        <dd>{record.category || t('미분류')}</dd>
                      </div>
                      {record.kind === 'tickets' && (
                        <>
                          <div>
                            <dt>{t('문의 유형')}</dt>
                            <dd>{record.inquireType || t('미등록')}</dd>
                          </div>
                          <div>
                            <dt>{t('희망 답변 방식')}</dt>
                            <dd>{record.answerPreference || t('미지정')}</dd>
                          </div>
                        </>
                      )}
                      <div>
                        <dt>{t('담당자')}</dt>
                        <dd>{record.assignee || t('미지정')}</dd>
                      </div>
                      {record.kind === 'tickets' ? (
                        <div>
                          <dt>{t('처리 상태')}</dt>
                          <dd>
                            {canWrite ? (
                              <div className="support-status-editor">
                                <select
                                  aria-label={t('상세 문의 처리 상태')}
                                  value={draftStatus}
                                  onChange={(event) => setDraftStatus(event.target.value as SupportStatus)}
                                  disabled={busy || policyPending}
                                >
                                  {statuses.map(([key, label]) => (
                                    <option key={key} value={key}>
                                      {t(label)}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  className="button"
                                  disabled={busy || policyPending || draftStatus === record.status}
                                  onClick={() => void onStatus(draftStatus)}
                                >
                                  {t('적용')}
                                </button>
                              </div>
                            ) : (
                              <span className={`support-status is-${record.status}`}>
                                {t(statusName(record.status))}
                              </span>
                            )}
                          </dd>
                        </div>
                      ) : (
                        <>
                          <div>
                            <dt>{t('표시')}</dt>
                            <dd>{record.visible ? t('표시') : t('숨김')}</dd>
                          </div>
                          <div>
                            <dt>{t('상단 고정')}</dt>
                            <dd>{record.highlighted ? t('고정') : t('일반')}</dd>
                          </div>
                        </>
                      )}
                      {record.sourceStatusLabel && (
                        <div>
                          <dt>{t('원본 상태')}</dt>
                          <dd>{record.sourceStatusLabel}</dd>
                        </div>
                      )}
                      <div>
                        <dt>{t('메일 요청 기록')}</dt>
                        <dd>
                          {record.mailRequested ? t('요청 기록 있음') : t('요청 없음')}
                          <small className="support-request-note">
                            {t('요청 여부만 보관하며 실제 메일·푸시는 발송하지 않습니다.')}
                          </small>
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <section className="support-content-card">
                    <header>
                      <h3>{t('연락처')}</h3>
                    </header>
                    <dl>
                      <div>
                        <dt>{t('이름')}</dt>
                        <dd>
                          <ProtectedText value={record.contactName} masked={masked} />
                        </dd>
                      </div>
                      <div>
                        <dt>{t('이메일')}</dt>
                        <dd>
                          <ProtectedText value={record.contactEmail} masked={masked} />
                        </dd>
                      </div>
                      <div>
                        <dt>{t('전화번호')}</dt>
                        <dd>
                          <ProtectedText value={record.contactPhone} masked={masked} />
                        </dd>
                      </div>
                      <div>
                        <dt>{t('휴대폰')}</dt>
                        <dd>
                          <ProtectedText value={record.contactMobile || ''} masked={masked} />
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <SupportAttachments
                    record={record}
                    canWrite={canWrite}
                    busy={busy}
                    policyPending={policyPending}
                    protectionEnabled={protectionEnabled}
                    onUpload={onAttachmentUpload}
                    onDelete={onAttachmentDelete}
                  />
                  <div className="support-timestamps">
                    <Clock3 size={13} />
                    <div>
                      <span>
                        {t('등록 ')}
                        {date(record.createdAt, true)}
                      </span>
                      <span>
                        {t('수정 ')}
                        {date(record.updatedAt, true)}
                      </span>
                    </div>
                  </div>
                </aside>
              </div>
            )}
          </div>
          <footer className="support-detail-footer">
            <span>
              <LockKeyhole size={13} />
              {policyPending
                ? t('보호 설정 확인 중')
                : record?.masked
                  ? t('본문과 연락처를 보호하고 있습니다.')
                  : t('현재 설정에 따라 정보를 표시하고 있습니다.')}
            </span>
            <div>
              {isAdmin && record && (
                <button
                  className="button"
                  disabled={busy || policyPending}
                  onClick={() => setArchiveConfirm(true)}
                >
                  {record.deleted ? <ArchiveRestore size={14} /> : <Trash2 size={14} />}{' '}
                  {record.deleted ? t('복원') : t('휴지통으로 이동')}
                </button>
              )}
              <button className="button" disabled={busy} onClick={onClose}>
                {t('닫기')}
              </button>
              {canWrite && record && (
                <button className="button primary" disabled={busy || policyPending} onClick={onEdit}>
                  <Pencil size={14} />
                  {t('정보 수정')}
                </button>
              )}
            </div>
          </footer>
          {activeDiscussion && (
            <SupportDiscussionEditor
              key={`${activeDiscussion.kind}:${activeDiscussion.entry.id}:${activeDiscussion.mode}`}
              target={activeDiscussion}
              busy={busy}
              policyPending={policyPending}
              error={error}
              onClose={() => setDiscussionTarget(null)}
              onRestoreFocus={() =>
                (discussionOpener.current?.isConnected
                  ? discussionOpener.current
                  : detailClose.current
                )?.focus()
              }
              onSave={(payload) =>
                onDiscussionUpdate(activeDiscussion.kind, activeDiscussion.entry.id, payload)
              }
              onDelete={() =>
                onDiscussionDelete(
                  activeDiscussion.kind,
                  activeDiscussion.entry.id,
                  activeDiscussion.revision,
                )
              }
            />
          )}
          {archiveConfirm && record && (
            <Dialog.Root
              open
              onOpenChange={(open) => {
                if (!open && !busy) setArchiveConfirm(false);
              }}
            >
              <Dialog.Portal>
                <Dialog.Overlay className="support-edit-overlay" />
                <Dialog.Content
                  className="support-confirm-dialog"
                  onEscapeKeyDown={(event) => {
                    if (busy) event.preventDefault();
                  }}
                  onInteractOutside={(event) => {
                    if (busy) event.preventDefault();
                  }}
                >
                  <Dialog.Title>
                    {record.deleted ? t('고객지원 자료 복원') : t('휴지통으로 이동')}
                  </Dialog.Title>
                  <Dialog.Description>
                    “{policyPending ? t('선택한 자료') : record.title}
                    {t('” 자료를')}{' '}
                    {record.deleted
                      ? t('일반 목록으로 복원합니다.')
                      : t('휴지통으로 이동합니다. 관리자가 다시 복원할 수 있습니다.')}
                  </Dialog.Description>
                  {error && (
                    <p className="catalog-message is-error" role="alert">
                      {t(error)}
                    </p>
                  )}
                  <footer>
                    <button className="button" disabled={busy} onClick={() => setArchiveConfirm(false)}>
                      {t('취소')}
                    </button>
                    <button
                      className="button primary"
                      disabled={busy || policyPending}
                      onClick={async () => {
                        if (await onArchiveRestore()) setArchiveConfirm(false);
                      }}
                    >
                      {busy ? t('처리 중…') : record.deleted ? t('복원') : t('휴지통으로 이동')}
                    </button>
                  </footer>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SupportDiscussionEditor({
  target,
  busy,
  policyPending,
  error,
  onClose,
  onRestoreFocus,
  onSave,
  onDelete,
}: {
  target: DiscussionTarget;
  busy: boolean;
  policyPending: boolean;
  error: string;
  onClose: () => void;
  onRestoreFocus: () => void;
  onSave: (payload: { revision: number; body: string; title?: string }) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  useLocale();
  const label = target.kind === 'answers' ? '답변' : '댓글';
  const removing = target.mode === 'delete';
  const [body, setBody] = useState(target.masked ? '' : target.entry.body);
  const [title, setTitle] = useState(target.masked || !('title' in target.entry) ? '' : target.entry.title);
  const [titleChanged, setTitleChanged] = useState(false);
  const [localError, setLocalError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || policyPending) return;
    try {
      setLocalError('');
      if (removing) {
        if (await onDelete()) onClose();
      } else {
        const payload = prepareSupportDiscussionPatch(
          target.kind,
          target.revision,
          body,
          titleChanged ? title : undefined,
        );
        if (await onSave(payload)) onClose();
      }
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : '내용을 확인해 주세요.');
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="support-edit-overlay" />
        <Dialog.Content
          className={
            removing
              ? 'support-confirm-dialog'
              : 'dialog catalog-dialog support-edit-dialog support-discussion-dialog'
          }
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <header className={removing ? undefined : 'catalog-dialog-heading'}>
            <div>
              <Dialog.Title>
                {t(label)} {removing ? t('삭제') : t('수정')}
              </Dialog.Title>
              <Dialog.Description>
                {removing
                  ? t('선택한 {0}을 삭제합니다. 삭제 후에는 되돌릴 수 없습니다.', [t(label)])
                  : t('선택한 {0}의 내용을 수정합니다.', [t(label)])}
              </Dialog.Description>
            </div>
            {!removing && (
              <button
                className="icon-button"
                aria-label={t('{0} 수정 닫기', [t(label)])}
                disabled={busy}
                onClick={onClose}
              >
                <X size={20} />
              </button>
            )}
          </header>
          <form autoComplete="off" spellCheck={false} onSubmit={(event) => void submit(event)}>
            {!removing && (
              <div className="support-discussion-form">
                {target.masked && (
                  <p className="catalog-message">
                    {t(
                      '보호된 본문을 변경하려면 새 내용을 입력해 주세요. 답변 제목은 변경할 때만 입력합니다.',
                    )}
                  </p>
                )}
                {target.kind === 'answers' && (
                  <label className="catalog-form-field">
                    {t('답변 제목')}
                    <input
                      value={policyPending ? '' : title}
                      maxLength={300}
                      disabled={busy || policyPending}
                      placeholder={
                        target.masked ? t('현재 제목 유지 · 변경할 때만 입력') : t('답변 제목 (선택)')
                      }
                      onChange={(event) => {
                        setTitle(event.target.value);
                        setTitleChanged(true);
                      }}
                    />
                  </label>
                )}
                <label className="catalog-form-field">
                  {t(label)}
                  {t(' 내용')}
                  <textarea
                    rows={8}
                    maxLength={100000}
                    value={policyPending ? '' : body}
                    disabled={busy || policyPending}
                    placeholder={target.masked ? t('새 내용으로 변경') : t('{0} 내용', [t(label)])}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </label>
              </div>
            )}
            {(localError || error) && (
              <p className="catalog-message is-error" role="alert">
                {t(localError) || t(error)}
              </p>
            )}
            <footer className={removing ? undefined : 'catalog-dialog-footer'}>
              <button type="button" className="button" disabled={busy} onClick={onClose}>
                {t('취소')}
              </button>
              <button className="button primary" disabled={busy || policyPending}>
                {busy ? t('처리 중…') : t('{0} {1}', [t(label), removing ? t('삭제') : t('저장')])}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type SupportDraft = {
  title: string;
  body: string;
  companyId: string;
  status: SupportStatus;
  category: string;
  urgent: boolean;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  contactMobile: string;
  inquireType: string;
  answerPreference: string;
  mailRequested: boolean;
  assignee: string;
  visible: boolean;
  highlighted: boolean;
};
function SupportEditor({
  record,
  kind,
  companies,
  busy,
  policyPending,
  error,
  onClose,
  onRestoreFocus,
  onSave,
}: {
  record: SupportRecord | null;
  kind: SupportKind;
  companies: Company[];
  busy: boolean;
  policyPending: boolean;
  error: string;
  onClose: () => void;
  onRestoreFocus: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  useLocale();
  const [draft, setDraft] = useState<SupportDraft>(() => ({
    title: record?.title || '',
    body: record?.masked ? '' : record?.body || '',
    companyId: record?.companyId || '',
    status: record?.status || 'received',
    category: record?.category || '',
    urgent: record?.urgent || false,
    contactName: record?.masked ? '' : record?.contactName || '',
    contactEmail: record?.masked ? '' : record?.contactEmail || '',
    contactPhone: record?.masked ? '' : record?.contactPhone || '',
    contactMobile: record?.masked ? '' : record?.contactMobile || '',
    inquireType: record?.inquireType || '',
    answerPreference: record?.answerPreference || '',
    mailRequested: record?.mailRequested ?? false,
    assignee: record?.assignee || '',
    visible: record?.visible ?? true,
    highlighted: record?.highlighted || false,
  }));
  const [changed, setChanged] = useState<string[]>([]),
    [localError, setLocalError] = useState('');
  const [codeOptions, setCodeOptions] = useState<{ group: string; name: string }[]>([]);
  const [optionsError, setOptionsError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<{ items: { group: string; name: string; active: boolean }[] }>('/catalog/codes', {
      signal: controller.signal,
    })
      .then((result) => {
        if (
          !Array.isArray(result.items) ||
          !result.items.every((item) => typeof item.group === 'string' && typeof item.name === 'string')
        )
          throw new Error('선택 후보를 확인하지 못했습니다.');
        if (!controller.signal.aborted) setCodeOptions(result.items.filter((item) => item.active !== false));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setOptionsError('선택 후보를 불러오지 못했습니다. 값을 직접 입력할 수 있습니다.');
      });
    return () => controller.abort();
  }, []);
  const options = (group: string) =>
    Array.from(new Set(codeOptions.filter((item) => item.group === group).map((item) => item.name))).sort(
      (a, b) => a.localeCompare(b, 'ko'),
    );
  const change = (key: keyof SupportDraft, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setChanged((current) => (current.includes(key) ? current : [...current, key]));
  };
  const value = (key: keyof SupportDraft) =>
    policyPending && supportProtectedFields.some((field) => field === key) ? '' : String(draft[key]);
  const placeholder = (key: keyof SupportDraft) =>
    record?.masked && supportProtectedFields.some((field) => field === key)
      ? '현재 값 유지 · 변경할 때만 입력'
      : '';
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || policyPending) return;
    try {
      const payload = prepareSupportForm({ ...draft }, changed, record ? { ...record } : null);
      if (record && !Object.keys(payload).length) return onClose();
      setLocalError('');
      onSave(payload);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : '입력한 항목을 확인해 주세요.');
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="support-edit-overlay" />
        <Dialog.Content
          className="dialog catalog-dialog support-edit-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <header className="catalog-dialog-heading">
            <div>
              <Dialog.Title>
                {kind === 'tickets' ? t('문의') : t('공지')} {record ? t('수정') : t('등록')}
              </Dialog.Title>
              <Dialog.Description>
                {t('제목과 내용을 입력하고 필요한 업무 정보를 설정하세요.')}
              </Dialog.Description>
            </div>
            <button
              className="icon-button"
              aria-label={t('고객지원 편집 닫기')}
              disabled={busy}
              onClick={onClose}
            >
              <X size={19} />
            </button>
          </header>
          <form autoComplete="off" spellCheck={false} onSubmit={submit}>
            <div className="catalog-form-grid">
              <label className="catalog-form-field wide">
                {t('제목')}
                <input
                  required
                  autoFocus
                  maxLength={300}
                  value={policyPending ? '' : draft.title}
                  onChange={(event) => change('title', event.target.value)}
                  disabled={busy || policyPending}
                />
              </label>
              <label className="catalog-form-field">
                {t('고객사')}
                <select
                  value={draft.companyId}
                  onChange={(event) => change('companyId', event.target.value)}
                  disabled={busy}
                >
                  <option value="">{t('연결 없음')}</option>
                  {record?.companyId && !companies.some((company) => company.id === record.companyId) && (
                    <option value={record.companyId}>{t('기존 연결 고객사')}</option>
                  )}
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="catalog-form-field">
                {t('분류')}
                <input
                  maxLength={120}
                  value={draft.category}
                  list="support-category-options"
                  onChange={(event) => change('category', event.target.value)}
                  disabled={busy}
                  placeholder={t('분류 입력')}
                />
                <datalist id="support-category-options">
                  {options(kind === 'tickets' ? 'category_type' : 'notice_type').map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
              </label>
              {kind === 'tickets' && (
                <>
                  <label className="catalog-form-field">
                    {t('문의 유형')}
                    <input
                      maxLength={200}
                      list="support-inquire-options"
                      value={draft.inquireType}
                      onChange={(event) => change('inquireType', event.target.value)}
                      disabled={busy}
                      placeholder={t('선택하거나 직접 입력')}
                    />
                    <datalist id="support-inquire-options">
                      {options('inquire_type').map((value) => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                  </label>
                  <label className="catalog-form-field">
                    {t('희망 답변 방식')}
                    <input
                      maxLength={200}
                      list="support-answer-options"
                      value={draft.answerPreference}
                      onChange={(event) => change('answerPreference', event.target.value)}
                      disabled={busy}
                      placeholder={t('선택하거나 직접 입력')}
                    />
                    <datalist id="support-answer-options">
                      {options('hope_answer_type').map((value) => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                  </label>
                </>
              )}
              {optionsError && <p className="support-form-note">{t(optionsError)}</p>}
              <label className="catalog-form-field wide">
                {t('내용')}
                <textarea
                  required={!record}
                  rows={10}
                  maxLength={100000}
                  value={value('body')}
                  placeholder={t(placeholder('body')) || t('내용을 입력하세요.')}
                  onChange={(event) => change('body', event.target.value)}
                  disabled={busy || policyPending}
                />
                {record?.masked && <small>{t('기존 보호 내용은 입력하지 않으면 유지됩니다.')}</small>}
              </label>
              <label className="catalog-form-field">
                {t('담당자')}
                <input
                  maxLength={120}
                  value={draft.assignee}
                  onChange={(event) => change('assignee', event.target.value)}
                  disabled={busy}
                />
              </label>
              {kind === 'tickets' && (
                <label className="catalog-form-field">
                  {t('처리 상태')}
                  <select
                    value={draft.status}
                    onChange={(event) => change('status', event.target.value)}
                    disabled={busy}
                  >
                    {statuses.map(([key, label]) => (
                      <option key={key} value={key}>
                        {t(label)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(['contactName', 'contactEmail', 'contactPhone', 'contactMobile'] as const).map((key) => (
                <label className="catalog-form-field" key={key}>
                  {key === 'contactName'
                    ? t('연락처 이름')
                    : key === 'contactEmail'
                      ? t('이메일')
                      : key === 'contactMobile'
                        ? t('휴대폰')
                        : t('전화번호')}
                  <input
                    type={key === 'contactPhone' || key === 'contactMobile' ? 'tel' : 'text'}
                    inputMode={key === 'contactEmail' ? 'email' : undefined}
                    maxLength={200}
                    value={value(key)}
                    placeholder={t(placeholder(key))}
                    onChange={(event) => change(key, event.target.value)}
                    disabled={busy || policyPending}
                  />
                </label>
              ))}
              <div className="support-form-checks">
                <label className="catalog-active-field">
                  <input
                    type="checkbox"
                    checked={draft.urgent}
                    onChange={(event) => change('urgent', event.target.checked)}
                    disabled={busy}
                  />
                  {t('긴급')}
                </label>
                <label className="catalog-active-field">
                  <input
                    type="checkbox"
                    checked={draft.mailRequested}
                    onChange={(event) => change('mailRequested', event.target.checked)}
                    disabled={busy}
                    aria-describedby="support-mail-request-note"
                  />
                  {t('메일 발송 요청 기록')}
                </label>
                {kind === 'notices' && (
                  <>
                    <label className="catalog-active-field">
                      <input
                        type="checkbox"
                        checked={draft.visible}
                        onChange={(event) => change('visible', event.target.checked)}
                        disabled={busy}
                      />
                      {t('공지 표시')}
                    </label>
                    <label className="catalog-active-field">
                      <input
                        type="checkbox"
                        checked={draft.highlighted}
                        onChange={(event) => change('highlighted', event.target.checked)}
                        disabled={busy}
                      />
                      {t('상단 고정')}
                    </label>
                  </>
                )}
              </div>
              <p id="support-mail-request-note" className="support-form-note">
                {t('메일 요청 여부만 저장합니다. 이 화면에서 실제 이메일이나 푸시는 발송하지 않습니다.')}
              </p>
            </div>
            {(localError || error) && (
              <p className="catalog-message is-error" role="alert">
                {t(localError) || t(error)}
              </p>
            )}
            <footer className="catalog-dialog-footer">
              <button type="button" className="button" disabled={busy} onClick={onClose}>
                {t('취소')}
              </button>
              <button className="button primary" disabled={busy || policyPending}>
                {busy ? t('저장 중…') : t('저장')}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const supportAttachmentExtensions = [
  'txt',
  'properties',
  'xml',
  'json',
  'yaml',
  'yml',
  'ini',
  'conf',
  'cfg',
  'csv',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'zip',
  'docx',
  'xlsx',
  'pptx',
  'hwpx',
  'doc',
  'xls',
  'ppt',
  'hwp',
];
function SupportAttachments({
  record,
  canWrite,
  busy,
  policyPending,
  protectionEnabled,
  onUpload,
  onDelete,
}: {
  record: SupportRecord;
  canWrite: boolean;
  busy: boolean;
  policyPending: boolean;
  protectionEnabled: boolean;
  onUpload: (name: string, contentBase64: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  useLocale();
  const [selected, setSelected] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const operation = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const policy = useRef({ id: record.id, policyPending, protectionEnabled });
  policy.current = { id: record.id, policyPending, protectionEnabled };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      operation.current?.abort();
    };
  }, [record.id]);
  const disabled = busy || reading || Boolean(downloadBusy);
  const choose = (file: File | null) => {
    setSelected(null);
    setError('');
    setMessage('');
    if (!file) return;
    if (!file.size || file.size > 5 * 1024 * 1024) {
      setError('빈 파일은 등록할 수 없으며, 파일 크기는 5 MB 이하여야 합니다.');
      if (input.current) input.current.value = '';
      return;
    }
    if (!supportAttachmentExtensions.includes(file.name.split('.').pop()?.toLowerCase() || '')) {
      setError('지원하는 문서·이미지·설정 파일을 선택해 주세요.');
      if (input.current) input.current.value = '';
      return;
    }
    setSelected(file);
  };
  const upload = async () => {
    if (!selected || disabled || policyPending) return;
    setReading(true);
    setError('');
    setMessage('');
    try {
      const contentBase64 = await fileBase64(selected);
      if (!alive.current || policy.current.id !== record.id) return;
      if (await onUpload(selected.name, contentBase64)) {
        setSelected(null);
        if (input.current) input.current.value = '';
      }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : '파일을 등록하지 못했습니다.');
    } finally {
      if (alive.current) setReading(false);
    }
  };
  const download = async (attachment: Attachment) => {
    if (disabled || policyPending || protectionEnabled || !attachment.available) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setDownloadBusy(attachment.id);
    setError('');
    setMessage('');
    try {
      const done = await downloadInstallationFile(
        `/support/${encodeURIComponent(record.id)}/attachments/${encodeURIComponent(attachment.id)}/download`,
        attachment.name,
        { signal: controller.signal },
        () =>
          alive.current &&
          policy.current.id === record.id &&
          !policy.current.policyPending &&
          !policy.current.protectionEnabled,
      );
      if (alive.current)
        setMessage(
          done
            ? '브라우저 다운로드를 확인하세요.'
            : '보호 설정이 변경되거나 확인 중이어서 다운로드를 중단했습니다.',
        );
    } catch (reason) {
      if (alive.current && !controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '파일을 다운로드하지 못했습니다.');
    } finally {
      if (alive.current) {
        setDownloadBusy('');
        operation.current = null;
      }
    }
  };
  return (
    <section className="support-content-card">
      <header>
        <h3>
          <Paperclip size={16} />
          {t('첨부파일')}
        </h3>
        <span>
          {record.attachments.length}
          {t('개')}
        </span>
      </header>
      {canWrite && (
        <div className="support-upload">
          <label>
            <Upload size={16} />
            <span>{selected?.name || t('첨부할 파일 선택')}</span>
            <input
              ref={input}
              type="file"
              aria-label={t('고객지원 첨부파일 선택')}
              accept={supportAttachmentExtensions.map((value) => `.${value}`).join(',')}
              disabled={disabled || policyPending}
              onChange={(event) => choose(event.target.files?.[0] || null)}
            />
          </label>
          <button
            className="button"
            disabled={!selected || disabled || policyPending}
            onClick={() => void upload()}
          >
            {reading || busy ? t('등록 중…') : t('파일 등록')}
          </button>
          <small>{t('파일당 최대 5 MB · 문서, 이미지, 설정 파일')}</small>
        </div>
      )}
      <ul className="support-attachments">
        {record.attachments.length ? (
          record.attachments.map((file) => (
            <li key={file.id}>
              <File size={17} />
              <div>
                <strong>{file.name}</strong>
                <small>
                  {file.bytes > 0 ? `${(file.bytes / 1024).toFixed(1)} KB · ` : ''}
                  {file.available ? t('파일 등록됨') : t('원본 파일 미연결')}
                </small>
                <div className="support-attachment-actions">
                  <button
                    className="catalog-text-button"
                    disabled={!file.available || protectionEnabled || policyPending || disabled}
                    onClick={() => void download(file)}
                  >
                    <Download size={12} />
                    {downloadBusy === file.id ? t('다운로드 중…') : t('다운로드')}
                  </button>
                  {canWrite && file.available && (
                    <button
                      className="catalog-text-button"
                      disabled={disabled || policyPending}
                      onClick={() => setDeleting(file)}
                    >
                      <Trash2 size={12} />
                      {t('삭제')}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))
        ) : (
          <li className="support-empty-line">{t('등록된 첨부파일이 없습니다.')}</li>
        )}
      </ul>
      {(protectionEnabled || policyPending) && (
        <p className="support-attachment-hint">
          {policyPending
            ? t('보호 설정을 확인하고 있습니다.')
            : t('보호 기능이 꺼져 있는 관리자 계정에서만 등록된 파일을 다운로드할 수 있습니다.')}
        </p>
      )}
      {deleting && (
        <div className="support-file-confirm">
          <p>
            “{deleting.name}
            {t('” 파일을 삭제하시겠습니까?')}
          </p>
          <div>
            <button className="button" disabled={disabled} onClick={() => setDeleting(null)}>
              {t('취소')}
            </button>
            <button
              className="button"
              disabled={disabled || policyPending}
              onClick={async () => {
                if (await onDelete(deleting.id)) setDeleting(null);
              }}
            >
              {t('삭제')}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="catalog-message is-error" role="alert">
          {t(error)}
        </p>
      )}
      {message && (
        <p className="catalog-message" role="status">
          {t(message)}
        </p>
      )}
    </section>
  );
}
