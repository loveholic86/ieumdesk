import { t, getLocaleTag, displayValue } from './i18n';
import { useLocale } from './use-locale';
import { useAuth } from './auth';
import { useWorkspaceSettings } from './workspace-settings';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Server,
  Trash2,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, dateLabel, downloadCsv, money } from './api';
import { emailHref, phoneHref } from './client-security';
import { businessFormPayload, businessFormPolicy, businessFormPolicyMatches } from './business-form-client';
import type { Company, ContactComment, QuotationItem } from './types';
import { quotationTotals, quotationForTarget } from './quotation-calculation';
import InstallationDetails from './InstallationDetails';
import { refreshedInstallationSelection } from './installation-client';
import { ArchiveButton } from './ArchivedPage';
import { originalSalesWeights, configuredSalesWeights, salesWeight, weightedRevenue } from './sales-policy';
import './modules.css';

export type ModuleKind = 'contacts' | 'sales' | 'quotations' | 'installations' | 'activities';
type LineItem = QuotationItem;
type RecordRow = {
  id: string;
  companyId: string | null;
  relatedCompanyIds?: string[];
  updatedAt?: string;
  createdAt?: string;
  name?: string;
  department?: string;
  role?: string;
  type?: string;
  phone?: string;
  mobile?: string;
  fax?: string;
  workplace?: string;
  zipcode?: string;
  comment?: string;
  commentHistory?: ContactComment[];
  failedReason?: string;
  retryProbability?: string;
  stageWeight?: number;
  activityDate?: string;
  email?: string;
  note?: string;
  customerType?: string;
  stage?: string;
  serviceVersion?: string;
  employees?: number;
  expectedRevenue?: number;
  owner?: string;
  number?: string;
  contactName?: string;
  issueDate?: string;
  status?: string;
  quotationType?: string;
  items?: LineItem[];
  subtotal?: number;
  discount?: number;
  supplyAmount?: number;
  vat?: number;
  total?: number;
  revisionOf?: string;
  revisionNumber?: number;
  revisionSourceId?: string;
  legacyFinancials?: {
    locked: boolean;
    itemAmounts: Record<string, { subtotal: number; discountAmount: number; supplyAmount: number }>;
  };
  systemCode?: string;
  version?: string;
  installedAt?: string;
  patchedAt?: string;
  engineer?: string;
  accessType?: string;
  autoUpdate?: boolean;
  domain?: string;
  title?: string;
  body?: string;
  author?: string;
};
type Props = {
  kind: ModuleKind;
  companies: Company[];
  refresh: number;
  onRefresh: () => void;
  notify: (message: string, error?: boolean) => void;
  onCompany: (id: string) => void;
};
const stages = ['타겟고객', '통신접촉', '대면접촉', '협상', '성공', '실패'];
const versions = ['SAP', 'On Premises', 'Cloud'];
const activityLabels: Record<string, string> = {
  call: '전화',
  email: '이메일',
  meeting: '미팅',
  note: '메모',
  invoice: '세금계산서',
  quotation: '견적서',
  contract: '계약서',
};
const activityIcons: Record<string, LucideIcon> = {
  call: Phone,
  email: Mail,
  meeting: Users,
  note: FileText,
};
const configuration: Record<
  ModuleKind,
  { title: string; eyebrow: string; description: string; singular: string; icon: LucideIcon }
> = {
  contacts: {
    title: '담당자 관리',
    eyebrow: 'PEOPLE & CONNECTIONS',
    description: '고객사별 담당자를 연결하고, 필요한 연락처를 빠르게 찾으세요.',
    singular: '담당자',
    icon: Users,
  },
  sales: {
    title: '영업 관리',
    eyebrow: 'SALES PIPELINE',
    description: '첫 접촉부터 계약까지, 영업 기회의 다음 단계를 확인하세요.',
    singular: '영업 기회',
    icon: TrendingUp,
  },
  quotations: {
    title: '견적 관리',
    eyebrow: 'QUOTATIONS',
    description: '품목과 금액을 정확하게 정리하고, 고객과의 제안을 이어가세요.',
    singular: '견적',
    icon: FileText,
  },
  installations: {
    title: '설치 현황',
    eyebrow: 'SERVICE OPERATIONS',
    description: '고객사의 설치 버전과 업데이트 이력을 한눈에 확인하세요.',
    singular: '설치 정보',
    icon: Server,
  },
  activities: {
    title: '활동 기록',
    eyebrow: 'CUSTOMER ACTIVITIES',
    description: '전화, 미팅, 이메일에 담긴 고객과의 대화를 함께 기록하세요.',
    singular: '활동',
    icon: MessageSquare,
  },
};
const freshLine = (): LineItem => ({ name: '', unitPrice: 0, quantity: 1, months: 1, discountPercent: 0 });
type Amounts = {
  subtotal: number;
  discount: number;
  supplyAmount: number;
  vat: number;
  total: number;
  invalid?: boolean;
};
function calculate(items: LineItem[]): Amounts {
  try {
    return quotationTotals(items);
  } catch {
    return { subtotal: 0, discount: 0, supplyAmount: 0, vat: 0, total: 0, invalid: true };
  }
}

function quotationAmounts(row: RecordRow): Amounts {
  if (row.legacyFinancials?.locked === true) {
    const values = [row.subtotal, row.discount, row.supplyAmount, row.vat, row.total];
    return {
      subtotal: row.subtotal ?? 0,
      discount: row.discount ?? 0,
      supplyAmount: row.supplyAmount ?? 0,
      vat: row.vat ?? 0,
      total: row.total ?? 0,
      invalid: values.some((value) => typeof value !== 'number' || !Number.isFinite(value)),
    };
  }
  const calculated = calculate(row.items || []);
  return {
    subtotal: row.subtotal ?? calculated.subtotal,
    discount: row.discount ?? calculated.discount,
    supplyAmount: row.supplyAmount ?? calculated.supplyAmount,
    vat: row.vat ?? calculated.vat,
    total: row.total ?? calculated.total,
  };
}
const originalMoney = (value: number) =>
  new Intl.NumberFormat(getLocaleTag(), { maximumFractionDigits: 20 }).format(value);
function recordCompanyIds(row: RecordRow): string[] {
  return [
    ...new Set(
      [row.companyId, ...(row.relatedCompanyIds || [])].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
}
function recordTitle(kind: ModuleKind, row: RecordRow) {
  return (
    (kind === 'activities'
      ? row.title
      : kind === 'quotations'
        ? row.number
        : kind === 'installations'
          ? row.systemCode
          : row.name) || t('이름 미등록')
  );
}
function formattedDate(value?: string) {
  return value ? dateLabel(value) : t('미등록');
}
function Badge({ text, tone = '', context }: { text?: string; tone?: string; context?: string }) {
  useLocale();
  return <span className={`m-badge ${tone}`}>{t(text, undefined, context) || t('미등록')}</span>;
}
function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  useLocale();
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{t(label)}</span>
      {children}
    </label>
  );
}
function DetailItem({ label, value }: { label: string; value?: React.ReactNode }) {
  useLocale();
  return (
    <div>
      <dt>{t(label)}</dt>
      <dd>{displayValue(value) || <span className="muted">{t('미등록')}</span>}</dd>
    </div>
  );
}

