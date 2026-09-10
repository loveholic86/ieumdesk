import { t, getLocaleTag } from './i18n';
import { useLocale } from './use-locale';
import { LanguageSelector } from './LanguageSelector';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Activity as ActivityIcon,
  ArrowDown,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Building2,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  ExternalLink,
  FileText,
  LayoutDashboard,
  ListTodo,
  LogOut,
  ShieldCheck,
  Settings2,
  UserRound,
  Server,
  TrendingUp,
  Mail,
  Menu,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, dateLabel, downloadCsv, money, statusLabels } from './api';
import { emailHref, phoneHref, safeWebsite } from './client-security';
import type { Activity, Company, CompanyList, CompanyStatus, Health, Task } from './types';
import Modules, { type ModuleKind } from './Modules';
import { useAuth, roleLabels } from './auth';
import { AccountPage, UsersPage } from './AccountPages';
import SettingsPage from './SettingsPage';
import SupportPage from './SupportPage';
import { useWorkspaceSettings } from './workspace-settings';
import { defaultWorkspaceBranding, menuDefinitions, type MenuKey } from './workspace-types';
import { ArchiveButton } from './ArchivedPage';
import { businessFormPayload, businessFormPolicy, businessFormPolicyMatches } from './business-form-client';

const blankCompany: Omit<Company, 'id' | 'updatedAt'> = {
  name: '',
  businessNumber: '',
  industry: '',
  ceo: '',
  contactName: '',
  contactRole: '',
  email: '',
  phone: '',
  owner: '',
  status: 'prospect',
  products: [],
  employees: 0,
  contractStart: '',
  contractEnd: '',
  contractAmount: 0,
  website: '',
  address: '',
  note: '',
  companyCode: '',
  corporationNumber: '',
  companyType: '',
  groupName: '',
  firstContactDate: '',
  contactSource: '',
  contactDetail: '',
  serviceVersion: '',
};
const services = ['YETA'];
type View = 'companies' | 'overview' | 'tasks' | 'account' | 'users' | 'settings' | 'support' | ModuleKind;
type Toast = { text: string; error?: boolean } | null;

