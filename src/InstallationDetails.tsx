import { installationFieldLabel, installationFieldValue, installationRowTitle } from './installation-labels';
import { canViewProtectedInformation } from './protection-policy';
import { canManageBusiness } from './permissions';
import { t } from './i18n';
import { useLocale } from './use-locale';
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { installationRequest, InstallationRequestError } from './installation-api';
import {
  installationCodeGroupForField,
  installationCodeGroupsQuery,
  installationOptionDisplayValue,
  installationOptionNameKey,
  InstallationOptionRegistrationController,
  parseInstallationCodeOptions,
  type InstallationOptionRegistrationTarget,
  type InstallationCodeGroup,
  type InstallationCodeOption,
} from './installation-code-options';
import { runInstallationSavePlan } from './installation-save-flow';
import {
  validateInstallationDetails,
  installationFieldMasked,
  visibleInstallationSection,
  prepareInstallationSectionOperations,
  type InstallationSectionDraft,
  type InstallationSectionOperation,
  type RowDraftPayload,
} from './installation-client';
import InstallationFiles from './InstallationFiles';
import InstallationRecordEditor from './InstallationRecordEditor';
import InstallationSectionEditor from './InstallationSectionEditor';
import { InstallationDiscardDialog, InstallationEditorContext } from './InstallationEditorLayout';
import InstallationAccessNotes from './InstallationAccessNotes';
import { scrollInstallationContent } from './installation-scroll';
import { ArchiveButton } from './ArchivedPage';
import './installation-details.css';

async function loadInstallationCodeOptions(signal?: AbortSignal) {
  const response = await installationRequest<unknown>(
    `/catalog/codes?groups=${encodeURIComponent(installationCodeGroupsQuery)}`,
    { signal },
  );
  const options = parseInstallationCodeOptions(response);
  if (!options) throw new Error('공용 선택지 목록의 응답을 확인하지 못했습니다.');
  return options;
}

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

function DataValue({
  sectionId,
  field,
  policyPending,
  codeOptions,
}: {
  sectionId: InstallationSectionId;
  field: InstallationDetailField;
  policyPending: boolean;
  codeOptions: readonly InstallationCodeOption[];
}) {
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
      {installationOptionDisplayValue(
        codeOptions,
        installationCodeGroupForField(sectionId, field.key, field.label),
        installationFieldValue(field),
        field.optionValue,
      ) || <span className="installation-missing">{t('미등록')}</span>}
    </span>
  );
}

function passwordField(field: { key: string; label: string }) {
  return /pwd|password|passwd|비밀번호|비번|패스워드/i.test(`${field.key} ${field.label}`);
}

/** Prefer access_url. Workspace rows omit it, so use domainurl, the access section's URL field. */
function accessListAddress(fields: readonly InstallationDetailField[]) {
  const url = fields.find((field) => field.key === 'access_url');
  if (url) return passwordField(url) ? undefined : url;
  const domain = fields.find((field) => field.key === 'domainurl');
  return domain && !passwordField(domain) ? domain : undefined;
}

function AccessListCell({
  field,
  policyPending,
  codeOptions,
}: {
  field: InstallationDetailField | undefined;
  policyPending: boolean;
  codeOptions: readonly InstallationCodeOption[];
}) {
  if (!field || passwordField(field)) return <span className="installation-missing">{t('미등록')}</span>;
  return (
    <DataValue sectionId="access" field={field} policyPending={policyPending} codeOptions={codeOptions} />
  );
}

