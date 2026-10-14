import { installationFieldLabel, installationFieldValue, installationRowTitle } from './installation-labels';
import { canViewProtectedInformation } from './protection-policy';
import { canManageBusiness } from './permissions';
import { t } from './i18n';
import { useLocale } from './use-locale';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Building2,
  ChevronRight,
  CircleAlert,
  Database,
  FileCode2,
  FolderCog,
  KeyRound,
  LockKeyhole,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from './auth';
import { useWorkspaceSettings } from './workspace-settings';
import type { Company } from './types';
import type {
  InstallationDetails as InstallationDetailsDto,
  InstallationDetailField,
  InstallationDetailRow,
  InstallationDetailSection,
  InstallationSectionId,
} from './installation-types';
import { installationRequest } from './installation-api';
import {
  validateInstallationDetails,
  installationFieldMasked,
  installationRowCanDelete,
  visibleInstallationSection,
  prepareInstallationSection,
  type InstallationSectionDraft,
  type InstallationSectionChange,
} from './installation-client';
import InstallationRecordEditor, { type RowDraftPayload } from './InstallationRecordEditor';
import InstallationFiles from './InstallationFiles';
import InstallationSectionEditor from './InstallationSectionEditor';
import { InstallationDiscardDialog, InstallationEditorContext } from './InstallationEditorLayout';
import InstallationAccessNotes from './InstallationAccessNotes';
import { scrollInstallationContent } from './installation-scroll';
import { ArchiveButton } from './ArchivedPage';
import './installation-details.css';

type InstallationRecord = {
  id: string;
  companyName?: string;
  systemCode?: string;
  serviceVersion?: string;
  version?: string;
  engineer?: string;
  updatedAt?: string;
};
type Props = {
  record: InstallationRecord | null;
  companies: Company[];
  onClose: () => void;
  onEdit: () => void;
  onCompany: (id: string) => void;
  onRestoreFocus: () => void;
  onArchived?: () => void;
  onChanged?: () => void;
  notify?: (text: string, error?: boolean) => void;
  basicEditor?: ReactNode;
  basicBusy?: boolean;
  onBasicCancel?: () => void;
};
type VersionedDetails = InstallationDetailsDto & { revision: number };
type EditTarget = {
  scopeKey: string;
  revision: number;
  metadataRevision?: string;
  sectionId: InstallationSectionId;
  sectionTitle: string;
  row?: InstallationDetailRow;
};
const sectionConfig = [
  {
    id: 'installation',
    title: '설치 정보',
    icon: Settings2,
    description: '설치 이력과 서비스 운영의 기본 정보를 관리합니다.',
  },
  {
    id: 'access',
    title: '접근 정보',
    icon: Network,
    description: '연결 방식과 접속에 필요한 정보를 관리합니다.',
  },
  {
    id: 'server',
    title: '서버 정보',
    icon: Server,
    description: '서비스가 운영되는 서버와 환경 정보를 관리합니다.',
  },
  {
    id: 'yeta',
    title: 'YETA 로그인 정보',
    icon: KeyRound,
    description: 'YETA 서비스에 등록된 로그인 정보를 관리합니다.',
  },
  {
    id: 'sap',
    title: 'SAP 정보',
    icon: Database,
    description: 'SAP 연동에 필요한 시스템과 계정 정보를 관리합니다.',
  },
  {
    id: 'settings',
    title: '별도 설정 정보',
    icon: FolderCog,
    description: '이 설치에 적용되는 설정 값을 관리합니다.',
  },
  {
    id: 'files',
    title: '설정 파일',
    icon: FileCode2,
    description: '설정 파일을 생성하고 다운로드합니다.',
  },
] as const;

function DataValue({ field, policyPending }: { field: InstallationDetailField; policyPending: boolean }) {
  useLocale();
  if (!field.present) return <span className="installation-missing">{t('미등록')}</span>;
  if (installationFieldMasked(field, policyPending))
    return (
      <span className="installation-protected-value">
        <LockKeyhole size={13} aria-hidden="true" />
        <span className="installation-mask" aria-hidden="true">
          ••••••••
        </span>
        <span className="installation-protected-label">{t('보호됨')}</span>
      </span>
    );
  return (
    <span className={`installation-field-value ${/[\n\r]/.test(field.value) ? 'multiline' : ''}`}>
      {installationFieldValue(field) || <span className="installation-missing">{t('미등록')}</span>}
    </span>
  );
}