function Status({ status }: { status: CompanyStatus }) {
  useLocale();
  return (
    <span className={`status status-${status}`}>
      <span />
      {t(statusLabels[status])}
    </span>
  );
}
function BrandMark({ small = false }: { small?: boolean }) {
  useLocale();
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`}>
      <span />
      <span />
      <span />
    </span>
  );
}
function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  useLocale();
  return (
    <div className="empty">
      <Search size={28} strokeWidth={1.4} />
      <h3>{t(title)}</h3>
      {body && <p>{t(body)}</p>}
      {action}
    </div>
  );
}
function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  useLocale();
  return (
    <div className="error-box" role="alert">
      <span>{t(message)}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          <RefreshCw size={15} />
          {t('다시 시도')}
        </button>
      )}
    </div>
  );
}
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useLocale();
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{t(label)}</span>
      {children}
    </label>
  );
}
function Info({ label, value }: { label: string; value?: React.ReactNode }) {
  useLocale();
  return (
    <div className="info-row">
      <dt>{t(label)}</dt>
      <dd>{value || <span className="muted">{t('미등록')}</span>}</dd>
    </div>
  );
}
function useDialogReturnFocus() {
  const trigger = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      requestAnimationFrame(() => {
        const target = trigger.current?.isConnected
          ? trigger.current
          : document.querySelector<HTMLElement>('nav [aria-current="page"]');
        target?.focus();
      });
    },
  };
}
function initials(name: string) {
  return (
    name
      .replace(/\(주\)|주식회사/g, '')
      .trim()
      .slice(0, 1) || 'Y'
  );
}
export default function App() {
  const locale = useLocale();
  const { user, canWrite, logout } = useAuth();
  const workspaceSettings = useWorkspaceSettings();
  const { brandName, workspaceName } = workspaceSettings.settings ?? defaultWorkspaceBranding;
  const [loggingOut, setLoggingOut] = useState(false);
  const [requestedView, setView] = useState<View>(() => {
    const saved = window.location.hash.slice(1);
    return [
      'companies',
      'overview',
      'tasks',
      'contacts',
      'activities',
      'sales',
      'quotations',
      'installations',
      'support',
      'account',
      'users',
      'settings',
    ].includes(saved)
      ? (saved as View)
      : 'companies';
  });
  const menuAvailable = (next: View) =>
    !menuDefinitions.some(([key]) => key === next) ||
    workspaceSettings.settings?.menus[next as MenuKey] === true;
  const fallbackView: View = user?.role === 'admin' ? 'settings' : 'account';
  const view: View = menuAvailable(requestedView) ? requestedView : fallbackView;
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => {
    if (!mobileNav) return;
    const panel = document.querySelector<HTMLElement>('.sidebar');
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel?.querySelector<HTMLElement>('nav [aria-current="page"]')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileNav(false);
      }
      if (event.key !== 'Tab' || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener('keydown', handleKey);
      document.querySelector<HTMLElement>('.mobile-menu')?.focus();
    };
  }, [mobileNav]);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [product, setProduct] = useState('');
  const [owner, setOwner] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('updatedAt');
  const [allError, setAllError] = useState('');
  const [allLoading, setAllLoading] = useState(true);
  const [result, setResult] = useState<CompanyList>();
  const [allCompanies, setAllCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editCompany, setEditCompany] = useState<Company | 'new' | null>(null);
  const [health, setHealth] = useState<Health>();
  const [healthFailed, setHealthFailed] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [help, setHelp] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskError, setTaskError] = useState('');
  const [taskFilter, setTaskFilter] = useState('open');
  const [newTask, setNewTask] = useState(false);
  const [editTask, setEditTask] = useState<Task>();
  const [taskBusy, setTaskBusy] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(q);
      setPage(1);
      setSelected([]);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        if (!workspaceSettings.settings?.menus.companies) return;
        setView('companies');
        window.location.hash = 'companies';
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [workspaceSettings.settings?.menus.companies]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      q: query,
      status,
      serviceVersion: product,
      owner,
      page: String(page),
      pageSize: '8',
      sort,
      order: sort === 'updatedAt' ? 'desc' : 'asc',
    });
    api<CompanyList>(`/companies?${params}`, { signal: controller.signal })
      .then((data) => {
        const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setResult(data);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, status, product, owner, page, sort, refresh]);
  useEffect(() => {
    api<Health>('/health')
      .then((data) => {
        setHealth(data);
        setHealthFailed(false);
      })
      .catch(() => {
        setHealth(undefined);
        setHealthFailed(true);
      });
    setAllLoading(true);
    setAllError('');
    const loadAll = async () => {
      const first = await api<CompanyList>('/companies?pageSize=100&page=1');
      const totalPages = Math.ceil(first.total / first.pageSize);
      const more = await Promise.all(
        Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
          api<CompanyList>(`/companies?pageSize=100&page=${i + 2}`),
        ),
      );
      setAllCompanies([...first.items, ...more.flatMap((data) => data.items)]);
    };
    loadAll()
      .catch((e) => setAllError(e.message))
      .finally(() => setAllLoading(false));
    api<{ items: Task[] }>('/tasks')
      .then((data) => {
        setTasks(data.items);
        setTaskError('');
      })
      .catch((e) => setTaskError(e.message));
  }, [refresh]);

  const changeView = (next: View) => {
    const available = menuAvailable(next) ? next : fallbackView;
    setView(available);
    window.location.hash = available;
    setMobileNav(false);
  };
  useEffect(() => {
    const onHash = () => {
      const value = window.location.hash.slice(1);
      if (
        [
          'companies',
          'overview',
          'tasks',
          'contacts',
          'activities',
          'sales',
          'quotations',
          'installations',
          'support',
          'account',
          'users',
          'settings',
        ].includes(value)
      )
        setView(value as View);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const resetFilters = () => {
    setQ('');
    setQuery('');
    setStatus('');
    setProduct('');
    setOwner('');
    setPage(1);
    setSelected([]);
  };
  const filter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
    setSelected([]);
  };
  const refreshData = () => {
    setRefresh((value) => value + 1);
    setSelected([]);
  };
  const owners = [...new Set(allCompanies.map((company) => company.owner).filter(Boolean))].sort();
  const products = [...new Set([...services, ...allCompanies.flatMap((company) => company.products)])];
  const activeFilters = Boolean(query || status || product || owner);
  const openTasks = tasks.filter((task) => !task.completed);
  const stats = result?.stats;
  const filteredTasks = tasks.filter(
    (task) => taskFilter === 'all' || (taskFilter === 'done' ? task.completed : !task.completed),
  );
  const dueSoon = allCompanies
    .filter(
      (c) =>
        c.contractEnd &&
        c.status === 'active' &&
        daysUntil(c.contractEnd) >= 0 &&
        daysUntil(c.contractEnd) <= 30,
    )
    .sort((a, b) => a.contractEnd.localeCompare(b.contractEnd));
  const exportRows = async () => {
    try {
      const rows = selected.length
        ? (result?.items ?? []).filter((c) => selected.includes(c.id))
        : (result?.items ?? []);
      downloadCsv(
        rows.map((c) => ({
          고객사코드: c.companyCode,
          고객사명: c.name,
          서비스버전: c.serviceVersion,
          사업자등록번호: c.businessNumber,
          업종: c.industry,
          이용상태: statusLabels[c.status],
          서비스: c.products.join(' / '),
          담당자: c.contactName,
          이메일: c.email,
          전화번호: c.phone,
          내부담당: c.owner,
          계약종료일: c.contractEnd,
        })),
        'ieumdesk_고객사.csv',
      );
      notify(`${rows.length}개 고객사 정보를 내보냈습니다.`);
    } catch {
      notify('내보내기에 실패했습니다.', true);
    }
  };
  const toggleTask = async (task: Task) => {
    if (!canWrite) return;
    setTaskBusy(task.id);
    try {
      await api(`/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ completed: !task.completed }),
      });
      refreshData();
      notify(task.completed ? '업무를 진행 중으로 변경했습니다.' : '업무를 완료했습니다.');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setTaskBusy(null);
    }
  };
  const changeTaskStatus = async (task: Task, next: string) => {
    if (!canWrite) return;
    setTaskBusy(task.id);
    try {
      await api(`/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next, completed: next === 'done' }),
      });
      refreshData();
      notify('업무 상태를 변경했습니다.');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setTaskBusy(null);
    }
  };
  const navItems: { id: View; label: string; icon: LucideIcon; count?: number }[] = [
    { id: 'overview', label: '업무 현황', icon: LayoutDashboard },
    { id: 'companies', label: '고객사 관리', icon: Building2 },
    { id: 'contacts', label: '담당자 관리', icon: Users },
    { id: 'activities', label: '활동 관리', icon: ActivityIcon },
    { id: 'tasks', label: 'TASK 관리', icon: ListTodo, count: openTasks.length },
    { id: 'sales', label: '영업 관리', icon: TrendingUp },
    { id: 'quotations', label: '견적 관리', icon: FileText },
    { id: 'installations', label: '설치 관리', icon: Server },
    { id: 'support', label: '고객지원 · 공지', icon: CircleHelp },
  ];

  const accountItems: { id: View; label: string; icon: LucideIcon }[] = [
    { id: 'account', label: '내 계정', icon: UserRound },
    ...(user?.role === 'admin' ? [{ id: 'users' as View, label: '사용자 및 권한', icon: ShieldCheck }] : []),
    ...(user?.role === 'admin' ? [{ id: 'settings' as View, label: '환경설정', icon: Settings2 }] : []),
  ];
  const pageTitle = [...navItems, ...accountItems].find((item) => item.id === view)?.label || '내 계정';
  const accountView = view === 'account' || view === 'users' || view === 'settings';
  useEffect(() => {
    if ((view === 'users' || view === 'settings') && user?.role !== 'admin') changeView('account');
  }, [view, user?.role]);
  useEffect(() => {
    if (workspaceSettings.settings && requestedView !== view) {
      setView(view);
      window.location.hash = view;
    }
  }, [workspaceSettings.settings, requestedView, view]);
  useEffect(() => {
    if (!canWrite) setEditCompany(null);
  }, [canWrite]);
  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoggingOut(false);
    }
  };

  const moduleView = ['contacts', 'activities', 'sales', 'quotations', 'installations'].includes(view);
  useEffect(() => {
    document.title = `${brandName} · ${t(pageTitle)}`;
  }, [brandName, pageTitle, locale]);

  if (!workspaceSettings.settings)
    return (
      <main className="settings-page" style={{ padding: 32 }}>
        <h1>{t('CRM 환경설정')}</h1>
        {workspaceSettings.error ? (
          <ErrorBox
            message={workspaceSettings.error}
            retry={() => void workspaceSettings.refresh().catch(() => {})}
          />
        ) : (
          <div className="empty" role="status">
            {t('환경설정을 확인하는 중입니다…')}
          </div>
        )}
      </main>
    );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t('본문으로 이동')}
      </a>
      {mobileNav && (
        <button className="nav-backdrop" aria-label={t('메뉴 닫기')} onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`} aria-label={t('주 메뉴')}>
        <a
          className="brand"
          href="#companies"
          onClick={(e) => {
            e.preventDefault();
            changeView('companies');
          }}
        >
          <BrandMark />
          <span className="brand-name" title={brandName}>
            {brandName}
          </span>
        </a>
        <div className="workspace">
          <div className="workspace-icon" aria-hidden="true">
            {Array.from(workspaceName)[0].toUpperCase()}
          </div>
          <div>
            <strong title={workspaceName}>{workspaceName}</strong>
            <span>{t('고객관리 워크스페이스')}</span>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navItems
            .filter((item) => menuAvailable(item.id))
            .map((item) => (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                onClick={() => changeView(item.id)}
                aria-current={view === item.id ? 'page' : undefined}
              >
                <item.icon size={19} strokeWidth={1.7} />
                <span>{t(item.label)}</span>
                {item.count ? <span className="nav-count">{item.count}</span> : null}
              </button>
            ))}
          <div className="nav-label account-nav-label">ACCOUNT</div>
          {accountItems
            .filter((item) => menuAvailable(item.id))
            .map((item) => (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                onClick={() => changeView(item.id)}
                aria-current={view === item.id ? 'page' : undefined}
              >
                <item.icon size={19} strokeWidth={1.7} />
                <span>{t(item.label)}</span>
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-note">
            <span className={`connection-dot ${healthFailed ? 'offline' : ''}`} />
            <span>
              {healthFailed
                ? t('서버 연결 확인 필요')
                : health?.mode === 'postgres'
                  ? t('PostgreSQL 연결')
                  : t('개발용 데모 워크스페이스')}
            </span>
          </div>
          <button className="nav-item secondary" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            <span>{t('사용 안내')}</span>
            <ArrowUpRight size={15} />
          </button>
          <div className="profile">
            <button
              className="profile-account"
              onClick={() => changeView('account')}
              aria-label={t('내 계정 보기')}
            >
              <span className="avatar">{initials(user?.name || '')}</span>
              <span className="profile-copy">
                <strong>{user?.name}</strong>
                <span>{user ? t(roleLabels[user.role], undefined, 'role') : ''}</span>
              </span>
            </button>
            <button
              className="icon-button logout-button"
              aria-label={t('로그아웃')}
              title={t('로그아웃')}
              disabled={loggingOut}
              onClick={handleLogout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label={t('메뉴 열기')}
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>{t('워크스페이스')}</span>
            <ChevronRight size={14} />
            <strong>{t(pageTitle)}</strong>
          </div>
          <div className="topbar-right">
            <LanguageSelector />
            <span className="today">
              <CalendarDays size={15} />
              {new Date().toLocaleDateString(getLocaleTag(), {
                month: 'long',
                day: 'numeric',
                weekday: 'short',
              })}
            </span>
            <span className="topbar-divider" />
            <span className={`mode-tag ${health?.mode === 'postgres' ? 'live' : ''}`}>
              {healthFailed ? t('연결 오류') : health?.mode === 'postgres' ? t('DB 연결') : 'DEMO'}
            </span>
            <button
              className="avatar tiny topbar-account-avatar"
              aria-label={t('내 계정 열기')}
              onClick={() => changeView('account')}
            >
              {initials(user?.name || '')}
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {['companies', 'overview', 'tasks'].includes(view) && (
            <div className="page-heading">
              <div>
                <div className="eyebrow">CUSTOMER RELATIONSHIP</div>
                <h1>
                  {view === 'companies'
                    ? t('고객사 관리')
                    : view === 'overview'
                      ? t('업무 현황')
                      : t('할 일')}
                </h1>
                <p>
                  {view === 'companies'
                    ? t('고객의 정보부터 다음 상담까지, 한곳에서 이어가세요.')
                    : view === 'overview'
                      ? t('지금 확인해야 할 고객과 업무를 살펴보세요.')
                      : t('고객과 약속한 다음 단계를 놓치지 마세요.')}
                </p>
              </div>
              {canWrite && (
                <button
                  className="button primary"
                  onClick={() => (view === 'tasks' ? setNewTask(true) : setEditCompany('new'))}
                >
                  <Plus size={18} />
                  {view === 'tasks' ? t('할 일 추가') : t('고객사 등록')}
                </button>
              )}
            </div>
          )}

          {['companies', 'overview'].includes(view) && (
            <section className="summary-strip" aria-label={t('고객사 요약')}>
              <Summary
                label={t('전체 고객사')}
                value={stats?.total}
                icon={Building2}
                selected={view === 'companies' && !status}
                onClick={() => {
                  changeView('companies');
                  filter(setStatus, '');
                }}
                helper={t('등록된 고객사')}
              />
              <Summary
                label={t('서비스 이용 중')}
                value={stats?.active}
                icon={CheckCheck}
                selected={status === 'active'}
                onClick={() => {
                  changeView('companies');
                  filter(setStatus, 'active');
                }}
                helper={t('계약이 활성화된 고객사')}
                tone="green"
              />
              <Summary
                label={t('도입 상담')}
                value={stats?.prospect}
                icon={Users}
                selected={status === 'prospect'}
                onClick={() => {
                  changeView('companies');
                  filter(setStatus, 'prospect');
                }}
                helper={t('새로운 관계를 시작하는 중')}
              />
              <Summary
                label={t('30일 내 계약 만료')}
                value={stats?.renewalDue}
                icon={CalendarDays}
                onClick={() => changeView('overview')}
                helper={t('갱신 일정 확인이 필요해요')}
                tone="amber"
              />
            </section>
          )}

          {view === 'companies' && (
            <section className="company-section">
              <div className="section-title">
                <div>
                  <h2>{t('고객사 목록')}</h2>
                  <span className="count-chip">{result?.total ?? '—'}</span>
                </div>
                <button
                  className="text-button export-button"
                  onClick={exportRows}
                  disabled={!result?.items.length || loading || Boolean(error)}
                >
                  <Download size={16} />
                  {selected.length ? t('선택 {0}개 내보내기', [selected.length]) : t('현재 페이지 내보내기')}
                </button>
              </div>
              <div className="filter-bar">
                <label className="search-field">
                  <Search size={18} />
                  <input
                    ref={searchRef}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t('고객사, 코드, 담당자 검색')}
                    aria-label={t('고객사 검색')}
                  />
                  <kbd>⌘ K</kbd>
                  {q && (
                    <button className="icon-button" onClick={() => setQ('')} aria-label={t('검색어 지우기')}>
                      <X size={15} />
                    </button>
                  )}
                </label>
                <div className="filters">
                  <SelectFilter
                    label={t('이용 상태')}
                    value={status}
                    onChange={(v) => filter(setStatus, v)}
                    options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
                  />
                  <SelectFilter
                    label={t('서비스 버전')}
                    value={product}
                    onChange={(v) => filter(setProduct, v)}
                    options={['SAP', 'On Premises', 'Cloud'].map((value) => ({ value, label: value }))}
                  />
                  <SelectFilter
                    label={t('내부 담당자')}
                    value={owner}
                    onChange={(v) => filter(setOwner, v)}
                    options={owners.map((value) => ({ value, label: value }))}
                    localizeOptions={false}
                  />
                </div>
              </div>
              <div className="list-context">
                <div>
                  {activeFilters ? (
                    <>
                      <span>
                        {t('검색 결과 ')}
                        <strong>{result?.total ?? 0}</strong>
                        {t('개')}
                      </span>
                      <button className="text-button" onClick={resetFilters}>
                        <X size={13} />
                        {t('필터 초기화')}
                      </button>
                    </>
                  ) : (
                    <span>{t('고객사를 선택하면 상세 정보와 상담 이력을 확인할 수 있습니다.')}</span>
                  )}
                </div>
                <label className="sort-label">
                  <SlidersHorizontal size={14} />
                  <select
                    aria-label={t('목록 정렬')}
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value);
                      setPage(1);
                      setSelected([]);
                    }}
                  >
                    <option value="updatedAt">{t('최근 수정순')}</option>
                    <option value="name">{t('고객사 이름순')}</option>
                    <option value="contractEnd">{t('계약 만료순')}</option>
                  </select>
                  <ChevronDown size={12} />
                </label>
              </div>
              {error ? (
                <ErrorBox message={error} retry={refreshData} />
              ) : (
                <div className={`table-container ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
                  <table>
                    <thead>
                      <tr>
                        <th className="checkbox-cell">
                          <input
                            type="checkbox"
                            aria-label={t('현재 페이지 전체 선택')}
                            checked={Boolean(
                              result?.items.length && result.items.every((c) => selected.includes(c.id)),
                            )}
                            onChange={(e) =>
                              setSelected(e.target.checked ? (result?.items.map((c) => c.id) ?? []) : [])
                            }
                            disabled={loading}
                          />
                        </th>
                        <th>{t('고객사')}</th>
                        <th>{t('이용 상태')}</th>
                        <th className="service-column">{t('서비스 버전')}</th>
                        <th className="contact-column">{t('고객 담당자')}</th>
                        <th className="owner-column">{t('내부 담당')}</th>
                        <th className="date-column">{t('계약 종료일')}</th>
                        <th className="arrow-cell">
                          <span className="sr-only">{t('상세')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading && !result
                        ? Array.from({ length: 6 }, (_, i) => (
                            <tr key={i} className="skeleton-row">
                              <td colSpan={8}>
                                <div className="skeleton" />
                              </td>
                            </tr>
                          ))
                        : result?.items.map((company, index) => (
                            <tr
                              key={company.id}
                              className={selected.includes(company.id) ? 'row-selected' : ''}
                            >
                              <td className="checkbox-cell">
                                <input
                                  type="checkbox"
                                  aria-label={t('{0} 선택', [company.name])}
                                  checked={selected.includes(company.id)}
                                  onChange={(e) =>
                                    setSelected((prev) =>
                                      e.target.checked
                                        ? [...prev, company.id]
                                        : prev.filter((id) => id !== company.id),
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <button className="company-cell" onClick={() => setDetailId(company.id)}>
                                  <span className={`company-avatar tone-${index % 5}`}>
                                    {initials(company.name)}
                                  </span>
                                  <span>
                                    <strong>{company.name}</strong>
                                    <span className="company-meta">
                                      {company.companyCode || t('코드 미등록')}
                                      <span>·</span>
                                      {company.businessNumber || company.industry || t('사업자번호 미등록')}
                                    </span>
                                  </span>
                                </button>
                              </td>
                              <td>
                                <Status status={company.status} />
                              </td>
                              <td className="service-column">
                                <div className="product-tags">
                                  {company.serviceVersion ? (
                                    <span className="product-tag yeta">{company.serviceVersion}</span>
                                  ) : (
                                    <span className="muted">{t('미등록')}</span>
                                  )}
                                </div>
                              </td>
                              <td className="contact-column">
                                <span className="contact-name">
                                  {company.contactName || t('미등록')}
                                  {company.contactRole && <span>{company.contactRole}</span>}
                                </span>
                                <span className="table-subtext">{company.email || t('이메일 미등록')}</span>
                              </td>
                              <td className="owner-column">
                                <span className="owner-cell">
                                  {company.owner ? (
                                    <>
                                      <span className="owner-avatar">{initials(company.owner)}</span>
                                      {company.owner}
                                    </>
                                  ) : (
                                    <span className="muted">{t('미배정')}</span>
                                  )}
                                </span>
                              </td>
                              <td className="date-column">
                                <span
                                  className={`contract-date ${company.contractEnd && daysUntil(company.contractEnd) >= 0 && daysUntil(company.contractEnd) <= 30 ? 'near-due' : ''}`}
                                >
                                  {company.contractEnd ? dateLabel(company.contractEnd) : '—'}
                                </span>
                              </td>
                              <td className="arrow-cell">
                                <button
                                  className="icon-button row-arrow"
                                  aria-label={t('{0} 상세 보기', [company.name])}
                                  onClick={() => setDetailId(company.id)}
                                >
                                  <ChevronRight size={17} />
                                </button>
                              </td>
                            </tr>
                          ))}
                    </tbody>
                  </table>
                  {!loading && result?.items.length === 0 && (
                    <Empty
                      title={
                        activeFilters
                          ? t('검색 조건에 맞는 고객사가 없습니다')
                          : t('아직 등록된 고객사가 없습니다')
                      }
                      body={
                        activeFilters
                          ? '검색어를 바꾸거나 필터를 초기화해 보세요.'
                          : canWrite
                            ? '첫 고객사를 등록하고 관리를 시작하세요.'
                            : '담당자가 고객사를 등록하면 이곳에서 확인할 수 있습니다.'
                      }
                      action={
                        (activeFilters || canWrite) && (
                          <button
                            className="button"
                            onClick={activeFilters ? resetFilters : () => setEditCompany('new')}
                          >
                            {activeFilters ? t('필터 초기화') : t('고객사 등록')}
                          </button>
                        )
                      }
                    />
                  )}
                </div>
              )}
              <footer className="table-footer">
                <span>
                  {selected.length ? (
                    <strong>
                      {selected.length}
                      {t('개 선택됨')}
                    </strong>
                  ) : result?.total ? (
                    <>
                      {t('전체 {0}개 중 {1}–{2}개 표시', [
                        result.total,
                        (page - 1) * 8 + 1,
                        Math.min(page * 8, result.total),
                      ])}
                    </>
                  ) : (
                    t('0개 표시')
                  )}
                </span>
                <div className="pagination">
                  <button
                    className="icon-button"
                    aria-label={t('이전 페이지')}
                    disabled={page === 1 || loading}
                    onClick={() => {
                      setPage((p) => p - 1);
                      setSelected([]);
                    }}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  {pagination(page, Math.ceil((result?.total ?? 0) / 8)).map((item, index) =>
                    typeof item === 'number' ? (
                      <button
                        key={item}
                        aria-label={t('{0}페이지', [item])}
                        aria-current={item === page ? 'page' : undefined}
                        className={`page-number ${item === page ? 'current' : ''}`}
                        disabled={loading}
                        onClick={() => {
                          setPage(item);
                          setSelected([]);
                        }}
                      >
                        {item}
                      </button>
                    ) : (
                      <span key={`gap-${index}`}>…</span>
                    ),
                  )}
                  <button
                    className="icon-button"
                    aria-label={t('다음 페이지')}
                    disabled={page * 8 >= (result?.total ?? 0) || loading}
                    onClick={() => {
                      setPage((p) => p + 1);
                      setSelected([]);
                    }}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </footer>
            </section>
          )}

          {view === 'overview' &&
            (allError ? (
              <ErrorBox message={allError} retry={refreshData} />
            ) : allLoading && !allCompanies.length ? (
              <div className="empty" role="status">
                {t('업무 현황을 불러오는 중입니다…')}
              </div>
            ) : (
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div className="heading-icon amber">
                      <CalendarDays size={19} />
                    </div>
                    <div>
                      <h2>{t('다가오는 계약 갱신')}</h2>
                      <p>{t('30일 내 계약이 만료되는 고객사')}</p>
                    </div>
                    <span className="count-chip">{dueSoon.length}</span>
                  </div>
                  {error ? (
                    <ErrorBox message={error} retry={refreshData} />
                  ) : dueSoon.length ? (
                    dueSoon.map((company) => (
                      <button
                        key={company.id}
                        className="renewal-row"
                        onClick={() => setDetailId(company.id)}
                      >
                        <span className="company-avatar">{initials(company.name)}</span>
                        <span>
                          <strong>{company.name}</strong>
                          <small>
                            {dateLabel(company.contractEnd)} · {company.owner || t('담당 미배정')}
                          </small>
                        </span>
                        <span className="due-badge">D-{daysUntil(company.contractEnd)}</span>
                        <ChevronRight size={16} />
                      </button>
                    ))
                  ) : (
                    <Empty
                      title={t('갱신 예정 고객사가 없습니다')}
                      body="30일 이내 만료되는 계약이 여기에 표시됩니다."
                    />
                  )}
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <div className="heading-icon">
                      <ListTodo size={20} />
                    </div>
                    <div>
                      <h2>{t('진행 중인 업무')}</h2>
                      <p>{t('고객과의 다음 약속')}</p>
                    </div>
                    <button className="text-button" onClick={() => changeView('tasks')}>
                      {t('전체 보기')}
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  {taskError ? (
                    <ErrorBox message={taskError} retry={refreshData} />
                  ) : openTasks.length ? (
                    openTasks.slice(0, 5).map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        company={allCompanies.find((c) => c.id === task.companyId)}
                        busy={taskBusy === task.id}
                        toggle={() => toggleTask(task)}
                        openCompany={setDetailId}
                        onEdit={() => {
                          setEditTask(task);
                          setNewTask(true);
                        }}
                        onStatus={(next) => changeTaskStatus(task, next)}
                      />
                    ))
                  ) : (
                    <Empty
                      title={t('진행 중인 업무가 없습니다')}
                      action={
                        canWrite && (
                          <button className="button" onClick={() => setNewTask(true)}>
                            <Plus size={16} />
                            {t('할 일 추가')}
                          </button>
                        )
                      }
                    />
                  )}
                </section>
              </div>
            ))}

          {view === 'tasks' && (
            <section className="panel task-panel">
              <div className="task-toolbar">
                <div className="segmented-control" role="group" aria-label={t('업무 상태 필터')}>
                  {[
                    ['open', `진행 중 ${openTasks.length}`],
                    ['done', `완료 ${tasks.length - openTasks.length}`],
                    ['all', '전체'],
                  ].map(([id, label]) => (
                    <button key={id} aria-pressed={taskFilter === id} onClick={() => setTaskFilter(id)}>
                      {t(label)}
                    </button>
                  ))}
                </div>
                <span className="muted">{t('마감일 순으로 정렬')}</span>
              </div>
              {taskError ? (
                <ErrorBox message={taskError} retry={refreshData} />
              ) : filteredTasks.length ? (
                [...filteredTasks]
                  .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
                  .map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      company={allCompanies.find((c) => c.id === task.companyId)}
                      busy={taskBusy === task.id}
                      toggle={() => toggleTask(task)}
                      openCompany={setDetailId}
                      onEdit={() => {
                        setEditTask(task);
                        setNewTask(true);
                      }}
                      onStatus={(next) => changeTaskStatus(task, next)}
                    />
                  ))
              ) : (
                <Empty
                  title={taskFilter === 'done' ? t('완료된 업무가 없습니다') : t('표시할 업무가 없습니다')}
                  body={
                    canWrite
                      ? '고객 상담, 계약 갱신 등 필요한 일을 추가하세요.'
                      : '등록된 업무가 이곳에 표시됩니다.'
                  }
                  action={
                    canWrite && (
                      <button className="button" onClick={() => setNewTask(true)}>
                        <Plus size={16} />
                        {t('할 일 추가')}
                      </button>
                    )
                  }
                />
              )}
            </section>
          )}

          {moduleView &&
            (allError ? (
              <ErrorBox message={allError} retry={refreshData} />
            ) : allLoading && !allCompanies.length ? (
              <div className="empty" role="status">
                {t('고객사 정보를 불러오는 중입니다…')}
              </div>
            ) : (
              <Modules
                key={view}
                kind={view as ModuleKind}
                companies={allCompanies}
                refresh={refresh}
                onRefresh={refreshData}
                notify={notify}
                onCompany={setDetailId}
              />
            ))}
          {view === 'account' && <AccountPage />}
          {view === 'support' && (
            <SupportPage companies={allCompanies} notify={notify} onRefresh={refreshData} />
          )}
          {view === 'users' && user?.role === 'admin' && <UsersPage />}
          {view === 'settings' && user?.role === 'admin' && (
            <SettingsPage notify={notify} onRefresh={refreshData} />
          )}
          {!canWrite && !accountView && (
            <p className="readonly-note">
              <ShieldCheck size={14} />
              {t('조회 전용 권한으로 이용 중입니다.')}
            </p>
          )}
          <div className="page-bottom">
            <span>
              <BrandMark small />
              {brandName}
            </span>
            <span>
              {healthFailed
                ? t('서버 연결 상태를 확인해 주세요.')
                : health?.mode === 'postgres'
                  ? t('PostgreSQL 워크스페이스')
                  : t('가상 고객사로 구성된 데모입니다. 변경 내용은 이 개발 환경에 저장됩니다.')}
            </span>
          </div>
        </main>
      </div>
      <CompanyDetail
        id={detailId}
        onClose={() => setDetailId(null)}
        onEdit={setEditCompany}
        refresh={refresh}
        onRefresh={refreshData}
        notify={notify}
      />
      <CompanyForm
        company={editCompany}
        onClose={() => setEditCompany(null)}
        onSaved={(company) => {
          refreshData();
          setEditCompany(null);
          setDetailId(company.id);
          notify(editCompany === 'new' ? '고객사를 등록했습니다.' : '고객사 정보를 저장했습니다.');
        }}
        products={products}
        owners={owners}
      />
      <TaskForm
        blocked={allLoading || Boolean(allError)}
        open={newTask}
        task={editTask}
        onClose={() => {
          setNewTask(false);
          setEditTask(undefined);
        }}
        companies={allCompanies}
        notify={notify}
        onArchived={() => {
          setNewTask(false);
          setEditTask(undefined);
          refreshData();
        }}
        onSaved={() => {
          setNewTask(false);
          setEditTask(undefined);
          refreshData();
          notify('업무를 저장했습니다.');
        }}
      />
      <Dialog.Root open={help} onOpenChange={setHelp}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog help-dialog">
            <Dialog.Title>{t('{0} 사용 안내', [brandName])}</Dialog.Title>
            <Dialog.Description>{t('고객사 정보와 상담 이력을 연결해 관리하세요.')}</Dialog.Description>
            <div className="help-items">
              <p>
                <Search size={20} />
                <span>
                  <strong>{t('빠르게 찾기')}</strong>
                  {t(
                    '고객사명, 고객 담당자, 사업자번호로 검색합니다. ⌘/Ctrl + K로 검색창을 선택할 수 있습니다.',
                  )}
                </span>
              </p>
              <p>
                <Building2 size={20} />
                <span>
                  <strong>{t('고객 상세 확인')}</strong>
                  {t('고객사 이름을 누르면 기본 정보, 계약, 상담 이력을 확인하고 수정할 수 있습니다.')}
                </span>
              </p>
              <p>
                <ListTodo size={20} />
                <span>
                  <strong>{t('다음 업무 관리')}</strong>
                  {t('할 일에 고객사와 마감일을 연결하고, 처리한 업무는 완료로 표시합니다.')}
                </span>
              </p>
              <p>
                <Download size={20} />
                <span>
                  <strong>{t('목록 내보내기')}</strong>
                  {t('현재 페이지 또는 선택한 고객사를 CSV 파일로 내려받습니다.')}
                </span>
              </p>
            </div>
            <Dialog.Close className="button primary">{t('확인')}</Dialog.Close>
            <Dialog.Close className="icon-button dialog-close" aria-label={t('사용 안내 닫기')}>
              <X size={20} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>
          {toast.error ? <CircleHelp size={18} /> : <Check size={18} />}
          <span>{t(toast.text)}</span>
          <button className="icon-button" aria-label={t('알림 닫기')} onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function Summary({
  label,
  value,
  icon: Icon,
  selected,
  onClick,
  helper,
  tone = 'blue',
}: {
  label: string;
  value?: number;
  icon: LucideIcon;
  selected?: boolean;
  onClick: () => void;
  helper: string;
  tone?: string;
}) {
  useLocale();
  return (
    <button className={`summary-item ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="summary-top">
        <span>{t(label)}</span>
        <Icon size={18} className={tone} strokeWidth={1.6} />
      </div>
      <div className="summary-number">
        {value === undefined ? '—' : money(value)}
        <span>{t('개사')}</span>
      </div>
      <div className="summary-helper">
        {t(helper)}
        <ArrowUpRight size={14} />
      </div>
    </button>
  );
}
function SelectFilter({
  label,
  value,
  onChange,
  options,
  localizeOptions = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  localizeOptions?: boolean;
}) {
  useLocale();
  return (
    <label className={`select-filter ${value ? 'has-value' : ''}`}>
      <select aria-label={t(label)} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">
          {t(label)}
          {t(' 전체')}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {localizeOptions ? t(option.label) : option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} />
    </label>
  );
}
function daysUntil(value: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Math.round((end.getTime() - today.getTime()) / 86400000);
}
function pagination(current: number, total: number): (number | string)[] {
  if (total <= 7) return Array.from({ length: Math.max(1, total) }, (_, i) => i + 1);
  return [...new Set([1, current - 1, current, current + 1, total].filter((n) => n >= 1 && n <= total))]
    .sort((a, b) => a - b)
    .flatMap((n, i, a) => (i && n - a[i - 1] > 1 ? ['…', n] : [n]));
}

function CompanyDetail({
  id,
  onClose,
  onEdit,
  refresh,
  onRefresh,
  notify,
}: {
  id: string | null;
  onClose: () => void;
  onEdit: (company: Company) => void;
  refresh: number;
  onRefresh: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  useLocale();
  const { user, canWrite } = useAuth();
  const workspace = useWorkspaceSettings();
  const policyToken = businessFormPolicy(user, workspace.settings?.revision);
  const currentPolicy = useRef(policyToken);
  currentPolicy.current = policyToken;
  const [loadedPolicy, setLoadedPolicy] = useState('');
  const policyValid = Boolean(workspace.settings) && loadedPolicy === policyToken;
  const focus = useDialogReturnFocus();
  const activeCompanyId = useRef(id);
  activeCompanyId.current = id;
  const [company, setCompany] = useState<Company>();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('overview');
  const [activityType, setActivityType] = useState<Activity['type']>('call');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [activityError, setActivityError] = useState('');
  const [activityDate, setActivityDate] = useState(new Date().toLocaleDateString('en-CA'));
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
  useEffect(() => {
    setTab('overview');
    setTitle('');
    setBody('');
    setActivities([]);
    setActivityType('call');
    setSaving(false);
    setActivityError('');
    setEditingActivity(null);
    setActivityDate(new Date().toLocaleDateString('en-CA'));
  }, [id, policyToken]);
  useEffect(() => {
    if (!id || !workspace.settings) {
      setCompany(undefined);
      setActivities([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setCompany(undefined);
    Promise.all([
      api<Company>(`/companies/${id}`, { signal: controller.signal }),
      api<{ items: Activity[] }>(`/companies/${id}/activities`, { signal: controller.signal }),
    ])
      .then(([c, a]) => {
        if (controller.signal.aborted || currentPolicy.current !== policyToken) return;
        setLoadedPolicy(policyToken);
        setCompany(c);
        setActivities(a.items);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, refresh, policyToken]);
  const saveActivity = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || !policyValid || !businessFormPolicyMatches(policyToken, currentPolicy.current)) return;
    setSaving(true);
    setActivityError('');
    try {
      const targetCompany = id;
      const fields = { type: activityType, title, body, activityDate };
      const payload = businessFormPayload(
        fields,
        editingActivity
          ? {
              type: editingActivity.type,
              title: editingActivity.title,
              body: editingActivity.body,
              activityDate: editingActivity.activityDate || '',
            }
          : null,
        policyToken,
        currentPolicy.current,
      );
      if (!Object.keys(payload).length) {
        setEditingActivity(null);
        setTitle('');
        setBody('');
        return;
      }
      const activity = await api<Activity>(
        editingActivity ? `/activities/${editingActivity.id}` : `/companies/${id}/activities`,
        {
          method: editingActivity ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        },
      );
      if (activeCompanyId.current === targetCompany && currentPolicy.current === policyToken) {
        setTitle('');
        setBody('');
        setEditingActivity(null);
        setActivityDate(new Date().toLocaleDateString('en-CA'));
        setActivities((previous) => [activity, ...previous.filter((item) => item.id !== activity.id)]);
      }
      notify('상담 이력을 저장했습니다.');
    } catch (e) {
      if (activeCompanyId.current === id && businessFormPolicyMatches(policyToken, currentPolicy.current))
        setActivityError((e as Error).message);
    } finally {
      if (businessFormPolicyMatches(policyToken, currentPolicy.current)) setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open={Boolean(id)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content {...focus} className="detail-sheet" aria-describedby="detail-description">
          <div className="sheet-top">
            <span>
              <Building2 size={16} />
              {t('고객사 상세')}
            </span>
            <Dialog.Close className="icon-button" aria-label={t('상세 닫기')}>
              <X size={21} />
            </Dialog.Close>
          </div>
          <Dialog.Title className="sr-only">{t('고객사 상세 정보')}</Dialog.Title>
          <Dialog.Description id="detail-description" className="sr-only">
            {t('고객사 기본 정보, 계약, 상담 이력을 확인하고 관리합니다.')}
          </Dialog.Description>
          {error ? (
            <ErrorBox message={error} retry={onRefresh} />
          ) : loading || !company || !policyValid ? (
            <div className="sheet-loading" role="status">
              {t('고객사 정보를 불러오는 중입니다…')}
            </div>
          ) : (
            <>
              <div className="detail-heading">
                <div className="detail-company-avatar">{initials(company.name)}</div>
                <div>
                  <Status status={company.status} />
                  <h2>{company.name}</h2>
                  <p>
                    {company.companyCode || t('코드 미등록')}
                    <span>·</span>
                    {company.businessNumber || company.industry || t('사업자번호 미등록')}
                  </p>
                </div>
              </div>
              <div className="detail-actions">
                <ArchiveButton
                  area="companies"
                  id={company.id}
                  title={company.name}
                  notify={notify}
                  onArchived={() => {
                    onClose();
                    onRefresh();
                  }}
                />
                {canWrite && (
                  <button className="button" onClick={() => onEdit(company)}>
                    <Pencil size={15} />
                    {t('정보 수정')}
                  </button>
                )}
                {company.phone && (
                  <a className="button" href={phoneHref(company.phone)}>
                    <Phone size={15} />
                    {t('전화')}
                  </a>
                )}
                {company.email && (
                  <a className="button" href={emailHref(company.email)}>
                    <Mail size={15} />
                    {t('이메일')}
                  </a>
                )}
              </div>
              <Tabs.Root value={tab} onValueChange={setTab} className="detail-tabs">
                <Tabs.List className="tab-list" aria-label={t('고객사 상세 메뉴')}>
                  <Tabs.Trigger value="overview">{t('기본 정보')}</Tabs.Trigger>
                  <Tabs.Trigger value="contracts">{t('계약 정보')}</Tabs.Trigger>
                  <Tabs.Trigger value="activity">
                    {t('상담 이력 ')}
                    <span>{activities.length}</span>
                  </Tabs.Trigger>
                </Tabs.List>
                <div className="detail-scroll">
                  <Tabs.Content value="overview" className="tab-content">
                    <div className="detail-section">
                      <h3>{t('고객사 정보')}</h3>
                      <dl>
                        <Info label={t('고객사코드')} value={company.companyCode} />
                        <Info label={t('고객사명')} value={company.name} />
                        <Info label={t('사업자등록번호')} value={company.businessNumber} />
                        <Info label={t('법인등록번호')} value={company.corporationNumber} />
                        <Info label={t('대표자')} value={company.ceo} />
                        <Info label={t('기업유형')} value={t(company.companyType)} />
                        <Info label={t('그룹사')} value={company.groupName} />
                        <Info label={t('업종')} value={company.industry} />
                        <Info label={t('임직원 수')} value={t('{0}명', [money(company.employees)])} />
                        <Info label={t('우편번호')} value={company.zipcode} />
                        <Info label={t('주소')} value={company.address} />
                        <Info label={t('서비스 버전')} value={company.serviceVersion} />
                        <Info
                          label={t('최초 컨택일')}
                          value={company.firstContactDate ? dateLabel(company.firstContactDate) : undefined}
                        />
                        <Info label={t('컨택 구분')} value={t(company.contactSource)} />
                        <Info label={t('컨택 상세')} value={company.contactDetail} />
                        <Info
                          label={t('웹사이트')}
                          value={
                            company.website && safeWebsite(company.website) ? (
                              <a
                                href={safeWebsite(company.website)}
                                target="_blank"
                                rel="noopener noreferrer"
                                referrerPolicy="no-referrer"
                              >
                                {company.website}
                                <ExternalLink size={12} />
                              </a>
                            ) : (
                              company.website
                            )
                          }
                        />
                      </dl>
                    </div>
                    <div className="detail-section">
                      <h3>{t('담당자 정보')}</h3>
                      <div className="contact-card">
                        <span className="contact-avatar">
                          <Users size={21} />
                        </span>
                        <div>
                          <strong>{company.contactName || t('담당자 미등록')}</strong>
                          <span>{company.contactRole || t('직책 미등록')}</span>
                        </div>
                      </div>
                      <dl>
                        <Info
                          label={t('이메일')}
                          value={
                            company.email ? <a href={emailHref(company.email)}>{company.email}</a> : undefined
                          }
                        />
                        <Info
                          label={t('연락처')}
                          value={
                            company.phone ? <a href={phoneHref(company.phone)}>{company.phone}</a> : undefined
                          }
                        />
                        <Info label={t('내부 담당자')} value={company.owner} />
                      </dl>
                    </div>
                    <div className="detail-section">
                      <h3>{t('관리 메모')}</h3>
                      <p className="note-box">{company.note || t('등록된 메모가 없습니다.')}</p>
                    </div>
                    <p className="updated-note">
                      {t('최근 수정 · ')}
                      {dateLabel(company.updatedAt)}
                    </p>
                  </Tabs.Content>
                  <Tabs.Content value="contracts" className="tab-content">
                    <div className="detail-section">
                      <h3>{t('이용 서비스')}</h3>
                      <div className="contract-products">
                        {company.products.length ? (
                          company.products.map((product) => (
                            <div className="service-card" key={product}>
                              <BrandMark small />
                              <strong>{product}</strong>
                              <Status status={company.status} />
                            </div>
                          ))
                        ) : (
                          <p className="muted">{t('등록된 서비스가 없습니다.')}</p>
                        )}
                      </div>
                    </div>
                    <div className="detail-section">
                      <h3>{t('계약 현황')}</h3>
                      <dl>
                        <Info label={t('계약 시작일')} value={dateLabel(company.contractStart)} />
                        <Info label={t('계약 종료일')} value={dateLabel(company.contractEnd)} />
                        <Info
                          label={t('연간 계약 금액')}
                          value={t('{0}원', [money(company.contractAmount)])}
                        />
                        <Info label={t('내부 담당자')} value={company.owner} />
                      </dl>
                      {company.contractEnd &&
                        daysUntil(company.contractEnd) >= 0 &&
                        daysUntil(company.contractEnd) <= 30 && (
                          <div className="renewal-notice">
                            <CalendarDays size={18} />
                            <span>
                              {t('계약 만료까지 ')}
                              <strong>
                                {daysUntil(company.contractEnd)}
                                {t('일')}
                              </strong>
                              {t(' 남았습니다.')}
                              <br />
                              {t('고객사와 갱신 일정을 확인해 주세요.')}
                            </span>
                          </div>
                        )}
                    </div>
                  </Tabs.Content>
                  <Tabs.Content value="activity" className="tab-content">
                    {canWrite && (
                      <form
                        autoComplete="off"
                        spellCheck={false}
                        className="activity-form"
                        onSubmit={saveActivity}
                      >
                        <h3>{editingActivity ? t('상담 기록 수정') : t('새 상담 기록')}</h3>
                        <div
                          className="activity-type"
                          style={{ flexWrap: 'wrap' }}
                          role="group"
                          aria-label={t('상담 유형')}
                        >
                          {(
                            [
                              ['call', '전화', Phone],
                              ['email', '이메일', Mail],
                              ['meeting', '미팅', Users],
                              ['note', '메모', FileText],
                              ['invoice', '세금계산서', FileText],
                              ['quotation', '견적서', FileText],
                              ['contract', '계약서', FileText],
                            ] as [Activity['type'], string, LucideIcon][]
                          ).map(([value, label, Icon]) => (
                            <button
                              type="button"
                              key={value}
                              aria-pressed={activityType === value}
                              onClick={() => setActivityType(value)}
                            >
                              <Icon size={14} />
                              {t(label)}
                            </button>
                          ))}
                        </div>
                        <input
                          aria-label={t('상담 제목')}
                          placeholder={t('어떤 상담을 진행했나요?')}
                          required
                          maxLength={200}
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                        />
                        <Field label={t('활동일')}>
                          <input
                            type="date"
                            value={activityDate}
                            onInput={(event) => setActivityDate(event.currentTarget.value)}
                            onChange={(event) => setActivityDate(event.target.value)}
                          />
                        </Field>
                        <textarea
                          aria-label={t('상담 내용')}
                          placeholder={t('상담 내용과 다음 단계를 기록하세요.')}
                          required
                          maxLength={5000}
                          rows={3}
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                        />
                        {activityError && <ErrorBox message={activityError} />}
                        <button className="button primary" disabled={saving}>
                          <Plus size={15} />
                          {saving ? t('저장 중…') : editingActivity ? t('변경사항 저장') : t('기록 추가')}
                        </button>
                        {editingActivity && (
                          <button
                            type="button"
                            className="button"
                            disabled={saving}
                            onClick={() => {
                              setEditingActivity(null);
                              setTitle('');
                              setBody('');
                              setActivityDate(new Date().toLocaleDateString('en-CA'));
                            }}
                          >
                            {t('수정 취소')}
                          </button>
                        )}
                      </form>
                    )}
                    <div className="timeline">
                      <h3>
                        {t('상담 이력 ')}
                        <span>{activities.length}</span>
                      </h3>
                      {activities.length ? (
                        activities.map((a) => (
                          <article key={a.id} className="timeline-item">
                            <div className={`timeline-icon ${a.type}`}>
                              {a.type === 'call' ? (
                                <Phone size={15} />
                              ) : a.type === 'email' ? (
                                <Mail size={15} />
                              ) : a.type === 'meeting' ? (
                                <Users size={15} />
                              ) : (
                                <FileText size={15} />
                              )}
                            </div>
                            <div>
                              <div className="timeline-meta">
                                <span>{a.author}</span>
                                <time>{dateLabel(a.activityDate || a.createdAt)}</time>
                                {canWrite && (
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() => {
                                      setEditingActivity(a);
                                      setTitle(a.title);
                                      setBody(a.body);
                                      setActivityType(a.type);
                                      setActivityDate(a.activityDate || '');
                                      setActivityError('');
                                    }}
                                  >
                                    {t('수정')}
                                  </button>
                                )}
                              </div>
                              <h4>{a.title}</h4>
                              <p>{a.body}</p>
                            </div>
                          </article>
                        ))
                      ) : (
                        <p className="muted">{t('첫 상담 내용을 기록해 보세요.')}</p>
                      )}
                    </div>
                  </Tabs.Content>
                </div>
              </Tabs.Root>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CompanyForm({
  company,
  onClose,
  onSaved,
  products,
  owners,
}: {
  company: Company | 'new' | null;
  onClose: () => void;
  onSaved: (company: Company) => void;
  products: string[];
  owners: string[];
}) {
  useLocale();
  const { user } = useAuth();
  const workspace = useWorkspaceSettings();
  const policyToken = businessFormPolicy(user, workspace.settings?.revision);
  const currentPolicy = useRef(policyToken);
  currentPolicy.current = policyToken;
  const activeCompany = useRef(company);
  activeCompany.current = company;
  const [draftPolicy, setDraftPolicy] = useState('');
  const policyValid = businessFormPolicyMatches(draftPolicy, policyToken);
  const focus = useDialogReturnFocus();
  const original = useRef<Record<string, unknown>>({});
  const [form, setForm] = useState({ ...blankCompany });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (company) {
      setDraftPolicy(policyToken);
      original.current = company === 'new' ? {} : { ...company };
      setForm(
        company === 'new'
          ? { ...blankCompany, zipcode: '', products: [] }
          : {
              ...company,
              contractStart: company.contractStart?.slice(0, 10) ?? '',
              contractEnd: company.contractEnd?.slice(0, 10) ?? '',
            },
      );
      setError('');
    } else {
      original.current = {};
      setForm({ ...blankCompany, products: [] });
      setDraftPolicy('');
      setError('');
    }
  }, [company]);
  useEffect(() => {
    if (draftPolicy && !businessFormPolicyMatches(draftPolicy, policyToken)) {
      original.current = {};
      setForm({ ...blankCompany, products: [] });
      setDraftPolicy('');
      setError('');
      setSaving(false);
      onClose();
    }
  }, [policyToken]);
  const update = (key: keyof typeof blankCompany, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!company || !policyValid || !businessFormPolicyMatches(draftPolicy, currentPolicy.current)) return;
    const submitted = new FormData(event.currentTarget as HTMLFormElement);
    const dates = {
      firstContactDate: String(submitted.get('firstContactDate') ?? ''),
      contractStart: String(submitted.get('contractStart') ?? ''),
      contractEnd: String(submitted.get('contractEnd') ?? ''),
    };
    if (dates.contractStart && dates.contractEnd && dates.contractEnd < dates.contractStart) {
      setError('계약 종료일은 시작일보다 빠를 수 없습니다.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { id, updatedAt, ...fields } = { ...form, ...dates } as Company;
      const payload = businessFormPayload(
        fields,
        company === 'new' ? null : original.current,
        draftPolicy,
        currentPolicy.current,
      );
      if (!Object.keys(payload).length) {
        onClose();
        return;
      }
      const saved = await api<Company>(
        company === 'new' ? '/companies' : `/companies/${(company as Company).id}`,
        { method: company === 'new' ? 'POST' : 'PATCH', body: JSON.stringify(payload) },
      );
      if (activeCompany.current === company && businessFormPolicyMatches(draftPolicy, currentPolicy.current))
        onSaved(saved);
    } catch (e) {
      if (activeCompany.current === company && businessFormPolicyMatches(draftPolicy, currentPolicy.current))
        setError((e as Error).message);
    } finally {
      if (activeCompany.current === company && businessFormPolicyMatches(draftPolicy, currentPolicy.current))
        setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open={Boolean(company) && policyValid}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay form-overlay" />
        <Dialog.Content
          {...focus}
          className="dialog company-form-dialog"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="dialog-header">
            <div className="heading-icon">
              <Building2 size={21} />
            </div>
            <div>
              <Dialog.Title>{company === 'new' ? t('고객사 등록') : t('고객사 정보 수정')}</Dialog.Title>
              <Dialog.Description>
                {t('고객사 기본 정보와 담당자를 입력하세요. * 표시는 필수입니다.')}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label={t('등록·수정 닫기')} disabled={saving}>
              <X size={21} />
            </Dialog.Close>
          </div>
          <form autoComplete="off" spellCheck={false} onSubmit={save}>
            <div className="form-scroll">
              <h3>{t('기본 정보')}</h3>
              <div className="form-grid">
                <Field label={t('고객사코드')}>
                  <input
                    value={form.companyCode ?? ''}
                    onChange={(e) => update('companyCode', e.target.value)}
                    maxLength={50}
                    placeholder={t('기존 고객사코드')}
                  />
                </Field>
                <Field label={t('서비스 버전')}>
                  <select
                    value={form.serviceVersion ?? ''}
                    onChange={(e) => update('serviceVersion', e.target.value)}
                  >
                    <option value="">{t('선택')}</option>
                    {['SAP', 'On Premises', 'Cloud'].map((v) => (
                      <option key={v} value={v}>
                        {t(v)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('고객사명 *')}>
                  <input
                    required
                    maxLength={120}
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    placeholder={t('예: 새봄테크')}
                    autoFocus
                  />
                </Field>
                <Field label={t('사업자등록번호')}>
                  <input
                    value={form.businessNumber}
                    onChange={(e) => update('businessNumber', e.target.value)}
                    placeholder="000-00-00000"
                    maxLength={12}
                    pattern="[0-9]{3}-?[0-9]{2}-?[0-9]{5}"
                  />
                </Field>
                <Field label={t('법인등록번호')}>
                  <input
                    value={form.corporationNumber ?? ''}
                    onChange={(e) => update('corporationNumber', e.target.value)}
                    maxLength={30}
                  />
                </Field>
                <Field label={t('기업유형')}>
                  <select
                    value={form.companyType ?? ''}
                    onChange={(e) => update('companyType', e.target.value)}
                  >
                    <option value="">{t('선택')}</option>
                    {[
                      ...new Set(
                        ['기업', '연구원', '학교', '공공기관', '병원', '기타', form.companyType].filter(
                          Boolean,
                        ),
                      ),
                    ].map((v) => (
                      <option key={v} value={v}>
                        {t(v)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('업종')}>
                  <input
                    value={form.industry}
                    onChange={(e) => update('industry', e.target.value)}
                    placeholder={t('예: IT·소프트웨어')}
                    maxLength={100}
                  />
                </Field>
                <Field label={t('대표자')}>
                  <input value={form.ceo} onChange={(e) => update('ceo', e.target.value)} maxLength={100} />
                </Field>
                <Field label={t('이용 상태')}>
                  <select value={form.status} onChange={(e) => update('status', e.target.value)}>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {t(label)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('임직원 수')}>
                  <input
                    type="number"
                    min={0}
                    max={10000000}
                    value={form.employees}
                    onChange={(e) => update('employees', Number(e.target.value))}
                  />
                </Field>
                <Field label={t('그룹사')}>
                  <input
                    value={form.groupName ?? ''}
                    onChange={(e) => update('groupName', e.target.value)}
                    maxLength={100}
                  />
                </Field>
                <Field label={t('최초 컨택일')}>
                  <input
                    type="date"
                    name="firstContactDate"
                    onInput={(e) => update('firstContactDate', e.currentTarget.value)}
                    value={form.firstContactDate ?? ''}
                    onChange={(e) => update('firstContactDate', e.target.value)}
                  />
                </Field>
                <Field label={t('컨택 구분')}>
                  <select
                    value={form.contactSource ?? ''}
                    onChange={(e) => update('contactSource', e.target.value)}
                  >
                    <option value="">{t('선택')}</option>
                    {[...new Set(['인바운드', '아웃바운드', form.contactSource].filter(Boolean))].map((v) => (
                      <option key={v} value={v}>
                        {t(v)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('컨택 상세')}>
                  <select
                    value={form.contactDetail ?? ''}
                    onChange={(e) => update('contactDetail', e.target.value)}
                  >
                    <option value="">{t('선택')}</option>
                    {[
                      ...new Set(
                        ['홈페이지', '포털검색', '소개', '아카데미', '기타', form.contactDetail].filter(
                          Boolean,
                        ),
                      ),
                    ].map((v) => (
                      <option key={v} value={v}>
                        {t(v)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('우편번호')}>
                  <input
                    value={form.zipcode || ''}
                    onChange={(event) => update('zipcode', event.target.value)}
                    maxLength={20}
                    autoComplete="off"
                  />
                </Field>
                <Field label={t('주소')} wide>
                  <input
                    value={form.address}
                    onChange={(e) => update('address', e.target.value)}
                    maxLength={500}
                  />
                </Field>
                <Field label={t('웹사이트')} wide>
                  <input
                    value={form.website}
                    onChange={(e) => update('website', e.target.value)}
                    placeholder="https://example.com"
                    maxLength={500}
                  />
                </Field>
              </div>
              <h3>{t('담당자 정보')}</h3>
              <div className="form-grid">
                <Field label={t('고객 담당자')}>
                  <input
                    value={form.contactName}
                    onChange={(e) => update('contactName', e.target.value)}
                    maxLength={100}
                  />
                </Field>
                <Field label={t('부서 / 직책')}>
                  <input
                    value={form.contactRole}
                    onChange={(e) => update('contactRole', e.target.value)}
                    placeholder={t('예: 인사팀 / 과장')}
                    maxLength={100}
                  />
                </Field>
                <Field label={t('이메일')}>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => update('email', e.target.value)}
                    placeholder="name@example.com"
                    maxLength={254}
                  />
                </Field>
                <Field label={t('연락처')}>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => update('phone', e.target.value)}
                    placeholder="02-0000-0000"
                    maxLength={30}
                  />
                </Field>
                <Field label={t('내부 담당자')} wide>
                  <input
                    value={form.owner}
                    onChange={(e) => update('owner', e.target.value)}
                    list="owner-options"
                    placeholder={t('담당자 이름')}
                    maxLength={100}
                  />
                  <datalist id="owner-options">
                    {owners.map((o) => (
                      <option key={o} value={o} />
                    ))}
                  </datalist>
                </Field>
              </div>
              <h3>{t('서비스 및 계약')}</h3>
              <fieldset className="product-checkboxes">
                <legend>{t('이용 서비스')}</legend>
                {products.map((p) => (
                  <label key={p}>
                    <input
                      type="checkbox"
                      checked={form.products.includes(p)}
                      onChange={(e) =>
                        update(
                          'products',
                          e.target.checked ? [...form.products, p] : form.products.filter((v) => v !== p),
                        )
                      }
                    />
                    {p}
                  </label>
                ))}
              </fieldset>
              <div className="form-grid">
                <Field label={t('계약 시작일')}>
                  <input
                    type="date"
                    name="contractStart"
                    onInput={(e) => update('contractStart', e.currentTarget.value)}
                    value={form.contractStart}
                    onChange={(e) => update('contractStart', e.target.value)}
                  />
                </Field>
                <Field label={t('계약 종료일')}>
                  <input
                    type="date"
                    name="contractEnd"
                    onInput={(e) => update('contractEnd', e.currentTarget.value)}
                    min={form.contractStart || undefined}
                    value={form.contractEnd}
                    onChange={(e) => update('contractEnd', e.target.value)}
                  />
                </Field>
                <Field label={t('연간 계약 금액 (원)')} wide>
                  <input
                    type="number"
                    min={0}
                    max={1000000000000}
                    value={form.contractAmount}
                    onChange={(e) => update('contractAmount', Number(e.target.value))}
                  />
                </Field>
                <Field label={t('관리 메모')} wide>
                  <textarea
                    rows={3}
                    value={form.note}
                    onChange={(e) => update('note', e.target.value)}
                    maxLength={5000}
                    placeholder={t('고객사 관리에 필요한 내용을 입력하세요.')}
                  />
                </Field>
              </div>
              {error && <ErrorBox message={error} />}
            </div>
            <div className="dialog-footer">
              <button type="button" className="button" onClick={onClose} disabled={saving}>
                {t('취소')}
              </button>
              <button className="button primary" disabled={saving}>
                {saving ? t('저장 중…') : company === 'new' ? t('고객사 등록') : t('변경사항 저장')}
                {!saving && <ArrowRight size={16} />}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TaskRow({
  task,
  company,
  busy,
  toggle,
  openCompany,
  onEdit,
  onStatus,
}: {
  task: Task;
  company?: Company;
  busy: boolean;
  toggle: () => void;
  openCompany: (id: string) => void;
  onEdit: () => void;
  onStatus: (status: string) => void;
}) {
  useLocale();
  const { canWrite } = useAuth();
  const overdue = !task.completed && daysUntil(task.dueDate) < 0;
  return (
    <div className={`task-row ${task.completed ? 'completed' : ''}`}>
      <input
        type="checkbox"
        checked={task.completed}
        onChange={toggle}
        disabled={busy || !canWrite}
        aria-label={t('{0} 완료', [task.title])}
      />
      <div className="task-content">
        <button className="task-title" onClick={onEdit}>
          {task.title}
        </button>
        <div className="task-meta">
          <span>{task.type || t('개발요청')}</span>
          {company && (
            <button className="text-button" onClick={() => openCompany(company.id)}>
              <Building2 size={13} />
              {company.name}
            </button>
          )}
          {task.owner && <span>{task.owner}</span>}
        </div>
      </div>
      <select
        className="task-status-select"
        aria-label={t('{0} 진행상태', [task.title])}
        value={task.status || (task.completed ? 'done' : 'received')}
        onChange={(e) => onStatus(e.target.value)}
        disabled={busy || !canWrite}
      >
        <option value="received">{t('접수')}</option>
        <option value="in_progress">{t('진행중')}</option>
        <option value="done">{t('완료')}</option>
        <option value="unclassified">{t('미분류')}</option>
      </select>
      {task.priority === 'high' && !task.completed && <span className="priority-label">{t('중요')}</span>}
      <span className={`task-date ${overdue ? 'overdue' : ''}`}>
        {overdue && t('기한 지남 · ')}
        {dateLabel(task.dueDate)}
      </span>
    </div>
  );
}
function TaskForm({
  blocked,
  open,
  task,
  onClose,
  companies,
  onSaved,
  notify,
  onArchived,
}: {
  blocked: boolean;
  open: boolean;
  task?: Task;
  onClose: () => void;
  companies: Company[];
  onSaved: () => void;
  notify: (text: string, error?: boolean) => void;
  onArchived: () => void;
}) {
  useLocale();
  const { user, canWrite } = useAuth();
  const workspace = useWorkspaceSettings();
  const policyToken = businessFormPolicy(user, workspace.settings?.revision);
  const currentPolicy = useRef(policyToken);
  currentPolicy.current = policyToken;
  const activeTask = useRef({ open, task });
  activeTask.current = { open, task };
  const [draftPolicy, setDraftPolicy] = useState('');
  const policyValid = businessFormPolicyMatches(draftPolicy, policyToken);
  const focus = useDialogReturnFocus();
  const original = useRef<Record<string, unknown>>({});
  const [title, setTitle] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [contactId, setContactId] = useState('');
  const [contactName, setContactName] = useState('');
  const [contacts, setContacts] = useState<
    { id: string; companyId: string | null; name: string; department: string; role: string }[]
  >([]);
  const [contactsError, setContactsError] = useState('');
  useEffect(() => {
    setContacts([]);
    setContactsError('');
    if (!open || !policyToken) return;
    const controller = new AbortController();
    setContactsError('');
    api<{ items: typeof contacts }>('/records/contacts', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && businessFormPolicyMatches(policyToken, currentPolicy.current))
          setContacts(result.items);
      })
      .catch((error) => {
        if (error.name !== 'AbortError' && businessFormPolicyMatches(policyToken, currentPolicy.current))
          setContactsError(error.message);
      });
    return () => controller.abort();
  }, [open, policyToken]);
  const [priority, setPriority] = useState('normal');
  const [status, setStatus] = useState('received');
  const [type, setType] = useState('개발요청');
  const [owner, setOwner] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setDraftPolicy(policyToken);
      original.current = {
        ...(task || {}),
        status: task?.status || (task?.completed ? 'done' : 'received'),
        type: task?.type || '개발요청',
        owner: task?.owner || '',
        body: task?.body || '',
        startDate: task?.startDate || '',
        contactId: task?.contactId || '',
        contactName: task?.contactName || '',
      };
      setTitle(task?.title || '');
      setCompanyId(task?.companyId || '');
      setDueDate(task?.dueDate || '');
      setStartDate(task?.startDate || '');
      setContactId(task?.contactId || '');
      setContactName(task?.contactName || '');
      setPriority(task?.priority || 'normal');
      setStatus(task?.status || (task?.completed ? 'done' : 'received'));
      setType(task?.type || '개발요청');
      setOwner(task?.owner || '');
      setBody(task?.body || '');
      setError('');
    } else {
      original.current = {};
      setDraftPolicy('');
      setTitle('');
      setCompanyId('');
      setDueDate('');
      setStartDate('');
      setContactId('');
      setContactName('');
      setOwner('');
      setBody('');
      setError('');
      setContacts([]);
      setContactsError('');
    }
  }, [open, task]);
  useEffect(() => {
    if (draftPolicy && !businessFormPolicyMatches(draftPolicy, policyToken)) {
      original.current = {};
      setDraftPolicy('');
      setTitle('');
      setCompanyId('');
      setDueDate('');
      setStartDate('');
      setContactId('');
      setContactName('');
      setOwner('');
      setBody('');
      setError('');
      setContacts([]);
      setContactsError('');
      setSaving(false);
      onClose();
    }
  }, [policyToken]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite || !policyValid || !businessFormPolicyMatches(draftPolicy, currentPolicy.current)) return;
    setSaving(true);
    setError('');
    try {
      const fields = {
        title,
        companyId,
        dueDate: String(new FormData(e.currentTarget as HTMLFormElement).get('dueDate') ?? dueDate),
        startDate: String(new FormData(e.currentTarget as HTMLFormElement).get('startDate') ?? startDate),
        contactId,
        contactName,
        priority,
        completed: status === 'done',
        status,
        type,
        owner,
        body,
      };
      const payload = businessFormPayload(
        fields,
        task ? original.current : null,
        draftPolicy,
        currentPolicy.current,
      );
      if (!Object.keys(payload).length) {
        onClose();
        return;
      }
      await api(task ? `/tasks/${task.id}` : '/tasks', {
        method: task ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      if (
        activeTask.current.open &&
        activeTask.current.task === task &&
        businessFormPolicyMatches(draftPolicy, currentPolicy.current)
      )
        onSaved();
    } catch (e) {
      if (
        activeTask.current.open &&
        activeTask.current.task === task &&
        businessFormPolicyMatches(draftPolicy, currentPolicy.current)
      )
        setError((e as Error).message);
    } finally {
      if (
        activeTask.current.open &&
        activeTask.current.task === task &&
        businessFormPolicyMatches(draftPolicy, currentPolicy.current)
      )
        setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open={open && policyValid}
      onOpenChange={(v) => {
        if (!v && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay form-overlay" />
        <Dialog.Content
          {...focus}
          className="dialog task-form-dialog"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title>{!canWrite ? t('업무 상세') : task ? t('업무 수정') : t('할 일 추가')}</Dialog.Title>
          <Dialog.Description>
            {canWrite
              ? t('고객사와 다음 업무 일정을 연결하세요.')
              : t('등록된 업무의 내용과 일정을 확인하세요.')}
          </Dialog.Description>
          <form autoComplete="off" spellCheck={false} onSubmit={save}>
            {blocked && (
              <ErrorBox message="고객사 정보를 확인하지 못해 저장할 수 없습니다. 화면을 닫고 다시 시도해 주세요." />
            )}
            <fieldset className="form-grid task-fields" data-readonly={!canWrite}>
              <Field label={t('업무 제목 *')} wide>
                <input
                  readOnly={!canWrite}
                  required
                  autoFocus
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('예: 연말정산 도입 상담 일정 확인')}
                />
              </Field>
              <Field label={!task || task.companyId ? t('고객사 *') : t('고객사')} wide>
                <select
                  disabled={!canWrite}
                  required={!task || Boolean(task.companyId)}
                  value={companyId}
                  onChange={(e) => {
                    setCompanyId(e.target.value);
                    setContactId('');
                    setContactName('');
                  }}
                >
                  <option value="">{t('고객사 선택')}</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('고객 담당자')} wide>
                <select
                  disabled={!canWrite || !companyId || Boolean(contactsError)}
                  value={contactId}
                  onChange={(event) => {
                    const selected = contacts.find((contact) => contact.id === event.target.value);
                    setContactId(selected?.id || '');
                    setContactName(selected?.name || '');
                  }}
                >
                  <option value="">{t('담당자 선택')}</option>
                  {contactId &&
                    !contacts.some(
                      (contact) => contact.id === contactId && contact.companyId === companyId,
                    ) && <option value={contactId}>{contactName || t('기존 담당자')}</option>}
                  {contacts
                    .filter((contact) => contact.companyId === companyId)
                    .map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                        {contact.department ? ` · ${contact.department}` : ''}
                      </option>
                    ))}
                </select>
                {contactsError && (
                  <small>{t('담당자 목록을 불러오지 못했습니다. 기존 담당자 정보는 유지됩니다.')}</small>
                )}
              </Field>
              <Field label={t('고객 담당자 이름')}>
                <input
                  readOnly={!canWrite || Boolean(contactId)}
                  value={contactName}
                  onChange={(event) => setContactName(event.target.value)}
                  maxLength={150}
                  placeholder={t('연결 담당자가 없으면 이름을 기록하세요.')}
                />
              </Field>
              <Field label={t('시작일')}>
                <input
                  readOnly={!canWrite}
                  type="date"
                  name="startDate"
                  value={startDate}
                  onInput={(event) => setStartDate(event.currentTarget.value)}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </Field>
              <Field label={t('TASK 구분')}>
                <select disabled={!canWrite} value={type} onChange={(e) => setType(e.target.value)}>
                  {['개발요청', '채권관리', '영업관리', '미분류'].map((v) => (
                    <option key={v} value={v}>
                      {t(v)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('진행 상태')}>
                <select disabled={!canWrite} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="received">{t('접수')}</option>
                  <option value="in_progress">{t('진행중')}</option>
                  <option value="done">{t('완료')}</option>
                  <option value="unclassified">{t('미분류')}</option>
                </select>
              </Field>
              <Field label={!task || task.dueDate ? t('마감일 *') : t('마감일')}>
                <input
                  readOnly={!canWrite}
                  type="date"
                  name="dueDate"
                  required={!task || Boolean(task.dueDate)}
                  onInput={(e) => setDueDate(e.currentTarget.value)}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </Field>
              <Field label={t('우선순위')}>
                <select disabled={!canWrite} value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="normal">{t('보통')}</option>
                  <option value="high">{t('중요')}</option>
                </select>
              </Field>
              <Field label={t('TASK 담당자')} wide>
                <input
                  readOnly={!canWrite}
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  maxLength={150}
                />
              </Field>
              <Field label={t('업무 내용')} wide>
                <textarea
                  readOnly={!canWrite}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={3}
                  maxLength={5000}
                />
              </Field>
            </fieldset>
            {error && <ErrorBox message={error} />}
            <div className="dialog-footer">
              {task && (
                <ArchiveButton
                  area="tasks"
                  id={task.id}
                  title={task.title}
                  notify={notify}
                  onArchived={onArchived}
                />
              )}
              <button type="button" className="button" onClick={onClose} disabled={saving}>
                {canWrite ? t('취소') : t('닫기')}
              </button>
              {canWrite && (
                <button className="button primary" disabled={saving || blocked}>
                  {saving ? t('저장 중…') : task ? t('변경사항 저장') : t('할 일 추가')}
                </button>
              )}
            </div>
          </form>
          <Dialog.Close
            className="icon-button dialog-close"
            aria-label={task ? t('업무 상세 닫기') : t('할 일 추가 닫기')}
            disabled={saving}
          >
            <X size={20} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