function AccessRecordList({
  rows,
  sourceRows,
  selectedId,
  policyPending,
  codeOptions,
  canManage,
  locked,
  onSelect,
  onAdd,
}: {
  rows: InstallationDetailRow[];
  sourceRows: InstallationDetailRow[];
  selectedId: string;
  policyPending: boolean;
  codeOptions: readonly InstallationCodeOption[];
  canManage: boolean;
  locked: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  useLocale();
  const source = new Map(sourceRows.map((row) => [row.id, row]));
  const fieldsOf = (row: InstallationDetailRow) => source.get(row.id)?.fields ?? row.fields;
  const spoken = (field: InstallationDetailField | undefined) => {
    if (!field || !field.present || passwordField(field)) return t('미등록');
    if (installationFieldMasked(field, policyPending)) return t('보호됨');
    return (
      installationOptionDisplayValue(
        codeOptions,
        installationCodeGroupForField('access', field.key, field.label),
        installationFieldValue(field),
        field.optionValue,
      ) || t('미등록')
    );
  };
  return (
    <div className="installation-table-card">
      <div className="installation-card-heading">
        <span className="installation-small-icon">
          <Network size={17} />
        </span>
        <h3>{t('접근 정보')}</h3>
        <span className="installation-count">
          {rows.length}
          {t('건')}
        </span>
        {canManage && (
          <div className="installation-row-actions">
            <button type="button" className="button" disabled={locked} onClick={onAdd}>
              <Plus size={14} />
              {t('{0} 추가', [t('접근 정보')])}
            </button>
          </div>
        )}
      </div>
      <div className="installation-table-scroll">
        <table
          className="installation-data-table installation-access-list"
          role="grid"
          aria-label={t('{0} 목록', [t('접근 정보')])}
        >
          <thead>
            <tr>
              <th scope="col">{t('구분명')}</th>
              <th scope="col">{t('접근 유형')}</th>
              <th scope="col">{t('접속 주소')}</th>
              <th scope="col">{t('접근 종료일')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const fields = fieldsOf(row);
              const typeField = fields.find((field) => field.key === 'access_type');
              const addressField = accessListAddress(fields);
              const endField = fields.find((field) => field.key === 'access_reqst_enddate');
              const title = installationRowTitle(row) || t('미등록');
              const label = [
                `${t('구분명')} ${title}`,
                `${t('접근 유형')} ${spoken(typeField)}`,
                `${t('접속 주소')} ${spoken(addressField)}`,
                `${t('접근 종료일')} ${spoken(endField)}`,
              ].join(', ');
              return (
                <tr
                  key={row.id}
                  role="row"
                  tabIndex={0}
                  aria-selected={row.id === selectedId}
                  aria-label={label}
                  className={row.id === selectedId ? 'is-selected' : undefined}
                  onClick={() => onSelect(row.id)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onSelect(row.id);
                  }}
                >
                  <td>{title}</td>
                  <td>
                    <AccessListCell
                      field={typeField}
                      policyPending={policyPending}
                      codeOptions={codeOptions}
                    />
                  </td>
                  <td>
                    <AccessListCell
                      field={addressField}
                      policyPending={policyPending}
                      codeOptions={codeOptions}
                    />
                  </td>
                  <td>
                    <AccessListCell
                      field={endField}
                      policyPending={policyPending}
                      codeOptions={codeOptions}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionRows({
  section,
  policyPending,
  accessNotes,
  codeOptions,
  actions,
}: {
  section: InstallationDetailSection;
  policyPending: boolean;
  accessNotes?: ReactNode;
  codeOptions: readonly InstallationCodeOption[];
  actions?: ReactNode;
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
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.id} data-installation-row={row.id}>
                  {credentials && <td className="installation-record-title">{installationRowTitle(row)}</td>}
                  {columns.map(([key]) => (
                    <td key={key}>
                      {row.fields.find((field) => field.key === key) ? (
                        <DataValue
                          sectionId={section.id}
                          field={row.fields.find((field) => field.key === key)!}
                          policyPending={policyPending}
                          codeOptions={codeOptions}
                        />
                      ) : (
                        <span className="installation-missing">{t('미등록')}</span>
                      )}
                    </td>
                  ))}
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
        <section className="installation-data-card" key={row.id} data-installation-row={row.id}>
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
            {actions && <div className="installation-row-actions">{actions}</div>}
          </header>
          {row.fields.length ? (
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
                      <DataValue
                        sectionId={section.id}
                        field={field}
                        policyPending={policyPending}
                        codeOptions={codeOptions}
                      />
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
  const [codeOptions, setCodeOptions] = useState<InstallationCodeOption[]>([]);
  const [codeOptionsLoading, setCodeOptionsLoading] = useState(false);
  const [codeOptionsError, setCodeOptionsError] = useState('');
  const [codeOptionsRetry, setCodeOptionsRetry] = useState(0);
  const optionRegistrationsController = useRef<InstallationOptionRegistrationController | null>(null);
  if (!optionRegistrationsController.current)
    optionRegistrationsController.current = new InstallationOptionRegistrationController();
  const optionRegistrations = useSyncExternalStore(
    optionRegistrationsController.current.subscribe,
    optionRegistrationsController.current.getSnapshot,
    optionRegistrationsController.current.getSnapshot,
  );
  const [tab, setTab] = useState<InstallationSectionId>('installation');
  const [sectionEditing, setSectionEditing] = useState<{
    scopeKey: string;
    sectionId: InstallationSectionId;
    details: VersionedDetails;
  } | null>(null);
  const [accessRecordEdit, setAccessRecordEdit] = useState<
    { scopeKey: string; mode: 'create' } | { scopeKey: string; mode: 'edit'; rowId: string } | null
  >(null);
  const [accessRowId, setAccessRowId] = useState('');
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
  const base = `/records/installations/${encodeURIComponent(record?.id ?? '')}`;
  const accessEdit = accessRecordEdit?.scopeKey === scopeKey && canManage ? accessRecordEdit : null;
  const accessEditRowId = accessEdit?.mode === 'edit' ? accessEdit.rowId : '';
  const accessEditActive = Boolean(
    accessEdit &&
    (accessEdit.mode === 'create' ||
      visibleDetails?.sections.some(
        (item) =>
          item.id === 'access' &&
          visibleInstallationSection(item).rows.some((row) => row.id === accessEditRowId),
      )),
  );
  const editingActive = Boolean(visibleSectionEditing || basicEditor || accessEditActive);
  const interactionBusy = busy || basicBusy;
  const previousEditing = useRef('');
  const basicEditButton = useRef<HTMLButtonElement>(null);
  const editingFocusKey = visibleSectionEditing
    ? 'section'
    : accessEditActive
      ? 'record'
      : basicEditor
        ? 'basic'
        : '';
  useEffect(() => {
    const previous = previousEditing.current;
    previousEditing.current = editingFocusKey;
    if (!editingFocusKey) {
      if (previous)
        requestAnimationFrame(() => {
          basicEditButton.current?.focus({ preventScroll: true });
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
    setSectionEditing(null);
    setAccessRecordEdit(null);
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
    setSectionEditing(null);
    setAccessRecordEdit(null);
    setAccessRowId('');
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
    if (!record?.id) return;
    const controller = new AbortController();
    let active = true;
    setCodeOptionsLoading(true);
    setCodeOptionsError('');
    setCodeOptions([]);
    void loadInstallationCodeOptions(controller.signal)
      .then((items) => {
        if (active && identity.current.scopeKey === scopeKey) setCodeOptions(items);
      })
      .catch((reason) => {
        if (active && !controller.signal.aborted) {
          setCodeOptionsError(
            reason instanceof Error ? reason.message : '공용 선택지 목록을 불러오지 못했습니다.',
          );
        }
      })
      .finally(() => {
        if (active) setCodeOptionsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [record?.id, scopeKey, codeOptionsRetry]);
  useEffect(() => {
    const clear = () => {
      ++generation.current;
      operation.current?.abort();
      setCached(null);
      setSectionEditing(null);
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

  const canAddSharedOptions = user?.role === 'admin' && user.status === 'active';
  const createSharedInstallationOption = async (group: InstallationCodeGroup, name: string) => {
    const response = await installationRequest<{ item: unknown; created: boolean }>(
      '/catalog/codes/installation-options',
      {
        method: 'POST',
        body: JSON.stringify({ group, name }),
        preserveDraftOnPermissionDenied: true,
      },
    );
    const parsed = parseInstallationCodeOptions({ items: [response.item] });
    const created = parsed?.[0];
    if (
      !created ||
      created.group !== group ||
      installationOptionNameKey(created.name) !== installationOptionNameKey(name)
    )
      throw new InstallationRequestError('공용 선택지 응답을 확인하지 못했습니다.', 'uncertain');
    return created;
  };
  const addSharedInstallationOption = async (
    group: InstallationCodeGroup,
    name: string,
    target: InstallationOptionRegistrationTarget,
  ) => {
    if (!canAddSharedOptions) throw new Error('공용 선택지를 추가하려면 관리자 권한이 필요합니다.');
    const option = await optionRegistrationsController.current!.register({
      group,
      name,
      draftName: name,
      target,
      create: () => createSharedInstallationOption(group, name),
      isDefiniteFailure: (reason) =>
        reason instanceof InstallationRequestError && reason.outcome === 'rejected',
    });
    if (option) {
      setCodeOptions((current) => [
        ...current.filter((item) => !(item.group === option.group && item.code === option.code)),
        option,
      ]);
    }
    return option;
  };
  const confirmSharedInstallationOption = (id: string) => {
    void optionRegistrationsController.current!.confirm(id, loadInstallationCodeOptions, (options) =>
      setCodeOptions([...options]),
    );
  };
  const retrySharedInstallationOption = (id: string) => {
    void optionRegistrationsController.current!.retry(
      id,
      createSharedInstallationOption,
      (reason) => reason instanceof InstallationRequestError && reason.outcome === 'rejected',
      (option) =>
        setCodeOptions((current) => [
          ...current.filter((item) => !(item.group === option.group && item.code === option.code)),
          option,
        ]),
    );
  };
  const dismissSharedInstallationOption = (id: string, target: InstallationOptionRegistrationTarget) => {
    optionRegistrationsController.current!.dismissTarget(id, target);
  };

  const close = () => {
    ++generation.current;
    operation.current?.abort();
    setCached(null);
    setSectionEditing(null);
    setAccessRecordEdit(null);
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
  ): Promise<VersionedDetails | false> => {
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
      setSectionEditing(null);
      setStatus(success);
      onChanged?.();
      return result;
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

  const saveAccessRecord = async (payload: RowDraftPayload) => {
    if (!accessEdit || !visibleDetails || !record) return;
    const revision = visibleDetails.revision;
    const previousIds = new Set(
      visibleDetails.sections.find((item) => item.id === 'access')?.rows.map((row) => row.id) ?? [],
    );
    const saved =
      accessEdit.mode === 'create'
        ? await mutate(
            `${base}/rows`,
            'POST',
            { sectionId: 'access', title: payload.title, fields: payload.fields ?? [] },
            '접근 정보를 저장했습니다.',
            revision,
          )
        : await mutate(
            `${base}/rows/${encodeURIComponent(accessEdit.rowId)}`,
            'PATCH',
            {
              title: payload.title,
              values: payload.values,
              removeFields: payload.removeFields,
              addFields: payload.addFields,
            },
            '접근 정보를 저장했습니다.',
            revision,
          );
    if (!saved) return;
    setAccessRecordEdit(null);
    if (accessEdit.mode !== 'create') return;
    const created = saved.sections
      .find((item) => item.id === 'access')
      ?.rows.find((row) => !previousIds.has(row.id));
    if (created) setAccessRowId(created.id);
  };
  const beginAccessRecord = (next: { mode: 'create' } | { mode: 'edit'; rowId: string }) => {
    if (!canManage || interactionBusy || policyPending || editingActive) return;
    setActionError('');
    setStatus('');
    setAccessRecordEdit({ scopeKey, ...next });
  };

  const saveSection = async (
    draft: InstallationSectionDraft,
    committed: (
      change: InstallationSectionOperation,
      latest: InstallationDetailsDto,
      previous: InstallationDetailsDto,
    ) => void,
  ): Promise<{
    uncertain?: InstallationSectionOperation;
    confirmedDetails?: InstallationDetailsDto;
  } | void> => {
    if (
      !visibleSectionEditing ||
      !canManage ||
      interactionBusy ||
      policyPending ||
      !record ||
      (operation.current && !operation.current.signal.aborted)
    )
      return;
    let changes: InstallationSectionOperation[];
    try {
      changes = prepareInstallationSectionOperations(
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
      const flow = await runInstallationSavePlan(
        changes,
        latest,
        async (change, current) => {
          if (
            token !== generation.current ||
            identity.current.scopeKey !== scopeKey ||
            identity.current.policyPending
          )
            throw new InstallationRequestError('보호 설정을 확인한 뒤 다시 저장해 주세요.', 'rejected');
          let path = '';
          let method = '';
          let body: Record<string, unknown> = { revision: current.revision };
          switch (change.kind) {
            case 'row-create':
              path = `${base}/rows`;
              method = 'POST';
              body = { ...change.body, revision: current.revision };
              break;
            case 'row-update':
              path = `${base}/rows/${encodeURIComponent(change.id)}`;
              method = 'PATCH';
              body = {
                ...change.body,
                revision: current.revision,
                ...(change.metadata ? { metadataRevision: current.metadataRevision } : {}),
              };
              break;
            case 'row-delete':
              path = `${base}/rows/${encodeURIComponent(change.id)}`;
              method = 'DELETE';
              break;
            case 'note-create':
              path = `${base}/access-notes`;
              method = 'POST';
              body = { revision: current.revision, content: change.content };
              break;
            case 'note-update':
              path = `${base}/access-notes/${encodeURIComponent(change.id)}`;
              method = 'PATCH';
              body = { revision: current.revision, content: change.content };
              break;
            case 'note-delete':
              path = `${base}/access-notes/${encodeURIComponent(change.id)}`;
              method = 'DELETE';
              break;
          }
          let result: VersionedDetails;
          try {
            result = await installationRequest<VersionedDetails>(path, {
              method,
              signal: controller.signal,
              body: JSON.stringify(body),
            });
          } catch (reason) {
            throw reason;
          }
          if (!validateInstallationDetails(result, record.id))
            throw new InstallationRequestError(
              '저장 응답을 확인하지 못했습니다. 다시 불러와 확인해 주세요.',
              'uncertain',
            );
          if (token !== generation.current || identity.current.scopeKey !== scopeKey)
            throw new InstallationRequestError('현재 설치를 확인한 뒤 다시 진행해 주세요.', 'rejected');
          return result;
        },
        (change, result, previous) => {
          latest = result as VersionedDetails;
          saved++;
          committed(change, result, previous);
          setSectionEditing((current) =>
            current?.scopeKey === scopeKey ? { ...current, details: latest } : current,
          );
          if (!identity.current.policyPending) setCached({ scopeKey, details: latest });
        },
        (reason) => !(reason instanceof InstallationRequestError) || reason.outcome === 'uncertain',
      );
      latest = flow.latest as VersionedDetails;
      saved = flow.saved;
      if (flow.failure) {
        const message =
          flow.failure.error instanceof Error
            ? flow.failure.error.message
            : '저장하지 못했습니다. 다시 확인해 주세요.';
        setActionError(
          saved
            ? `${t('일부 기록은 저장되었습니다. 나머지 입력 내용은 유지됩니다.')} ${t(message)}`
            : message,
        );
        if (flow.failure.uncertain)
          return { uncertain: flow.failure.operation, confirmedDetails: flow.latest };
        return;
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

  const refreshSection = async () => {
    if (!visibleSectionEditing || !record || busy || policyPending) return false;
    const token = ++generation.current;
    const controller = new AbortController();
    setBusy(true);
    setActionError('');
    try {
      const result = await installationRequest<VersionedDetails>(`${base}/details`, {
        signal: controller.signal,
      });
      if (!validateInstallationDetails(result, record.id))
        throw new Error('설치 상세 정보를 확인하지 못했습니다.');
      if (token !== generation.current || identity.current.scopeKey !== scopeKey) return false;
      setSectionEditing((current) =>
        current?.scopeKey === scopeKey ? { ...current, details: result } : current,
      );
      setCached({ scopeKey, details: result });
      onChanged?.();
      return true;
    } catch (reason) {
      if (token === generation.current && !controller.signal.aborted)
        setActionError(reason instanceof Error ? reason.message : '최신 정보를 불러오지 못했습니다.');
      return false;
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };

  if (!record) return null;
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
      const sourceSection = visibleDetails!.sections.find((item) => item.id === config.id)!;
      const section = visibleInstallationSection(sourceSection);
      const selectedAccessRow = section.rows.find((row) => row.id === accessRowId) ?? section.rows[0];
      const editingAccessRow =
        config.id === 'access' && accessEdit?.mode === 'edit'
          ? section.rows.find((row) => row.id === accessEdit.rowId)
          : undefined;
      const accessNotes =
        config.id === 'access' ? (
          <InstallationAccessNotes
            key={scopeKey}
            notes={visibleDetails!.accessNotes ?? []}
            revision={visibleDetails!.revision}
            canManage={false}
            busy={busy || editingActive}
            policyPending={policyPending}
            onCreate={async (value, revision) =>
              Boolean(
                await mutate(
                  `${base}/access-notes`,
                  'POST',
                  { content: value },
                  '참고사항을 등록했습니다.',
                  revision,
                ),
              )
            }
            onUpdate={async (noteId, value, revision) =>
              Boolean(
                await mutate(
                  `${base}/access-notes/${encodeURIComponent(noteId)}`,
                  'PATCH',
                  { content: value },
                  '참고사항을 수정했습니다.',
                  revision,
                ),
              )
            }
            onDelete={async (noteId, revision) =>
              Boolean(
                await mutate(
                  `${base}/access-notes/${encodeURIComponent(noteId)}`,
                  'DELETE',
                  {},
                  '참고사항을 삭제했습니다.',
                  revision,
                ),
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
            (visibleSectionEditing?.sectionId === config.id || (config.id === 'access' && accessEditActive)
              ? ' is-group-editing'
              : '')
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
              protectionEnabled={protectionEnabled}
              error={actionError}
              codeOptions={codeOptions}
              codeOptionsLoading={codeOptionsLoading}
              codeOptionsError={codeOptionsError}
              canAddSharedOptions={canAddSharedOptions}
              optionRegistrations={optionRegistrations}
              onClose={cancelEditing}
              onRetryOptions={() => setCodeOptionsRetry((value) => value + 1)}
              onAddSharedOption={addSharedInstallationOption}
              onConfirmOptionRegistration={confirmSharedInstallationOption}
              onRetryOptionRegistration={retrySharedInstallationOption}
              onDismissOptionRegistration={dismissSharedInstallationOption}
              onSave={saveSection}
              onRefresh={refreshSection}
            />
          ) : (
            <>
              {section.rows.length ? (
                config.id === 'access' && section.rows.length > 1 && selectedAccessRow ? (
                  <div className="installation-access-browser">
                    <AccessRecordList
                      rows={section.rows}
                      sourceRows={sourceSection.rows}
                      selectedId={selectedAccessRow.id}
                      policyPending={policyPending}
                      codeOptions={codeOptions}
                      canManage={canManage}
                      locked={interactionBusy || policyPending || editingActive}
                      onSelect={(id) => {
                        if (interactionBusy || editingActive) return;
                        setAccessRowId(id);
                      }}
                      onAdd={() => beginAccessRecord({ mode: 'create' })}
                    />
                    {accessEditActive && (accessEdit?.mode === 'create' || editingAccessRow) ? (
                      <InstallationRecordEditor
                        key={accessEdit?.mode === 'create' ? 'create' : editingAccessRow?.id}
                        sectionId="access"
                        sectionTitle={section.title}
                        row={editingAccessRow}
                        busy={busy}
                        error={actionError}
                        policyPending={policyPending}
                        onClose={cancelEditing}
                        onSave={(payload) => void saveAccessRecord(payload)}
                      />
                    ) : (
                      <SectionRows
                        section={{ ...section, rows: [selectedAccessRow] }}
                        policyPending={policyPending}
                        accessNotes={accessNotes}
                        codeOptions={codeOptions}
                        actions={
                          canManage ? (
                            <button
                              type="button"
                              className="button"
                              disabled={interactionBusy || policyPending}
                              onClick={() => beginAccessRecord({ mode: 'edit', rowId: selectedAccessRow.id })}
                            >
                              <Pencil size={14} />
                              {t('{0} 수정', [t(section.title)])}
                            </button>
                          ) : undefined
                        }
                      />
                    )}
                  </div>
                ) : (
                  <SectionRows
                    section={section}
                    policyPending={policyPending}
                    accessNotes={accessNotes}
                    codeOptions={codeOptions}
                  />
                )
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
                      ? t('하단의 정보 수정에서 필요한 정보를 등록하세요.')
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