function RowActions({
  row,
  canManage,
  disabled,
  onEdit,
  onDelete,
}: {
  row: InstallationDetailRow;
  canManage: boolean;
  disabled: boolean;
  onEdit: (row: InstallationDetailRow) => void;
  onDelete: (row: InstallationDetailRow) => void;
}) {
  useLocale();
  if (!canManage) return null;
  return (
    <div className="installation-row-actions">
      <button
        type="button"
        className="button"
        aria-label={t('{0} 수정', [installationRowTitle(row) || t('기록')])}
        onClick={() => onEdit(row)}
        disabled={disabled}
      >
        <Pencil size={13} />
        {t('수정')}
      </button>
      {installationRowCanDelete(row) && (
        <button
          type="button"
          className="icon-button danger-text"
          aria-label={t('{0} 삭제', [installationRowTitle(row) || t('기록')])}
          onClick={() => onDelete(row)}
          disabled={disabled}
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}

function SectionRows({
  section,
  policyPending,
  canManage,
  busy,
  onEdit,
  onDelete,
  accessNotes,
  editingRowId,
  editor,
}: {
  section: InstallationDetailSection;
  policyPending: boolean;
  canManage: boolean;
  busy: boolean;
  onEdit: (row: InstallationDetailRow) => void;
  onDelete: (row: InstallationDetailRow) => void;
  accessNotes?: ReactNode;
  editingRowId?: string;
  editor?: ReactNode;
}) {
  useLocale();
  const notesAnchor = accessNotes
    ? section.rows
        .flatMap((row) => row.fields.map((field) => ({ row, field })))
        .find(({ field }) => field.key === 'access_etc')
    : undefined;
  const credentials = section.id === 'yeta' || section.id === 'sap';
  if (credentials || (section.id === 'files' && section.rows.length > 1)) {
    const columns = Array.from(
      new Map(section.rows.flatMap((row) => row.fields).map((field) => [field.key, field.label])).entries(),
    );
    return (
      <div className="installation-table-card">
        <div className="installation-card-heading">
          <span className="installation-small-icon">
            {section.id === 'yeta' ? (
              <KeyRound size={17} />
            ) : section.id === 'sap' ? (
              <Database size={17} />
            ) : (
              <FileCode2 size={17} />
            )}
          </span>
          <h3>{t(credentials ? section.title : '설정 키·값')}</h3>
          <span className="installation-count">
            {section.rows.length}
            {t('건')}
          </span>
        </div>
        <div
          className="installation-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={t(credentials ? '{0} 목록' : '시스템별 설정 값 표', [t(section.title)])}
        >
          <table className={`installation-data-table${credentials ? ' installation-credentials-table' : ''}`}>
            <thead>
              <tr>
                {credentials && <th scope="col">{t('기록')}</th>}
                {columns.map(([key, label]) => (
                  <th key={key} scope="col">
                    {installationFieldLabel({ key, label })}
                  </th>
                ))}
                {canManage && <th scope="col">{t('관리')}</th>}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.id} data-installation-row={row.id}>
                  {editingRowId === row.id && editor ? (
                    <td
                      colSpan={columns.length + (canManage ? 1 : 0) + (credentials ? 1 : 0)}
                      className="installation-inline-table-cell"
                    >
                      {editor}
                    </td>
                  ) : (
                    <>
                      {credentials && (
                        <td className="installation-record-title">{installationRowTitle(row)}</td>
                      )}
                      {columns.map(([key]) => (
                        <td key={key}>
                          {row.fields.find((field) => field.key === key) ? (
                            <DataValue
                              field={row.fields.find((field) => field.key === key)!}
                              policyPending={policyPending}
                            />
                          ) : (
                            <span className="installation-missing">{t('미등록')}</span>
                          )}
                        </td>
                      ))}
                      {canManage && (
                        <td>
                          <RowActions
                            row={row}
                            canManage
                            disabled={busy || policyPending}
                            onEdit={onEdit}
                            onDelete={onDelete}
                          />
                        </td>
                      )}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return (
    <div className="installation-cards">
      {section.rows.map((row, index) => (
        <section
          className={`installation-data-card${editingRowId === row.id ? ' is-editing' : ''}`}
          key={row.id}
          data-installation-row={row.id}
        >
          <header className="installation-card-heading">
            <span className="installation-small-icon">
              {section.id === 'server' ? (
                <Server size={17} />
              ) : section.id === 'sap' ? (
                <Database size={17} />
              ) : section.id === 'yeta' ? (
                <KeyRound size={17} />
              ) : (
                <Settings2 size={17} />
              )}
            </span>
            <h3>
              {installationRowTitle(row) ||
                (section.rows.length > 1 ? `${t(section.title)} ${index + 1}` : t(section.title))}
            </h3>
            <span className="installation-count">
              {section.rows.length > 1 ? `${index + 1} / ${section.rows.length}` : ''}
            </span>
            <RowActions
              row={row}
              canManage={canManage}
              disabled={busy || policyPending}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </header>
          {editingRowId === row.id && editor ? (
            <>
              {editor}
              {notesAnchor?.row.id === row.id && (
                <div className="installation-reference-field">{accessNotes}</div>
              )}
            </>
          ) : row.fields.length ? (
            <dl className="installation-fields">
              {row.fields.map((field) => (
                <Fragment key={field.id}>
                  <div
                    className={`installation-field ${
                      (section.id === 'installation' && (field.key === 'note' || field.key === 'ct_etc')) ||
                      field.value.length > 160 ||
                      /[\n\r]/.test(field.value)
                        ? 'wide'
                        : ''
                    }`}
                  >
                    <dt>
                      {installationFieldLabel(field)}
                      {(field.secret || field.masked) && <LockKeyhole size={12} aria-hidden="true" />}
                    </dt>
                    <dd>
                      <DataValue field={field} policyPending={policyPending} />
                    </dd>
                  </div>
                  {notesAnchor?.row.id === row.id && notesAnchor.field.id === field.id && (
                    <div className="installation-reference-field">
                      <dt className="sr-only">{t('참고사항')}</dt>
                      <dd>{accessNotes}</dd>
                    </div>
                  )}
                </Fragment>
              ))}
            </dl>
          ) : (
            <p className="installation-row-empty">{t('등록된 항목이 없습니다.')}</p>
          )}
        </section>
      ))}
      {accessNotes && !notesAnchor && accessNotes}
    </div>
  );
}

export default function InstallationDetails({
  record,
  companies,
  onClose,
  onEdit,
  onCompany,
  onRestoreFocus,
  onArchived,
  onChanged,
  notify,
  basicEditor,
  basicBusy = false,
  onBasicCancel,
}: Props) {
  useLocale();
  const { user, canWrite } = useAuth();
  const {
    settings,
    loading: settingsLoading,
    refreshing: settingsRefreshing,
    error: settingsError,
    refresh: refreshSettings,
  } = useWorkspaceSettings();
  const policyPending = !settings || settingsLoading || settingsRefreshing;
  const canViewProtected = canViewProtectedInformation(user);
  const protectionEnabled = (settings?.protectionEnabled ?? true) || !canViewProtected;
  const policyKey = settings ? `${settings.revision}:${settings.protectionEnabled}` : 'pending';
  const scopeKey = `${record?.id ?? ''}:${user?.id ?? ''}:${user?.role ?? ''}:${user?.status ?? ''}:${policyKey}`;
  const canManage = canManageBusiness(user);
  const [cached, setCached] = useState<{ scopeKey: string; details: VersionedDetails } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState<InstallationSectionId>('installation');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [sectionEditing, setSectionEditing] = useState<{
    scopeKey: string;
    sectionId: InstallationSectionId;
    details: VersionedDetails;
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    scopeKey: string;
    revision: number;
    row: InstallationDetailRow;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [status, setStatus] = useState('');
  const [editingDirty, setEditingDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [editorFooter, setEditorFooter] = useState<HTMLDivElement | null>(null);
  const operation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const identity = useRef({ scopeKey, policyPending });
  identity.current = { scopeKey, policyPending };
  const contentScroll = useRef<HTMLDivElement | null>(null);
  const visibleDetails = cached?.scopeKey === scopeKey ? cached.details : null;
  const visibleSectionEditing = sectionEditing?.scopeKey === scopeKey && canManage ? sectionEditing : null;
  const visibleEditing = editing?.scopeKey === scopeKey && canManage ? editing : null;
  const visibleDeleting =
    deleting?.scopeKey === scopeKey && canManage && installationRowCanDelete(deleting.row) ? deleting : null;
  const base = `/records/installations/${encodeURIComponent(record?.id ?? '')}`;
  const editingActive = Boolean(visibleEditing || visibleSectionEditing || basicEditor);
  const interactionBusy = busy || basicBusy;
  const returnToRow = useRef<string | null>(null);
  const previousEditing = useRef('');
  const basicEditButton = useRef<HTMLButtonElement>(null);
  const editingFocusKey = visibleSectionEditing
    ? 'section'
    : visibleEditing
      ? `${visibleEditing.sectionId}:${visibleEditing.row?.id ?? 'new'}`
      : basicEditor
        ? 'basic'
        : '';
  useEffect(() => {
    const previous = previousEditing.current;
    previousEditing.current = editingFocusKey;
    if (!editingFocusKey) {
      if (previous)
        requestAnimationFrame(() => {
          if (previous === 'basic' || previous === 'section')
            basicEditButton.current?.focus({ preventScroll: true });
          else
            Array.from(contentScroll.current?.querySelectorAll<HTMLElement>('[data-installation-row]') ?? [])
              .find((element) => element.dataset.installationRow === returnToRow.current)
              ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
              ?.focus({ preventScroll: true });
        });
      return;
    }
    const element = contentScroll.current?.querySelector<HTMLElement>(
      '.installation-inline-editor, .installation-basic-editor',
    );
    scrollInstallationContent(element, 'start');
    element
      ?.querySelector<HTMLInputElement>(
        'input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
      )
      ?.focus({ preventScroll: true });
  }, [editingFocusKey]);
  const discardEditing = () => {
    if (interactionBusy) return;
    setDiscardOpen(false);
    setEditingDirty(false);
    setEditing(null);
    setSectionEditing(null);
    setActionError('');
    if (basicEditor) onBasicCancel?.();
  };
  const cancelEditing = () => {
    if (interactionBusy) return;
    if (editingDirty) setDiscardOpen(true);
    else discardEditing();
  };

  useEffect(() => {
    setTab('installation');
    contentScroll.current?.scrollTo({ top: 0 });
  }, [record?.id]);
  useEffect(() => {
    ++generation.current;
    operation.current?.abort();
    setEditing(null);
    setSectionEditing(null);
    setDeleting(null);
    setActionError('');
    setStatus('');
    setBusy(false);
    setDiscardOpen(false);
    setEditingDirty(false);
    return () => {
      ++generation.current;
      operation.current?.abort();
    };
  }, [scopeKey]);
  useEffect(() => {
    if (!record?.id || policyPending) return;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    void installationRequest<VersionedDetails>(`${base}/details`, { signal: controller.signal })
      .then((value) => {
        if (!validateInstallationDetails(value, record.id))
          throw new Error('설치 상세 정보를 확인하지 못했습니다. 다시 불러와 주세요.');
        if (active && identity.current.scopeKey === scopeKey && !identity.current.policyPending)
          setCached({ scopeKey, details: value });
      })
      .catch((reason) => {
        if (active && !controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '설치 상세 정보를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [base, record?.id, record?.updatedAt, scopeKey, policyPending, retry]);
  useEffect(() => {
    const clear = () => {
      ++generation.current;
      operation.current?.abort();
      setCached(null);
      setEditing(null);
      setSectionEditing(null);
      setDeleting(null);
      setBusy(false);
      setDiscardOpen(false);
      setEditingDirty(false);
    };
    window.addEventListener('crm:unauthorized', clear);
    window.addEventListener('crm:permissions-changed', clear);
    return () => {
      window.removeEventListener('crm:unauthorized', clear);
      window.removeEventListener('crm:permissions-changed', clear);
    };
  }, []);

  const close = () => {
    ++generation.current;
    operation.current?.abort();
    setCached(null);
    setEditing(null);
    setSectionEditing(null);
    setDeleting(null);
    setDiscardOpen(false);
    setEditingDirty(false);
    onClose();
  };
  const mutate = async (
    path: string,
    method: string,
    body: Record<string, unknown>,
    success: string,
    revision: number,
  ): Promise<boolean> => {
    if (
      !canManage ||
      busy ||
      (operation.current && !operation.current.signal.aborted) ||
      policyPending ||
      !visibleDetails ||
      !record
    )
      return false;
    const controller = new AbortController();
    const token = ++generation.current;
    operation.current?.abort();
    operation.current = controller;
    setBusy(true);
    setActionError('');
    setStatus('');
    try {
      const result = await installationRequest<VersionedDetails>(path, {
        method,
        body: JSON.stringify({ ...body, revision }),
        signal: controller.signal,
      });
      if (!validateInstallationDetails(result, record.id))
        throw new Error('저장 응답을 확인하지 못했습니다. 다시 불러온 뒤 확인해 주세요.');
      if (token !== generation.current || identity.current.scopeKey !== scopeKey) return false;
      // A settings poll may be in flight; fetch again under the confirmed policy instead of reusing its response.
      if (!identity.current.policyPending) setCached({ scopeKey, details: result });
      else setRetry((value) => value + 1);
      setEditing(null);
      setSectionEditing(null);
      setDeleting(null);
      setStatus(success);
      onChanged?.();
      return true;
    } catch (reason) {
      if (token === generation.current && !controller.signal.aborted)
        setActionError(reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 확인해 주세요.');
      return false;
    } finally {
      if (token === generation.current) {
        setBusy(false);
        operation.current = null;
      }
    }
  };

  const saveSection = async (
    draft: InstallationSectionDraft,
    committed: (change: InstallationSectionChange) => void,
  ) => {
    if (
      !visibleSectionEditing ||
      !canManage ||
      interactionBusy ||
      policyPending ||
      !record ||
      (operation.current && !operation.current.signal.aborted)
    )
      return;
    let changes: InstallationSectionChange[];
    try {
      changes = prepareInstallationSection(
        visibleSectionEditing.details,
        visibleSectionEditing.sectionId,
        draft,
      );
      if (!changes.length) throw new Error('변경한 항목이 없습니다.');
    } catch (reason) {
      setActionError((reason as Error).message);
      return;
    }
    const controller = new AbortController();
    const token = ++generation.current;
    operation.current = controller;
    setBusy(true);
    setActionError('');
    setStatus('');
    let latest = visibleSectionEditing.details;
    let saved = 0;
    try {
      // Keep the existing per-record permissions and compare-and-swap contract.
      // A failure retains remaining drafts; only acknowledged records are cleared.
      for (const change of changes) {
        if (
          token !== generation.current ||
          identity.current.scopeKey !== scopeKey ||
          identity.current.policyPending
        )
          throw new Error('보호 설정을 확인한 뒤 다시 저장해 주세요.');
        const path = change.kind === 'note' ? 'access-notes' : 'rows';
        const result = await installationRequest<VersionedDetails>(
          `${base}/${path}/${encodeURIComponent(change.id)}`,
          {
            method: 'PATCH',
            signal: controller.signal,
            body: JSON.stringify({
              ...change.body,
              revision: latest.revision,
              ...(change.metadata ? { metadataRevision: latest.metadataRevision } : {}),
            }),
          },
        );
        if (!validateInstallationDetails(result, record.id))
          throw new Error('저장 응답을 확인하지 못했습니다. 다시 불러온 뒤 확인해 주세요.');
        if (token !== generation.current || identity.current.scopeKey !== scopeKey) return;
        latest = result;
        saved++;
        committed(change);
        setSectionEditing((current) =>
          current?.scopeKey === scopeKey ? { ...current, details: result } : current,
        );
        if (!identity.current.policyPending) setCached({ scopeKey, details: result });
      }
      setSectionEditing(null);
      setStatus('현재 탭의 정보를 저장했습니다.');
    } catch (reason) {
      if (token === generation.current && !controller.signal.aborted) {
        const message = reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 확인해 주세요.';
        setActionError(
          saved
            ? `${t('일부 기록은 저장되었습니다. 나머지 입력 내용은 유지됩니다.')} ${t(message)}`
            : message,
        );
      }
    } finally {
      if (token === generation.current) {
        operation.current = null;
        setBusy(false);
        if (saved) onChanged?.();
      }
    }
  };

  if (!record) return null;
  const activeConfig = sectionConfig.find((config) => config.id === tab)!;
  const editor = visibleEditing ? (
    <InstallationRecordEditor
      key={`${scopeKey}:${visibleEditing.row?.id || 'new'}:${visibleEditing.sectionId}`}
      sectionId={visibleEditing.sectionId}
      sectionTitle={visibleEditing.sectionTitle}
      row={visibleEditing.row}
      busy={busy}
      error={actionError}
      policyPending={policyPending}
      onClose={cancelEditing}
      onSave={(payload: RowDraftPayload) =>
        void mutate(
          visibleEditing.row ? `${base}/rows/${encodeURIComponent(visibleEditing.row.id)}` : `${base}/rows`,
          visibleEditing.row ? 'PATCH' : 'POST',
          {
            ...payload,
            ...(!visibleEditing.row ? { sectionId: visibleEditing.sectionId } : {}),
            ...(visibleEditing.row?.managed === 'metadata'
              ? { metadataRevision: visibleEditing.metadataRevision }
              : {}),
          },
          `${visibleEditing.sectionTitle} 기록을 저장했습니다.`,
          visibleEditing.revision,
        )
      }
    />
  ) : undefined;
  let content: ReactNode;
  if (!settings && settingsError && !settingsLoading)
    content = (
      <div className="installation-loading">
        <CircleAlert size={30} />
        <h3>{t('보호 설정을 확인하지 못했습니다.')}</h3>
        <p role="alert">{t(settingsError)}</p>
        <button
          className="button"
          disabled={settingsRefreshing}
          onClick={() => void refreshSettings().catch(() => {})}
        >
          <RefreshCw size={15} />
          {t('다시 확인')}
        </button>
      </div>
    );
  else if (!visibleDetails && (!error || loading))
    content = (
      <div className="installation-loading" role="status">
        <RefreshCw size={25} className="auth-spin" />
        <strong>{t('설치 상세 정보를 불러오고 있습니다.')}</strong>
        <span>{policyPending ? t('보호 설정을 확인합니다.') : t('운영 정보를 확인합니다.')}</span>
      </div>
    );
  else if (!visibleDetails && error)
    content = (
      <div className="installation-loading">
        <CircleAlert size={30} />
        <h3>{t('상세 정보를 불러오지 못했습니다.')}</h3>
        <p role="alert">{t(error)}</p>
        <button className="button" onClick={() => setRetry((value) => value + 1)}>
          <RefreshCw size={15} />
          {t('다시 불러오기')}
        </button>
      </div>
    );
  else
    content = sectionConfig.map((config) => {
      const section = visibleInstallationSection(
        visibleDetails!.sections.find((item) => item.id === config.id)!,
      );
      const accessNotes =
        config.id === 'access' ? (
          <InstallationAccessNotes
            key={scopeKey}
            notes={visibleDetails!.accessNotes ?? []}
            revision={visibleDetails!.revision}
            canManage={canManage}
            busy={busy || editingActive}
            policyPending={policyPending}
            onCreate={(value, revision) =>
              mutate(`${base}/access-notes`, 'POST', { content: value }, '참고사항을 등록했습니다.', revision)
            }
            onUpdate={(noteId, value, revision) =>
              mutate(
                `${base}/access-notes/${encodeURIComponent(noteId)}`,
                'PATCH',
                { content: value },
                '참고사항을 수정했습니다.',
                revision,
              )
            }
            onDelete={(noteId, revision) =>
              mutate(
                `${base}/access-notes/${encodeURIComponent(noteId)}`,
                'DELETE',
                {},
                '참고사항을 삭제했습니다.',
                revision,
              )
            }
            error={actionError}
          />
        ) : undefined;
      return (
        <Tabs.Content
          key={config.id}
          value={config.id}
          className={
            'installation-tab-panel' +
            (visibleSectionEditing?.sectionId === config.id ? ' is-group-editing' : '')
          }
        >
          <div className="installation-section-heading">
            <div>
              <span className="installation-section-kicker">
                {config.id === 'files' ? 'CONFIGURATION FILE' : 'OPERATION DETAILS'}
              </span>
              <h2>{t(config.title)}</h2>
              <p>{t(config.description)}</p>
            </div>
            {config.id !== 'files' && (
              <div className="installation-section-actions">
                {section.rows.length > 0 && (
                  <span className="installation-section-count">
                    {section.rows.length}
                    {t('개 기록')}
                  </span>
                )}
                {canManage && (
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || policyPending || editingActive}
                    onClick={() => {
                      setActionError('');
                      setEditing({
                        scopeKey,
                        revision: visibleDetails!.revision,
                        sectionId: config.id,
                        sectionTitle: config.title,
                      });
                    }}
                  >
                    <Plus size={15} />
                    {t('기록 추가')}
                  </button>
                )}
              </div>
            )}
          </div>
          {config.id === 'files' ? (
            <InstallationFiles
              key={`${record.id}:${policyKey}`}
              installationId={record.id}
              systemCode={record.systemCode || ''}
              configurationRows={section.rows}
              policyKey={policyKey}
              policyPending={policyPending}
              protectionEnabled={protectionEnabled}
              canManage={canManage && !editingActive}
            />
          ) : visibleSectionEditing?.sectionId === config.id ? (
            <InstallationSectionEditor
              key={`${scopeKey}:${config.id}`}
              details={visibleSectionEditing.details}
              sectionId={config.id}
              busy={busy}
              policyPending={policyPending}
              error={actionError}
              onClose={cancelEditing}
              onSave={saveSection}
            />
          ) : (
            <>
              {visibleEditing?.sectionId === config.id && !visibleEditing.row && editor}
              {section.rows.length ? (
                <SectionRows
                  section={section}
                  policyPending={policyPending}
                  canManage={canManage}
                  busy={busy || editingActive}
                  accessNotes={accessNotes}
                  editingRowId={visibleEditing?.row?.id}
                  editor={editor}
                  onEdit={(row) => {
                    setActionError('');
                    returnToRow.current = row.id;
                    setEditing({
                      scopeKey,
                      revision: visibleDetails!.revision,
                      metadataRevision: visibleDetails!.metadataRevision,
                      sectionId: config.id,
                      sectionTitle: config.title,
                      row,
                    });
                  }}
                  onDelete={(row) => {
                    if (!installationRowCanDelete(row)) return;
                    setActionError('');
                    setDeleting({ scopeKey, revision: visibleDetails!.revision, row });
                  }}
                />
              ) : (
                <div className="installation-empty">
                  <span>
                    <FolderCog size={30} strokeWidth={1.4} />
                  </span>
                  <h3>
                    {t('등록된 ')}
                    {t('{0}가', [t(config.title)])}
                    {t(' 없습니다.')}
                  </h3>
                  <p>
                    {canManage
                      ? t('기록 추가를 눌러 필요한 정보를 등록하세요.')
                      : t('등록된 정보가 있으면 이곳에 표시됩니다.')}
                  </p>
                </div>
              )}
              {!section.rows.length && accessNotes}
            </>
          )}
        </Tabs.Content>
      );
    });

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !interactionBusy && !editingActive) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay installation-overlay" />
        <Dialog.Content
          className={'installation-dialog' + (editingActive ? ' is-editing' : '')}
          onEscapeKeyDown={(event) => {
            if (interactionBusy || editingActive) {
              event.preventDefault();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && editingActive && !discardOpen && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              cancelEditing();
            }
          }}
          onInteractOutside={(event) => {
            if (editingActive || interactionBusy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus();
          }}
        >
          <InstallationEditorContext.Provider
            value={{ footer: editorFooter, setDirty: setEditingDirty, cancel: cancelEditing }}
          >
            <header className="installation-header">
              <span className="installation-header-icon">
                <Server size={26} strokeWidth={1.6} />
              </span>
              <div className="installation-header-title">
                <span>INSTALLATION DETAILS</span>
                <Dialog.Title>{record.systemCode || t('설치 상세 정보')}</Dialog.Title>
                <Dialog.Description>{t('설치 정보와 서비스 운영 설정을 확인하세요.')}</Dialog.Description>
              </div>
              <div className="installation-header-actions">
                <button
                  className="icon-button"
                  aria-label={editingActive ? t('수정 취소') : t('설치 상세 닫기')}
                  onClick={editingActive ? cancelEditing : close}
                  disabled={interactionBusy}
                >
                  <X size={22} />
                </button>
              </div>
            </header>
            <div className="installation-context">
              <div className="installation-companies">
                <Building2 size={15} />
                <span className="installation-context-label">{t('고객사')}</span>
                {companies.length ? (
                  companies.map((company) => (
                    <button
                      key={company.id}
                      disabled={interactionBusy || editingActive}
                      onClick={() => {
                        ++generation.current;
                        operation.current?.abort();
                        setCached(null);
                        onCompany(company.id);
                      }}
                    >
                      {company.name}
                      <ChevronRight size={13} />
                    </button>
                  ))
                ) : record.companyName ? (
                  <span className="installation-company-name">{record.companyName}</span>
                ) : (
                  <span className="installation-context-empty">{t('고객사 연결 없음')}</span>
                )}
              </div>
              {canWrite && !editingActive && (
                <button
                  className="button"
                  disabled={interactionBusy || policyPending}
                  onClick={() => {
                    setTab('installation');
                    onEdit();
                  }}
                >
                  {t('고객사 변경')}
                </button>
              )}
              <div className="installation-context-meta">
                <span>
                  <small>{t('서비스')}</small>
                  <strong>{record.serviceVersion || t('미등록')}</strong>
                </span>
                <span>
                  <small>{t('버전')}</small>
                  <strong>{record.version || t('미등록')}</strong>
                </span>
                <span>
                  <small>{t('엔지니어')}</small>
                  <strong>{record.engineer || t('미등록')}</strong>
                </span>
                <button
                  className="icon-button"
                  aria-label={t('설치 상세 다시 불러오기')}
                  disabled={interactionBusy || policyPending || loading || editingActive}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  <RefreshCw size={14} className={loading ? 'auth-spin' : ''} />
                </button>
              </div>
            </div>
            <Tabs.Root
              value={tab}
              onValueChange={(value) => {
                if (editingActive || interactionBusy) return;
                setTab(value as InstallationSectionId);
                contentScroll.current?.scrollTo({ top: 0 });
              }}
              className="installation-tabs"
            >
              <div className="installation-tab-bar">
                <Tabs.List className="installation-tab-list" aria-label={t('설치 상세 정보 탭')}>
                  {sectionConfig.map(({ id, title, icon: Icon }) => (
                    <Tabs.Trigger
                      key={id}
                      value={id}
                      className="installation-tab"
                      disabled={editingActive || interactionBusy}
                    >
                      <Icon size={16} />
                      {t(title)}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              </div>
              <div className="installation-content-scroll" ref={contentScroll}>
                {status && (
                  <p className="installation-action-status installation-global-message" role="status">
                    {t(status)}
                  </p>
                )}
                {error && visibleDetails && (
                  <p className="installation-action-error installation-global-message" role="alert">
                    {t(error)}
                    <button className="button" onClick={() => setRetry((value) => value + 1)}>
                      {t('다시 불러오기')}
                    </button>
                  </p>
                )}
                {basicEditor ? <div className="installation-tab-panel">{basicEditor}</div> : content}
              </div>
            </Tabs.Root>
            <footer className="installation-footer">
              {editingActive ? (
                <div className="installation-editor-actions-host" ref={setEditorFooter} />
              ) : (
                <>
                  <div className="installation-footer-info">
                    <ShieldCheck size={15} />
                    <span>
                      {policyPending
                        ? t('보호 설정 확인 중')
                        : !canViewProtected
                          ? t('보호 정보 원문은 관리자와 담당자가 열람할 수 있습니다.')
                          : protectionEnabled
                            ? t('환경설정에 따라 민감한 정보를 보호하고 있습니다.')
                            : t('보호 정보 원문을 표시하고 있습니다.')}
                    </span>
                  </div>
                  <div className="installation-footer-actions">
                    {canManage && !interactionBusy && !editingActive && onArchived && notify && (
                      <ArchiveButton
                        area="installations"
                        id={record.id}
                        title={record.systemCode || t('설치 정보')}
                        onArchived={() => {
                          close();
                          onArchived();
                        }}
                        notify={notify}
                      />
                    )}
                    <button
                      className="button"
                      onClick={editingActive ? cancelEditing : close}
                      disabled={interactionBusy}
                    >
                      {editingActive ? t('수정 취소') : t('닫기')}
                    </button>
                    {canWrite && !editingActive && tab !== 'files' && (
                      <button
                        ref={basicEditButton}
                        className="button primary"
                        disabled={
                          interactionBusy ||
                          policyPending ||
                          loading ||
                          !visibleDetails ||
                          (!canManage && tab !== 'installation')
                        }
                        onClick={() => {
                          if (canManage && visibleDetails) {
                            setActionError('');
                            setStatus('');
                            setSectionEditing({ scopeKey, sectionId: tab, details: visibleDetails });
                          } else onEdit();
                        }}
                      >
                        <Pencil size={15} />
                        {t('정보 수정')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </footer>
            {visibleDeleting && (
              <Dialog.Root
                open
                onOpenChange={(open) => {
                  if (!open && !busy) setDeleting(null);
                }}
              >
                <Dialog.Portal>
                  <Dialog.Overlay className="installation-edit-overlay" />
                  <Dialog.Content
                    className="installation-confirm-dialog"
                    onEscapeKeyDown={(event) => {
                      if (busy) event.preventDefault();
                    }}
                    onInteractOutside={(event) => event.preventDefault()}
                  >
                    <Dialog.Title>{t('기록 삭제')}</Dialog.Title>
                    <Dialog.Description>
                      <strong>{installationRowTitle(visibleDeleting.row) || t(activeConfig.title)}</strong>
                      {t(' 기록을 삭제하시겠습니까?')}
                    </Dialog.Description>
                    {actionError && (
                      <p className="installation-action-error" role="alert">
                        {t(actionError)}
                      </p>
                    )}
                    <div>
                      <button className="button" disabled={busy} onClick={() => setDeleting(null)}>
                        {t('취소')}
                      </button>
                      <button
                        className="button danger"
                        disabled={busy || policyPending}
                        onClick={() =>
                          void mutate(
                            `${base}/rows/${encodeURIComponent(visibleDeleting.row.id)}`,
                            'DELETE',
                            {},
                            '기록을 삭제했습니다.',
                            visibleDeleting.revision,
                          )
                        }
                      >
                        {busy ? t('삭제 중…') : t('기록 삭제')}
                      </button>
                    </div>
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
            )}
            <InstallationDiscardDialog
              open={discardOpen && editingActive && !policyPending}
              onOpenChange={setDiscardOpen}
              onDiscard={discardEditing}
            />
          </InstallationEditorContext.Provider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