export default function Modules({ kind, companies, refresh, onRefresh, notify, onCompany }: Props) {
  useLocale();
  const { canWrite, user } = useAuth();
  const workspace = useWorkspaceSettings();
  const policyToken = businessFormPolicy(user, workspace.settings?.revision);
  const currentPolicy = useRef(policyToken);
  currentPolicy.current = policyToken;
  const [loadedPolicy, setLoadedPolicy] = useState('');
  const policyValid = Boolean(workspace.settings) && loadedPolicy === policyToken;
  useEffect(() => {
    setSelected(null);
    setEditing(null);
    setRows([]);
  }, [policyToken]);
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [query, setQuery] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const [editing, setEditing] = useState<RecordRow | 'new' | null>(null);
  const [installationBasicBusy, setInstallationBasicBusy] = useState(false);
  const installationBasicEditing =
    kind === 'installations' &&
    Boolean(selected && editing && editing !== 'new' && editing.id === selected.id);
  const [weightPolicy, setWeightPolicy] = useState(originalSalesWeights);
  useEffect(() => {
    if (kind !== 'sales') return;
    const controller = new AbortController();
    api<{ items: Parameters<typeof configuredSalesWeights>[0] }>('/catalog/codes', {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setWeightPolicy(configuredSalesWeights(result.items));
      })
      .catch(() => {
        if (!controller.signal.aborted) setWeightPolicy(originalSalesWeights);
      });
    return () => controller.abort();
  }, [kind, refresh]);
  const config = configuration[kind];
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const forwarding = useRef(false);
  const rememberFocus = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const restoreFocus = () => {
    if (forwarding.current) {
      forwarding.current = false;
      return;
    }
    const target = opener.current?.isConnected ? opener.current : addButton.current;
    target?.focus();
  };
  const openNew = () => {
    rememberFocus();
    setEditing('new');
  };
  const openDetail = (row: RecordRow) => {
    rememberFocus();
    setSelected(row);
  };
  const companyIds = companies.map((company) => company.id).join(',');
  const companyNames = useMemo(
    () => new Map(companies.map((company) => [company.id, company.name])),
    [companies],
  );
  useEffect(() => {
    setQuery('');
    setCompanyFilter('');
    setCategory('');
    setPage(1);
    setSelected(null);
    setEditing(null);
  }, [kind]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    if (!workspace.settings) {
      setRows([]);
      setError(workspace.error);
      return () => controller.abort();
    }
    const requestedPolicy = policyToken;
    setError('');
    setRows([]);
    const load = async () => {
      if (kind === 'activities') {
        return (await api<{ items: RecordRow[] }>('/activities', { signal: controller.signal })).items;
      }
      return (await api<{ items: RecordRow[] }>(`/records/${kind}`, { signal: controller.signal })).items;
    };
    load()
      .then((items) => {
        if (!controller.signal.aborted && currentPolicy.current === requestedPolicy) {
          setLoadedPolicy(requestedPolicy);
          setRows(
            items.sort((a, b) =>
              (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''),
            ),
          );
          if (kind === 'installations')
            setSelected((current) => refreshedInstallationSelection(current, items));
        }
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kind, refresh, retry, companyIds, policyToken]);
  useEffect(() => {
    setPage(1);
  }, [query, companyFilter, category]);
  const searched = (policyValid ? rows : []).filter(
    (row) =>
      (!companyFilter || recordCompanyIds(row).includes(companyFilter)) &&
      (!query.trim() ||
        `${recordCompanyIds(row)
          .map((id) => companyNames.get(id) || '')
          .join(' ')} ${Object.values(row)
          .filter((value) => typeof value === 'string')
          .join(' ')}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  const categoryValue = (row: RecordRow) =>
    kind === 'sales'
      ? row.stage
      : kind === 'quotations'
        ? row.status
        : kind === 'installations'
          ? row.serviceVersion
          : row.type;
  const filtered = searched.filter((row) => !category || categoryValue(row) === category);
  const totalPages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  const categories =
    kind === 'contacts'
      ? ['인사', '전산', '재무', '기타', '미분류']
      : kind === 'sales'
        ? stages
        : kind === 'quotations'
          ? ['발행', '승인', '반려']
          : kind === 'installations'
            ? versions
            : Object.keys(activityLabels);
  const categoryLabel =
    kind === 'contacts' || kind === 'activities'
      ? '유형'
      : kind === 'sales'
        ? '영업 단계'
        : kind === 'quotations'
          ? '상태'
          : '서비스';
  const exportData = () => {
    const data = filtered.map((row) => ({
      고객사:
        recordCompanyIds(row)
          .map((id) => companyNames.get(id) || '고객사 확인 필요')
          .join(', ') || '고객사 연결 없음',
      [config.singular]: recordTitle(kind, row),
      [categoryLabel]: kind === 'activities' ? activityLabels[row.type || ''] : categoryValue(row),
      ...(kind === 'contacts'
        ? {
            부서: row.department,
            직책: row.role,
            전화: row.phone,
            휴대전화: row.mobile,
            이메일: row.email,
            팩스: row.fax,
            근무처: row.workplace,
            우편번호: row.zipcode,
            코멘트: (row.commentHistory || [])
              .map((comment) => `${comment.createdAt} ${comment.author}: ${comment.body}`)
              .join('\n'),
          }
        : kind === 'sales'
          ? {
              영업담당: row.owner,
              예상매출: row.expectedRevenue,
              가중치: salesWeight(row, weightPolicy),
              가중예상매출: weightedRevenue(row, weightPolicy),
              서비스: row.serviceVersion,
              실패사유: row.failedReason,
              재영업가능성: row.retryProbability,
            }
          : kind === 'quotations'
            ? { 발행일: row.issueDate, 공급가액: row.supplyAmount, 부가세: row.vat, 합계: row.total }
            : kind === 'installations'
              ? { 버전: row.version, 설치일: row.installedAt, 패치일: row.patchedAt, 엔지니어: row.engineer }
              : {
                  기록자: row.author,
                  내용: row.body,
                  활동일: row.activityDate || '',
                  기록일: row.createdAt,
                }),
    }));
    downloadCsv(data, `ieumdesk_${config.title.replaceAll(' ', '_')}.csv`);
    notify(`${filtered.length}개 ${config.singular} 정보를 내보냈습니다.`);
  };
  return (
    <section className="m-module">
      <div className="m-header">
        <div>
          <div className="eyebrow">{config.eyebrow}</div>
          <h1>{t(config.title)}</h1>
          <p>{t(config.description)}</p>
        </div>
        {canWrite && (
          <button className="button primary" ref={addButton} onClick={openNew} disabled={!companies.length}>
            <Plus size={18} />
            {t('{0} 추가', [t(config.singular)])}
          </button>
        )}
      </div>
      {kind === 'sales' && (
        <div className="m-stage-grid" aria-label={t('영업 단계별 현황')}>
          {stages.map((stage, index) => {
            const items = searched.filter((row) => row.stage === stage);
            return (
              <button
                key={stage}
                onClick={() => setCategory(category === stage ? '' : stage)}
                className={`m-stage ${category === stage ? 'selected' : ''}`}
                aria-pressed={category === stage}
              >
                <span className="m-stage-label">
                  <i className={`m-stage-dot m-stage-${index}`} />
                  {t(stage, undefined, 'sales')}
                </span>
                <strong>
                  {items.length}
                  <small>{t('건')}</small>
                </strong>
                <span>
                  {money(items.reduce((sum, row) => sum + (row.expectedRevenue || 0), 0))}
                  {t('원')}
                </span>
                <small>
                  {t('가중치 적용 ')}
                  {money(items.reduce((sum, row) => sum + weightedRevenue(row, weightPolicy), 0))}
                  {t('원')}
                </small>
              </button>
            );
          })}
        </div>
      )}
      <div className="panel m-panel">
        <div className="m-toolbar">
          <label className="m-search">
            <Search size={18} />
            <input
              aria-label={t('{0} 검색', [t(config.title)])}
              placeholder={
                kind === 'contacts'
                  ? t('이름, 고객사, 이메일 검색')
                  : kind === 'activities'
                    ? t('제목, 고객사, 활동 내용 검색')
                    : t('{0}, 고객사 검색', [t(config.singular)])
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="icon-button"
                type="button"
                aria-label={t('검색어 지우기')}
                onClick={() => setQuery('')}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <div className="m-filters">
            <select
              aria-label={t('고객사 필터')}
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
            >
              <option value="">{t('모든 고객사')}</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
            <select
              aria-label={t('{0} 필터', [t(categoryLabel)])}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">
                {t('모든 ')}
                {t(categoryLabel)}
              </option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {kind === 'activities'
                    ? t(activityLabels[value])
                    : t(value, undefined, kind === 'sales' ? 'sales' : undefined)}
                </option>
              ))}
            </select>
            <button className="button m-export" disabled={!filtered.length || loading} onClick={exportData}>
              <Download size={16} />
              {t('내보내기')}
            </button>
          </div>
        </div>
        <div className="m-result-bar">
          <span>
            {t('전체 ')}
            <strong>{filtered.length}</strong>
            {t('건')}
            {(query || companyFilter || category) && <span className="muted">{t(' · 필터 적용')}</span>}
          </span>
          {(query || companyFilter || category) && (
            <button
              className="m-text-button"
              onClick={() => {
                setQuery('');
                setCompanyFilter('');
                setCategory('');
              }}
            >
              {t('필터 초기화')}
            </button>
          )}
        </div>
        {error ? (
          <div className="error-box m-load-error" role="alert">
            <span>{t(error)}</span>
            <button className="button" onClick={() => setRetry((value) => value + 1)}>
              <RefreshCw size={15} />
              {t('다시 시도')}
            </button>
          </div>
        ) : loading || !policyValid ? (
          <div className="m-loading" role="status">
            <RefreshCw size={21} />
            {t(config.singular)}
            {t(' 정보를 불러오는 중입니다.')}
          </div>
        ) : !filtered.length ? (
          <div className="empty m-empty">
            <config.icon size={32} strokeWidth={1.5} />
            <h3>
              {rows.length
                ? t('조건에 맞는 결과가 없습니다.')
                : t('등록된 {0} 정보가 없습니다.', [t(config.singular)])}
            </h3>
            <p>
              {rows.length
                ? t('검색어나 필터를 변경해 주세요.')
                : !canWrite
                  ? t('담당자가 등록한 정보를 이곳에서 확인할 수 있습니다.')
                  : companies.length
                    ? t('첫 {0} 정보를 추가해 업무를 시작하세요.', [t(config.singular)])
                    : t('고객사 관리에서 고객사를 먼저 등록해 주세요.')}
            </p>
            {canWrite && !rows.length && companies.length > 0 && (
              <button className="button" onClick={openNew}>
                <Plus size={16} />
                {t('{0} 추가', [t(config.singular)])}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="m-table-wrap">
              <table className="m-table">
                <caption className="m-sr-only">
                  {t(config.title)}
                  {t(' 목록, 항목 이름을 누르면 상세 정보가 열립니다.')}
                </caption>
                <thead>
                  <tr>
                    {kind === 'contacts' ? (
                      <>
                        <th>{t('담당자')}</th>
                        <th>{t('고객사')}</th>
                        <th>{t('유형')}</th>
                        <th>{t('연락처')}</th>
                        <th>{t('이메일')}</th>
                      </>
                    ) : kind === 'sales' ? (
                      <>
                        <th>{t('영업 기회')}</th>
                        <th>{t('고객사')}</th>
                        <th>{t('단계')}</th>
                        <th>{t('서비스')}</th>
                        <th className="m-number">{t('예상 매출')}</th>
                        <th>{t('담당자')}</th>
                      </>
                    ) : kind === 'quotations' ? (
                      <>
                        <th>{t('견적 번호')}</th>
                        <th>{t('고객사')}</th>
                        <th>{t('발행일')}</th>
                        <th>{t('유형')}</th>
                        <th>{t('상태')}</th>
                        <th className="m-number">{t('합계 (VAT 포함)')}</th>
                      </>
                    ) : kind === 'installations' ? (
                      <>
                        <th>{t('시스템 코드')}</th>
                        <th>{t('고객사')}</th>
                        <th>{t('서비스 / 버전')}</th>
                        <th>{t('최근 패치')}</th>
                        <th>{t('엔지니어')}</th>
                        <th>{t('자동 업데이트')}</th>
                      </>
                    ) : (
                      <>
                        <th>{t('활동')}</th>
                        <th>{t('고객사')}</th>
                        <th>{t('유형')}</th>
                        <th>{t('기록자')}</th>
                        <th>{t('활동일')}</th>
                      </>
                    )}
                    <th className="m-action-head">
                      <span className="m-sr-only">{t('상세 보기')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => {
                    const RowIcon =
                      kind === 'activities' ? activityIcons[row.type || 'note'] || FileText : config.icon;
                    return (
                      <tr key={row.id}>
                        <td>
                          <div className="m-name-cell">
                            <span className={`m-record-icon ${kind}`}>
                              <RowIcon size={18} />
                            </span>
                            <div>
                              <button className="m-record-link" onClick={() => openDetail(row)}>
                                {recordTitle(kind, row)}
                              </button>
                              <span className="m-subtitle">
                                {kind === 'contacts'
                                  ? [row.department, row.role].filter(Boolean).join(' · ') ||
                                    t('부서·직책 미등록')
                                  : kind === 'sales'
                                    ? t(row.customerType)
                                    : kind === 'quotations'
                                      ? row.contactName || t('담당자 미등록')
                                      : kind === 'installations'
                                        ? displayValue(row.domain) || t('도메인 미등록')
                                        : row.body || t('내용 없음')}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          {recordCompanyIds(row).length ? (
                            recordCompanyIds(row).map((id) => (
                              <div key={id}>
                                <button className="m-company-link" onClick={() => onCompany(id)}>
                                  {companyNames.get(id) || t('고객사 확인 필요')}
                                </button>
                              </div>
                            ))
                          ) : (
                            <span className="muted">{t('고객사 연결 없음')}</span>
                          )}
                        </td>
                        {kind === 'contacts' ? (
                          <>
                            <td>
                              <Badge text={row.type} />
                            </td>
                            <td className="m-nowrap">
                              {row.mobile || row.phone || <span className="muted">{t('미등록')}</span>}
                            </td>
                            <td>
                              {row.email ? (
                                <a className="m-email" href={emailHref(row.email)}>
                                  {row.email}
                                </a>
                              ) : (
                                <span className="muted">{t('미등록')}</span>
                              )}
                            </td>
                          </>
                        ) : kind === 'sales' ? (
                          <>
                            <td>
                              <Badge
                                text={row.stage}
                                context="sales"
                                tone={
                                  row.stage === '성공' ? 'success' : row.stage === '실패' ? 'danger' : 'blue'
                                }
                              />
                            </td>
                            <td>{row.serviceVersion}</td>
                            <td className="m-number">
                              <strong>{money(row.expectedRevenue || 0)}</strong>
                              <span className="muted">{t(' 원')}</span>
                            </td>
                            <td>{row.owner || t('미배정')}</td>
                          </>
                        ) : kind === 'quotations' ? (
                          <>
                            <td className="m-nowrap">{formattedDate(row.issueDate)}</td>
                            <td>{t(row.quotationType)}</td>
                            <td>
                              <Badge
                                text={row.status}
                                tone={
                                  row.status === '승인'
                                    ? 'success'
                                    : row.status === '반려'
                                      ? 'danger'
                                      : 'blue'
                                }
                              />
                            </td>
                            <td className="m-number">
                              <strong>
                                {quotationAmounts(row).invalid
                                  ? t('원본 금액 확인 필요')
                                  : row.legacyFinancials?.locked
                                    ? originalMoney(quotationAmounts(row).total)
                                    : money(quotationAmounts(row).total)}
                              </strong>
                              {!quotationAmounts(row).invalid && <span className="muted">{t(' 원')}</span>}
                            </td>
                          </>
                        ) : kind === 'installations' ? (
                          <>
                            <td>
                              <span>{row.serviceVersion}</span>
                              <span className="m-subtitle">{row.version || t('버전 미등록')}</span>
                            </td>
                            <td className="m-nowrap">{formattedDate(row.patchedAt)}</td>
                            <td>{displayValue(row.engineer) || t('미배정')}</td>
                            <td>
                              <Badge
                                text={row.autoUpdate ? '사용' : '미사용'}
                                tone={row.autoUpdate ? 'success' : ''}
                              />
                            </td>
                          </>
                        ) : (
                          <>
                            <td>
                              <Badge text={activityLabels[row.type || 'note']} tone="blue" />
                            </td>
                            <td>{row.author || t('미등록')}</td>
                            <td className="m-nowrap">{formattedDate(row.activityDate || row.createdAt)}</td>
                          </>
                        )}
                        <td>
                          <button
                            className="icon-button"
                            aria-label={t('{0} 상세 보기', [recordTitle(kind, row)])}
                            onClick={() => openDetail(row)}
                          >
                            <ChevronRight size={18} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="m-pagination">
              <span>
                {t('전체 {0}개 중 {1}–{2}개 표시', [
                  filtered.length,
                  (currentPage - 1) * 10 + 1,
                  Math.min(currentPage * 10, filtered.length),
                ])}
              </span>
              <div>
                <button
                  className="icon-button"
                  aria-label={t('이전 페이지')}
                  disabled={currentPage === 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <span>
                  {currentPage} / {totalPages}
                </span>
                <button
                  className="icon-button"
                  aria-label={t('다음 페이지')}
                  disabled={currentPage === totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <RecordDetail
        weightPolicy={weightPolicy}
        kind={kind}
        row={policyValid ? selected : null}
        company={companies.find((company) => company.id === selected?.companyId)}
        relatedCompanies={
          selected ? companies.filter((company) => recordCompanyIds(selected).includes(company.id)) : []
        }
        onRestoreFocus={restoreFocus}
        onClose={() => {
          setSelected(null);
          if (kind === 'installations') setEditing(null);
        }}
        basicBusy={installationBasicBusy}
        onBasicCancel={() => setEditing(null)}
        basicEditor={
          installationBasicEditing && canWrite && policyValid && editing ? (
            <RecordForm
              inline
              key={selected!.id}
              policyToken={policyToken}
              currentPolicy={currentPolicy}
              weightPolicy={weightPolicy}
              kind="installations"
              record={editing}
              companies={companies}
              defaultCompanyId={companyFilter}
              onRestoreFocus={() => {}}
              onBusyChange={setInstallationBasicBusy}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                onRefresh();
                notify('설치 정보 수정을 완료했습니다.');
              }}
            />
          ) : undefined
        }
        onArchived={() => {
          setSelected(null);
          onRefresh();
        }}
        onChanged={onRefresh}
        notify={notify}
        onEdit={() => {
          if (kind === 'installations') {
            setEditing(selected);
            return;
          }
          forwarding.current = true;
          setEditing(selected);
          setSelected(null);
        }}
        onRevision={() => {
          if (!selected) return;
          forwarding.current = true;
          const {
            legacyFinancials: _locked,
            subtotal: _subtotal,
            discount: _discount,
            supplyAmount: _supply,
            vat: _vat,
            total: _total,
            ...source
          } = selected;
          setEditing({
            ...source,
            id: '',
            revisionSourceId: selected.id,
            items: selected.items?.map((item, index) => {
              const originalDiscount =
                selected.legacyFinancials?.itemAmounts?.[String(index)]?.discountAmount;
              return selected.legacyFinancials?.locked && typeof originalDiscount === 'number'
                ? { ...item, discountType: 'amount' as const, discountAmount: originalDiscount }
                : { ...item };
            }),
            number: `${selected.number}-R${(selected.revisionNumber || 0) + 1}`,
            status: '발행',
            issueDate: new Date().toLocaleDateString('en-CA'),
          });
          setSelected(null);
        }}
        onCompany={(id) => {
          forwarding.current = true;
          setSelected(null);
          onCompany(id);
        }}
      />
      {canWrite && policyValid && editing && !installationBasicEditing && (
        <RecordForm
          policyToken={policyToken}
          currentPolicy={currentPolicy}
          weightPolicy={weightPolicy}
          kind={kind}
          record={editing}
          companies={companies}
          defaultCompanyId={companyFilter}
          onRestoreFocus={restoreFocus}
          onClose={() => setEditing(null)}
          onSaved={() => {
            const isNew = editing === 'new' || Boolean(editing.revisionSourceId);
            setEditing(null);
            onRefresh();
            notify(`${config.singular} ${isNew ? '추가' : '수정'}를 완료했습니다.`);
          }}
        />
      )}
    </section>
  );
}

function RecordDetail({
  weightPolicy,
  kind,
  row,
  company,
  relatedCompanies,
  onClose,
  onEdit,
  onRevision,
  onCompany,
  onRestoreFocus,
  onArchived,
  onChanged,
  notify,
  basicEditor,
  basicBusy,
  onBasicCancel,
}: {
  kind: ModuleKind;
  row: RecordRow | null;
  weightPolicy: Record<string, number>;
  onArchived: () => void;
  onChanged?: () => void;
  notify: (message: string, error?: boolean) => void;
  company?: Company;
  relatedCompanies: Company[];
  onClose: () => void;
  onEdit: () => void;
  onRevision: () => void;
  onCompany: (id: string) => void;
  onRestoreFocus: () => void;
  basicEditor?: React.ReactNode;
  basicBusy?: boolean;
  onBasicCancel?: () => void;
}) {
  useLocale();
  const { canWrite, user } = useAuth();
  const config = configuration[kind];
  if (kind === 'installations')
    return (
      <InstallationDetails
        record={row}
        onArchived={onArchived}
        onChanged={onChanged}
        notify={notify}
        companies={relatedCompanies}
        onClose={onClose}
        onEdit={onEdit}
        onCompany={onCompany}
        onRestoreFocus={onRestoreFocus}
        basicEditor={basicEditor}
        basicBusy={basicBusy}
        onBasicCancel={onBasicCancel}
      />
    );
  return (
    <Dialog.Root
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus();
          }}
          className={`dialog m-record-dialog ${kind === 'quotations' ? 'm-quote-dialog' : ''}`}
        >
          <div className="m-dialog-heading">
            <span className="m-record-icon">
              <config.icon size={22} />
            </span>
            <div>
              <Dialog.Title>{row ? recordTitle(kind, row) : t(config.singular)}</Dialog.Title>
              <Dialog.Description>
                {t(config.singular)}
                {t(' 상세 정보')}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label={t('상세 닫기')}>
              <X size={20} />
            </Dialog.Close>
          </div>
          {row && (
            <>
              <div className="m-detail-scroll">
                {relatedCompanies.length ? (
                  relatedCompanies.map((linkedCompany) => (
                    <button
                      key={linkedCompany.id}
                      className="m-customer-card"
                      onClick={() => onCompany(linkedCompany.id)}
                    >
                      <span className="m-record-icon">
                        <Building2 size={19} />
                      </span>
                      <span>
                        <small>{t('고객사')}</small>
                        <strong>{linkedCompany.name}</strong>
                      </span>
                      <ArrowRight size={17} />
                    </button>
                  ))
                ) : (
                  <div className="m-customer-card">
                    <span className="m-record-icon">
                      <Building2 size={19} />
                    </span>
                    <span>
                      <small>{t('고객사')}</small>
                      <strong>{t('고객사 연결 없음')}</strong>
                    </span>
                  </div>
                )}
                {kind === 'quotations' ? (
                  <QuotePreview row={row} company={company} />
                ) : (
                  <dl className="m-detail-grid">
                    {kind === 'contacts' ? (
                      <>
                        <DetailItem label={t('담당자 이름')} value={row.name} />
                        <DetailItem label={t('담당 유형')} value={t(row.type)} />
                        <DetailItem label={t('부서')} value={row.department} />
                        <DetailItem label={t('직책')} value={row.role} />
                        <DetailItem
                          label={t('전화번호')}
                          value={row.phone && <a href={phoneHref(row.phone)}>{row.phone}</a>}
                        />
                        <DetailItem
                          label={t('휴대전화')}
                          value={row.mobile && <a href={phoneHref(row.mobile)}>{row.mobile}</a>}
                        />
                        <DetailItem label={t('팩스')} value={row.fax} />
                        <DetailItem label={t('근무처')} value={row.workplace} />
                        <DetailItem label={t('우편번호')} value={row.zipcode} />
                        <DetailItem
                          label={t('이메일')}
                          value={row.email && <a href={emailHref(row.email)}>{row.email}</a>}
                        />
                      </>
                    ) : kind === 'sales' ? (
                      <>
                        <DetailItem
                          label={t('영업 단계')}
                          value={<Badge text={row.stage} context="sales" tone="blue" />}
                        />
                        <DetailItem label={t('고객 유형')} value={t(row.customerType)} />
                        <DetailItem label={t('서비스')} value={row.serviceVersion} />
                        <DetailItem label={t('임직원 수')} value={t('{0}명', [money(row.employees || 0)])} />
                        <DetailItem
                          label={t('예상 매출')}
                          value={t('{0}원', [money(row.expectedRevenue || 0)])}
                        />
                        <DetailItem label={t('내부 담당자')} value={row.owner} />
                        <DetailItem label={t('실패 사유')} value={row.failedReason} />
                        <DetailItem label={t('재영업 가능성')} value={t(row.retryProbability)} />
                        <DetailItem label={t('가중치')} value={`${salesWeight(row, weightPolicy)}%`} />
                        <DetailItem
                          label={t('가중 예상 매출')}
                          value={t('{0}원', [money(weightedRevenue(row, weightPolicy))])}
                        />
                      </>
                    ) : (
                      <>
                        <DetailItem label={t('활동 유형')} value={t(activityLabels[row.type || 'note'])} />
                        <DetailItem label={t('기록자')} value={row.author} />
                        <DetailItem label={t('활동일')} value={formattedDate(row.activityDate)} />
                        <DetailItem label={t('기록일')} value={formattedDate(row.createdAt)} />
                      </>
                    )}
                  </dl>
                )}
                {kind === 'sales' && company && (
                  <section className="m-note">
                    <h3>{t('고객사 컨택 정보')}</h3>
                    <dl className="m-detail-grid">
                      <DetailItem label={t('최초 컨택일')} value={formattedDate(company.firstContactDate)} />
                      <DetailItem label={t('컨택 구분')} value={t(company.contactSource)} />
                      <DetailItem label={t('컨택 상세')} value={company.contactDetail} />
                      <DetailItem label={t('대표 담당자')} value={company.contactName} />
                    </dl>
                    <button className="button" onClick={() => onCompany(company.id)}>
                      {t('고객정보 수정')}
                    </button>
                  </section>
                )}
                {kind === 'contacts' && (
                  <section className="m-note">
                    <h3>{t('코멘트 이력')}</h3>
                    {row.commentHistory?.length ? (
                      row.commentHistory.map((comment) => (
                        <article key={comment.id}>
                          <small>
                            {formattedDate(comment.createdAt)} · {comment.author}
                          </small>
                          <p>{comment.body}</p>
                        </article>
                      ))
                    ) : (
                      <p>{t('등록된 코멘트가 없습니다.')}</p>
                    )}
                  </section>
                )}
                {kind !== 'quotations' && (
                  <div className="m-note">
                    <h3>{kind === 'activities' ? t('활동 내용') : t('관리 메모')}</h3>
                    <p>{(kind === 'activities' ? row.body : row.note) || t('등록된 내용이 없습니다.')}</p>
                  </div>
                )}
              </div>
              <div className="dialog-footer m-detail-footer">
                <span className="muted">
                  {kind === 'activities' ? t('기록') : t('최근 수정')}{' '}
                  {formattedDate(row.updatedAt || row.createdAt)}
                </span>
                <div>
                  {kind === 'quotations' && (
                    <button className="button" onClick={() => window.print()}>
                      <Printer size={16} />
                      {t('인쇄 / PDF')}
                    </button>
                  )}
                  <ArchiveButton
                    area={kind}
                    id={row.id}
                    title={recordTitle(kind, row)}
                    onArchived={onArchived}
                    notify={notify}
                  />
                  {canWrite && kind === 'quotations' && (
                    <button className="button" onClick={onRevision}>
                      <Plus size={15} />
                      {t('새 버전 작성')}
                    </button>
                  )}
                  {canWrite && (kind !== 'quotations' || row.status !== '승인' || user?.role === 'admin') && (
                    <button className="button primary" onClick={onEdit}>
                      <Pencil size={15} />
                      {t('정보 수정')}
                    </button>
                  )}
                  {kind === 'activities' && (
                    <button className="button" onClick={onClose}>
                      {t('닫기')}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function QuotePreview({ row, company }: { row: RecordRow; company?: Company }) {
  useLocale();
  const original = row.legacyFinancials?.locked === true;
  return (
    <article className="m-print-sheet">
      <div className="m-quote-title">
        <div>
          <span>QUOTATION</span>
          <h2>{t('견적서')}</h2>
          <p>{row.number}</p>
        </div>
        <Badge text={row.status} tone={row.status === '승인' ? 'success' : 'blue'} />
      </div>
      <dl className="m-detail-grid m-quote-meta">
        <DetailItem label={t('고객사')} value={company?.name || t('고객사 연결 없음')} />
        <DetailItem label={t('발행일')} value={formattedDate(row.issueDate)} />
        <DetailItem label={t('수신 담당자')} value={row.contactName} />
        <DetailItem label={t('계약 유형')} value={t(row.quotationType)} />
        {row.revisionOf && (
          <DetailItem label={t('개정')} value={t('새 버전 {0}', [row.revisionNumber || 1])} />
        )}
      </dl>
      {original && <p className="m-calculation-note">{t('이관된 견적의 원본 품목과 금액입니다.')}</p>}
      <QuoteItems row={row} />
      <QuoteTotals amounts={quotationAmounts(row)} original={original} />
      <div className="m-note">
        <h3>{t('견적 메모')}</h3>
        <p>{row.note || t('등록된 내용이 없습니다.')}</p>
      </div>
    </article>
  );
}
function QuoteItems({ row }: { row: RecordRow }) {
  useLocale();
  const original = row.legacyFinancials?.locked === true;
  const format = original ? originalMoney : money;
  return (
    <div className="m-quote-table-wrap">
      <table className="m-quote-table">
        <thead>
          <tr>
            <th>{t('품목')}</th>
            <th>{t('단가 (원)')}</th>
            <th>{t('수량')}</th>
            <th>{t('개월')}</th>
            {original && <th>{t('품목 합계 (원)')}</th>}
            <th>{original ? t('할인 금액 (원)') : t('할인')}</th>
            <th>{t('공급가액 (원)')}</th>
          </tr>
        </thead>
        <tbody>
          {(row.items || []).map((item, index) => {
            const stored = row.legacyFinancials?.itemAmounts?.[String(index)];
            const storedAmount = (value: number | undefined) =>
              typeof value === 'number' && Number.isFinite(value) ? originalMoney(value) : '확인 필요';
            return (
              <tr key={index}>
                <td>{item.name}</td>
                <td>{format(item.unitPrice)}</td>
                <td>{format(item.quantity)}</td>
                <td>{item.months}</td>
                {original && <td>{storedAmount(stored?.subtotal)}</td>}
                <td>
                  {original
                    ? storedAmount(stored?.discountAmount)
                    : item.discountType === 'amount'
                      ? t('{0}원', [money(item.discountAmount || 0)])
                      : `${item.discountPercent}%`}
                </td>
                <td>
                  {original ? storedAmount(stored?.supplyAmount) : money(calculate([item]).supplyAmount)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function QuoteTotals({ amounts, original = false }: { amounts: Amounts; original?: boolean }) {
  useLocale();
  if (amounts.invalid)
    return (
      <p className="error-box" role="alert">
        {original
          ? t('이관된 견적의 원본 금액을 확인하지 못했습니다.')
          : t('견적 금액이 처리 가능한 범위를 넘었습니다. 품목의 단가와 수량을 확인해 주세요.')}
      </p>
    );
  const format = original ? originalMoney : money;
  return (
    <dl className="m-quote-totals">
      <div>
        <dt>{t('품목 합계')}</dt>
        <dd>
          {format(amounts.subtotal)}
          {t('원')}
        </dd>
      </div>
      <div>
        <dt>{t('할인 금액')}</dt>
        <dd>
          −{format(amounts.discount)}
          {t('원')}
        </dd>
      </div>
      <div>
        <dt>{t('공급가액')}</dt>
        <dd>
          {format(amounts.supplyAmount)}
          {t('원')}
        </dd>
      </div>
      <div>
        <dt>{original ? t('부가세') : t('부가세 (10%)')}</dt>
        <dd>
          {format(amounts.vat)}
          {t('원')}
        </dd>
      </div>
      <div className="m-grand-total">
        <dt>{t('총 견적 금액')}</dt>
        <dd>
          {format(amounts.total)}
          <small>{t('원')}</small>
        </dd>
      </div>
    </dl>
  );
}

function RecordFormFrame({
  inline,
  kind,
  saving,
  onClose,
  onRestoreFocus,
  children,
}: {
  inline: boolean;
  kind: ModuleKind;
  saving: boolean;
  onClose: () => void;
  onRestoreFocus: () => void;
  children: React.ReactNode;
}) {
  useLocale();
  if (inline)
    return (
      <section className="installation-basic-editor" aria-label={t('설치 기본 정보 수정')} aria-busy={saving}>
        {children}
      </section>
    );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay form-overlay" />
        <Dialog.Content
          className={`dialog m-record-dialog m-form-dialog ${kind === 'quotations' ? 'm-wide-form' : ''} ${kind === 'installations' ? 'm-installation-form' : ''}`}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus();
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RecordForm({
  policyToken,
  currentPolicy,
  weightPolicy,
  kind,
  record,
  companies,
  defaultCompanyId,
  onClose,
  onSaved,
  onRestoreFocus,
  inline = false,
  onBusyChange,
}: {
  policyToken: string;
  currentPolicy: React.RefObject<string>;
  kind: ModuleKind;
  record: RecordRow | 'new';
  weightPolicy: Record<string, number>;
  companies: Company[];
  defaultCompanyId: string;
  onClose: () => void;
  onSaved: () => void;
  onRestoreFocus: () => void;
  inline?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  useLocale();
  const { user } = useAuth();
  const openedPolicy = useRef(policyToken);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const isCurrent = () =>
    active.current && businessFormPolicyMatches(openedPolicy.current, currentPolicy.current);
  const config = configuration[kind];
  const [draft, setDraft] = useState<RecordRow>(() =>
    record === 'new'
      ? {
          id: '',
          companyId: defaultCompanyId,
          type: kind === 'activities' ? 'call' : '인사',
          customerType: '신규',
          stage: '타겟고객',
          serviceVersion: 'Cloud',
          employees: 0,
          expectedRevenue: 0,
          relatedCompanyIds: [],
          activityDate: new Date().toLocaleDateString('en-CA'),
          status: '발행',
          quotationType: '신규계약',
          issueDate: new Date().toLocaleDateString('en-CA'),
          items: [freshLine()],
          accessType: '알 수 없음',
          autoUpdate: false,
          author: user?.name || '',
        }
      : {
          ...record,
          issueDate: record.issueDate?.slice(0, 10),
          installedAt: record.installedAt?.slice(0, 10),
          patchedAt: record.patchedAt?.slice(0, 10),
          items: record.items?.map((item) => ({ ...item })),
        },
  );
  const initialDraft = useRef(draft);
  const isRevision = record !== 'new' && Boolean(record.revisionSourceId);
  const isNew = record === 'new' || isRevision;
  const [targetAmount, setTargetAmount] = useState('');
  const [catalogue, setCatalogue] = useState<
    { id: string; name: string; unitPrice: number; description: string; active: boolean; revision: number }[]
  >([]);
  const [catalogueError, setCatalogueError] = useState('');
  useEffect(() => {
    if (kind !== 'quotations') return;
    const controller = new AbortController();
    api<{ items: typeof catalogue }>('/catalog/products', { signal: controller.signal })
      .then((result) => setCatalogue(result.items.filter((item) => item.active)))
      .catch((error) => {
        if (error.name !== 'AbortError') setCatalogueError(error.message);
      });
    return () => controller.abort();
  }, [kind]);
  const legacyLocked = kind === 'quotations' && record !== 'new' && record.legacyFinancials?.locked === true;
  const [saving, setSaving] = useState(false);
  const savingRequest = useRef(false);
  useEffect(() => {
    onBusyChange?.(saving);
    return () => onBusyChange?.(false);
  }, [saving, onBusyChange]);
  const Title = inline ? 'h3' : Dialog.Title;
  const Description = inline ? 'p' : Dialog.Description;
  const [error, setError] = useState('');
  const update = (key: keyof RecordRow, value: unknown) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const input = (
    key: keyof RecordRow,
    label: string,
    opts: {
      required?: boolean;
      type?: string;
      placeholder?: string;
      wide?: boolean;
      maxLength?: number;
    } = {},
  ) => (
    <Field label={`${t(label)}${opts.required ? ' *' : ''}`} wide={opts.wide}>
      <input
        type={opts.type || 'text'}
        name={key}
        onInput={opts.type === 'date' ? (e) => update(key, e.currentTarget.value) : undefined}
        required={opts.required}
        value={String(draft[key] ?? '')}
        onChange={(e) => update(key, e.target.value)}
        maxLength={opts.maxLength || 200}
        placeholder={t(opts.placeholder)}
      />
    </Field>
  );
  const numeric = (key: keyof RecordRow, label: string, maximum = Number.MAX_SAFE_INTEGER) => (
    <Field label={t(label)}>
      <input
        type="number"
        min="0"
        max={maximum}
        step="1"
        value={Number(draft[key] || 0)}
        onChange={(e) => update(key, Number(e.target.value))}
      />
    </Field>
  );
  const select = (key: keyof RecordRow, label: string, values: string[]) => (
    <Field label={t(label)}>
      <select value={String(draft[key] ?? values[0])} onChange={(e) => update(key, e.target.value)}>
        {values.map((value) => (
          <option key={value} value={value}>
            {t(value)}
          </option>
        ))}
      </select>
    </Field>
  );
  const updateLine = (index: number, key: keyof LineItem, value: string | number) =>
    update(
      'items',
      (draft.items || []).map((item, position) => (position === index ? { ...item, [key]: value } : item)),
    );
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isCurrent() || savingRequest.current) return;
    setError('');
    const keys: Record<ModuleKind, (keyof RecordRow)[]> = {
      contacts: [
        'companyId',
        'name',
        'department',
        'role',
        'type',
        'phone',
        'mobile',
        'email',
        'fax',
        'workplace',
        'zipcode',
        'comment',
        'note',
      ],
      sales: [
        'companyId',
        'name',
        'customerType',
        'stage',
        'serviceVersion',
        'employees',
        'expectedRevenue',
        'relatedCompanyIds',
        'failedReason',
        'retryProbability',
        ...(draft.stageWeight === undefined ? [] : ['stageWeight' as const]),
        'owner',
        'note',
      ],
      quotations: [
        'companyId',
        'number',
        'contactName',
        'issueDate',
        'status',
        'quotationType',
        ...(legacyLocked ? [] : ['items' as const]),
        'note',
      ],
      installations: [
        'companyId',
        'systemCode',
        'serviceVersion',
        'version',
        'installedAt',
        'patchedAt',
        'engineer',
        'accessType',
        'autoUpdate',
        'domain',
        'note',
      ],
      activities: ['type', 'title', 'body', 'activityDate'],
    };
    const nativeFields = new FormData(event.currentTarget as HTMLFormElement);
    const current = Object.fromEntries(
      keys[kind].map((key) => [
        key,
        ['issueDate', 'installedAt', 'patchedAt', 'activityDate'].includes(key)
          ? String(nativeFields.get(key) ?? draft[key] ?? '')
          : (draft[key] ?? (key === 'relatedCompanyIds' ? [] : '')),
      ]),
    );
    const original = Object.fromEntries(
      keys[kind].map((key) => [key, initialDraft.current[key] ?? (key === 'relatedCompanyIds' ? [] : '')]),
    );
    const payload = businessFormPayload(
      current,
      isNew ? null : original,
      openedPolicy.current,
      currentPolicy.current,
    );
    if (!isNew && !Object.keys(payload).length) {
      onClose();
      return;
    }
    if (kind === 'quotations' && !legacyLocked && calculate(draft.items || []).invalid) {
      setError('견적 금액이 처리 가능한 범위를 넘었습니다. 품목의 단가와 수량을 확인해 주세요.');
      return;
    }
    if (
      kind === 'installations' &&
      draft.installedAt &&
      draft.patchedAt &&
      draft.patchedAt < draft.installedAt
    ) {
      setError('최근 패치일은 최초 설치일보다 빠를 수 없습니다.');
      return;
    }
    savingRequest.current = true;
    setSaving(true);
    try {
      await api(
        kind === 'activities'
          ? record === 'new'
            ? `/companies/${encodeURIComponent(draft.companyId || '')}/activities`
            : `/activities/${encodeURIComponent(record.id)}`
          : isRevision
            ? `/records/quotations/${encodeURIComponent((record as RecordRow).revisionSourceId!)}/revisions`
            : `/records/${kind}${isNew ? '' : `/${encodeURIComponent((record as RecordRow).id)}`}`,
        { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(payload) },
      );
      if (isCurrent()) onSaved();
    } catch (e) {
      if (isCurrent()) setError((e as Error).message);
    } finally {
      savingRequest.current = false;
      if (isCurrent()) setSaving(false);
    }
  };
  return (
    <RecordFormFrame
      inline={inline}
      kind={kind}
      saving={saving}
      onClose={onClose}
      onRestoreFocus={onRestoreFocus}
    >
      <div className="m-dialog-heading">
        <span className="m-record-icon">
          <config.icon size={22} />
        </span>
        <div>
          <Title>
            {isRevision
              ? t('{0} 새 버전 작성', [t(config.singular)])
              : isNew
                ? t('{0} 추가', [t(config.singular)])
                : t('{0} 수정', [t(config.singular)])}
          </Title>
          <Description>{t('고객사와 연결할 정보를 입력하세요. * 표시는 필수입니다.')}</Description>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('{0} 입력 닫기', [t(config.singular)])}
          onClick={onClose}
          disabled={saving}
        >
          <X size={20} />
        </button>
      </div>
      <form autoComplete="off" spellCheck={false} onSubmit={save}>
        <div className="m-form-scroll">
          <div className="form-grid">
            <Field label={record === 'new' || record.companyId ? t('고객사 *') : t('고객사')} wide>
              <select
                required={record === 'new' || Boolean(record.companyId)}
                value={draft.companyId || ''}
                onChange={(e) => update('companyId', e.target.value)}
              >
                <option value="">
                  {record !== 'new' && !record.companyId ? t('고객사 연결 없음') : t('고객사를 선택하세요')}
                </option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </Field>
            {kind === 'contacts' ? (
              <>
                {input('name', '담당자 이름', {
                  required: true,
                  placeholder: '예: 김새봄',
                  maxLength: 100,
                })}
                {select('type', '담당 유형', ['인사', '전산', '재무', '기타', '미분류'])}
                {input('department', '부서', { placeholder: '예: 인사팀', maxLength: 100 })}
                {input('role', '직책', { placeholder: '예: 과장', maxLength: 100 })}
                {input('phone', '전화번호', { type: 'tel', maxLength: 30 })}
                {input('mobile', '휴대전화', { type: 'tel', maxLength: 30 })}
                {input('fax', '팩스', { type: 'tel', maxLength: 40 })}
                {input('zipcode', '우편번호', { maxLength: 20 })}
                {input('workplace', '근무처', { maxLength: 500, wide: true })}
                {input('email', '이메일', {
                  type: 'email',
                  wide: true,
                  placeholder: 'name@example.com',
                  maxLength: 254,
                })}
              </>
            ) : kind === 'sales' ? (
              <>
                {input('name', '영업 기회명', {
                  required: true,
                  wide: true,
                  placeholder: '예: 2026 연말정산 서비스 도입',
                  maxLength: 200,
                })}
                {select('customerType', '고객 유형', ['신규', '고객', '회귀', '재영업', '재계약'])}
                {select('stage', '영업 단계', stages)}
                {select('serviceVersion', '서비스', versions)}
                {input('owner', '내부 담당자', { maxLength: 100 })}
                {numeric('employees', '임직원 수', 100_000_000)}
                {numeric('expectedRevenue', '예상 매출 (원)')}
                <Field label={t('서비스 대상 고객사 (복수 선택)')} wide>
                  <select
                    multiple
                    size={5}
                    value={draft.relatedCompanyIds || []}
                    onChange={(e) =>
                      update(
                        'relatedCompanyIds',
                        [...e.target.selectedOptions].map((option) => option.value),
                      )
                    }
                  >
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </select>
                  <small>
                    {t('대표 고객사는 항상 포함합니다. Command 또는 Ctrl 키로 여러 고객사를 선택하세요.')}
                  </small>
                </Field>
                {input('failedReason', '실패 사유', { maxLength: 10000, wide: true })}
                <Field label={t('재영업 가능성')}>
                  <select
                    value={draft.retryProbability || ''}
                    onChange={(event) => update('retryProbability', event.target.value)}
                  >
                    <option value="">{t('미등록')}</option>
                    {['상', '중', '하', '불가'].map((value) => (
                      <option key={value} value={value}>
                        {t(value)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('가중치 적용 예상 매출')}>
                  <input
                    value={`${salesWeight(draft, weightPolicy)}% · ${money(weightedRevenue(draft, weightPolicy))}원`}
                    readOnly
                  />
                  <small>{t('영업 단계의 가중치를 적용합니다.')}</small>
                </Field>
              </>
            ) : kind === 'quotations' ? (
              <>
                {input('number', '견적 번호', {
                  required: true,
                  placeholder: '예: YETA-2026-001',
                  maxLength: 80,
                })}
                {input('issueDate', '발행일', { required: !legacyLocked, type: 'date' })}
                {input('contactName', '수신 담당자', { maxLength: 100 })}
                {select('quotationType', '계약 유형', ['신규계약', '재계약', '미분류'])}
                {user?.role === 'admin' ? (
                  select('status', '견적 상태', ['발행', '승인', '반려'])
                ) : (
                  <Field label={t('견적 상태')}>
                    <input value={draft.status || '발행'} readOnly />
                    <small>{t('승인·반려는 관리자가 결정합니다.')}</small>
                  </Field>
                )}
              </>
            ) : kind === 'installations' ? (
              <>
                {input('systemCode', '시스템 코드', {
                  required: true,
                  maxLength: 80,
                  placeholder: '예: YETA-CLOUD-001',
                })}
                {select('serviceVersion', '서비스', versions)}
                {input('version', '설치 버전', { placeholder: '예: 2026.1.0', maxLength: 80 })}
                {input('engineer', '담당 엔지니어', { maxLength: 100 })}
                {input('installedAt', '최초 설치일', { type: 'date' })}
                {input('patchedAt', '최근 패치일', { type: 'date' })}
                {select('accessType', '접근 방식', ['알 수 없음', '바로 접근', '원격', '불가', 'VPN/VDI'])}
                <div className="field">
                  <span>{t('자동 업데이트')}</span>
                  <label className="m-checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.autoUpdate)}
                      onChange={(e) => update('autoUpdate', e.target.checked)}
                    />
                    {t('자동 업데이트 사용')}
                  </label>
                </div>
                {input('domain', '서비스 도메인', {
                  wide: true,
                  placeholder: '예: service.example.com',
                  maxLength: 253,
                })}
              </>
            ) : (
              <>
                <Field label={t('활동 유형')}>
                  <select value={draft.type} onChange={(e) => update('type', e.target.value)}>
                    {Object.entries(activityLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {t(label)}
                      </option>
                    ))}
                  </select>
                </Field>
                {input('activityDate', '활동일', { type: 'date' })}
                <Field label={t('기록자')}>
                  <input value={user?.name || ''} readOnly />
                </Field>
                {input('title', '활동 제목', {
                  required: true,
                  wide: true,
                  placeholder: '예: 도입 상담 및 다음 미팅 일정 확인',
                  maxLength: 200,
                })}
                <Field label={t('활동 내용 *')} wide>
                  <textarea
                    required
                    rows={5}
                    maxLength={5000}
                    value={draft.body || ''}
                    onChange={(e) => update('body', e.target.value)}
                    placeholder={t('대화 내용과 다음에 해야 할 일을 기록하세요.')}
                  />
                </Field>
              </>
            )}
          </div>
          {kind === 'quotations' && (
            <section className="m-line-section">
              {isRevision && (
                <p className="m-calculation-note">
                  {t(
                    '원본 견적을 보존하고 별도 견적을 생성합니다. 새 버전의 품목과 할인·부가세 계산 결과를 확인한 뒤 저장하세요.',
                  )}
                </p>
              )}
              <div className="m-line-heading">
                <h3>{t('견적 품목')}</h3>
                {!legacyLocked && (
                  <button
                    type="button"
                    className="button"
                    disabled={(draft.items || []).length >= 100}
                    onClick={() => update('items', [...(draft.items || []), freshLine()])}
                  >
                    <Plus size={15} />
                    {t('품목 추가')}
                  </button>
                )}
              </div>
              {legacyLocked ? (
                <>
                  <p className="m-calculation-note">
                    {t(
                      '이관된 견적은 원본 품목과 금액을 보존합니다. 상태와 메모 등 기본 정보만 수정할 수 있습니다.',
                    )}
                  </p>
                  <QuoteItems row={draft} />
                  <QuoteTotals amounts={quotationAmounts(draft)} original />
                </>
              ) : (
                <>
                  <div className="form-grid">
                    <Field label={t('목표 청구액 (VAT 포함, 원)')}>
                      <input
                        type="number"
                        min="0"
                        max={Number.MAX_SAFE_INTEGER}
                        step="1"
                        value={targetAmount}
                        onChange={(e) => setTargetAmount(e.target.value)}
                      />
                    </Field>
                    <div className="field">
                      <span>{t('할인 역산')}</span>
                      <button
                        type="button"
                        className="button"
                        disabled={!targetAmount}
                        onClick={() => {
                          try {
                            update('items', quotationForTarget(draft.items || [], Number(targetAmount)));
                            setError('');
                          } catch (error) {
                            setError((error as Error).message);
                          }
                        }}
                      >
                        {t('목표액에 맞추기')}
                      </button>
                      <small>{t('기존 단가를 유지하며 뒤 품목부터 고정 할인을 배분합니다.')}</small>
                    </div>
                  </div>
                  {catalogueError && (
                    <p className="m-calculation-note">
                      {t('상품 목록을 불러오지 못했습니다. 품목명과 단가를 직접 입력할 수 있습니다.')}
                    </p>
                  )}
                  <div className="m-line-editor">
                    {(draft.items || []).map((item, index) => (
                      <fieldset className="m-line-item" key={index}>
                        <legend>
                          {t('품목 ')}
                          {index + 1}
                        </legend>
                        <Field label={t('견적 상품 선택')}>
                          <select
                            value={item.catalogueItemId || ''}
                            onChange={(e) => {
                              const selected = catalogue.find((product) => product.id === e.target.value);
                              if (selected)
                                update(
                                  'items',
                                  (draft.items || []).map((line, position) =>
                                    position === index
                                      ? {
                                          ...line,
                                          catalogueItemId: selected.id,
                                          name: selected.name,
                                          unitPrice: selected.unitPrice,
                                        }
                                      : line,
                                  ),
                                );
                              else updateLine(index, 'catalogueItemId', '');
                            }}
                          >
                            <option value="">{t('직접 입력')}</option>
                            {catalogue.map((product) => (
                              <option key={product.id} value={product.id}>
                                {product.name} · {money(product.unitPrice)}
                                {t('원')}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <div className="m-line-fields">
                          <Field label={t('품목명 *')}>
                            <input
                              required
                              maxLength={200}
                              value={item.name}
                              onChange={(e) => updateLine(index, 'name', e.target.value)}
                              placeholder={t('예: YETA Cloud 연간 이용료')}
                            />
                          </Field>
                          <Field label={t('단가 (원) *')}>
                            <input
                              required
                              type="number"
                              min="0"
                              max={Number.MAX_SAFE_INTEGER}
                              step="1"
                              value={item.unitPrice}
                              onChange={(e) => updateLine(index, 'unitPrice', Number(e.target.value))}
                            />
                          </Field>
                          <Field label={t('수량 *')}>
                            <input
                              required
                              type="number"
                              min="1"
                              max="100000"
                              step="1"
                              value={item.quantity}
                              onChange={(e) => updateLine(index, 'quantity', Number(e.target.value))}
                            />
                          </Field>
                          <Field label={t('개월 *')}>
                            <input
                              required
                              type="number"
                              min="1"
                              max="1200"
                              step="1"
                              value={item.months}
                              onChange={(e) => updateLine(index, 'months', Number(e.target.value))}
                            />
                          </Field>
                          <Field label={t('할인 방식')}>
                            <select
                              value={item.discountType || 'percent'}
                              onChange={(e) => updateLine(index, 'discountType', e.target.value)}
                            >
                              <option value="percent">{t('할인율 (%)')}</option>
                              <option value="amount">{t('고정 금액 (원)')}</option>
                            </select>
                          </Field>
                          <Field
                            label={item.discountType === 'amount' ? t('할인 금액 (원)') : t('할인율 (%)')}
                          >
                            <input
                              required
                              type="number"
                              min="0"
                              max={item.discountType === 'amount' ? Number.MAX_SAFE_INTEGER : 100}
                              step={item.discountType === 'amount' ? '1' : '0.01'}
                              value={
                                item.discountType === 'amount'
                                  ? item.discountAmount || 0
                                  : item.discountPercent
                              }
                              onChange={(e) =>
                                updateLine(
                                  index,
                                  item.discountType === 'amount' ? 'discountAmount' : 'discountPercent',
                                  Number(e.target.value),
                                )
                              }
                            />
                          </Field>
                          <button
                            type="button"
                            className="icon-button m-delete-line"
                            aria-label={t('품목 {0} 삭제', [index + 1])}
                            disabled={(draft.items || []).length === 1}
                            onClick={() =>
                              update(
                                'items',
                                (draft.items || []).filter((_, position) => position !== index),
                              )
                            }
                          >
                            <Trash2 size={17} />
                          </button>
                        </div>
                        <div className="m-line-amount">
                          {t('공급가액')}{' '}
                          <strong>
                            {calculate([item]).invalid
                              ? t('금액 확인 필요')
                              : t('{0}원', [money(calculate([item]).supplyAmount)])}
                          </strong>
                        </div>
                      </fieldset>
                    ))}
                  </div>
                  <QuoteTotals amounts={calculate(draft.items || [])} />
                  <p className="m-calculation-note">
                    {t('품목별 할인 금액과 부가세는 원 단위로 반올림합니다.')}
                  </p>
                </>
              )}
            </section>
          )}
          {kind === 'contacts' && (
            <Field label={t('새 코멘트')} wide>
              <textarea
                rows={3}
                maxLength={10000}
                value={draft.comment || ''}
                onChange={(e) => update('comment', e.target.value)}
                placeholder={t('저장하면 날짜와 함께 코멘트 이력에 추가됩니다.')}
              />
            </Field>
          )}
          {kind !== 'activities' && (
            <Field label={t('관리 메모')} wide>
              <textarea
                rows={3}
                maxLength={5000}
                value={draft.note || ''}
                onChange={(e) => update('note', e.target.value)}
                placeholder={t('업무에 필요한 내용을 기록하세요.')}
              />
            </Field>
          )}
          {error && (
            <div className="error-box" role="alert">
              {t(error)}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            {t('취소')}
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? <RefreshCw size={16} /> : <Check size={16} />}
            {saving ? t('저장 중…') : t('저장하기')}
          </button>
        </div>
      </form>
    </RecordFormFrame>
  );
}
