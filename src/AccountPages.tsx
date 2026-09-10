import { t, getLocaleTag } from './i18n';
import { useLocale } from './use-locale';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Check,
  ChevronDown,
  Clock3,
  Eye,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  UserRoundCheck,
  UserRoundX,
  Users,
  X,
} from 'lucide-react';
import {
  AuthNotice,
  PasswordField,
  authRequest,
  roleDescriptions,
  roleLabels,
  userStatusLabels,
  useAuth,
  type User,
  type UserRole,
  type UserStatus,
} from './auth';
import './auth.css';

const dateText = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(getLocaleTag(), { year: 'numeric', month: '2-digit', day: '2-digit' });
};

function AccountAvatar({ user, large = false }: { user: User; large?: boolean }) {
  useLocale();
  return (
    <span className={`account-avatar ${large ? 'large' : ''}`}>{user.name.trim().slice(0, 1) || 'Y'}</span>
  );
}
function RoleBadge({ role }: { role: UserRole }) {
  useLocale();
  return (
    <span className={`account-role ${role}`}>
      {role === 'admin' ? (
        <ShieldCheck size={13} />
      ) : role === 'editor' ? (
        <Pencil size={12} />
      ) : (
        <Eye size={13} />
      )}
      {t(roleLabels[role], undefined, 'role')}
    </span>
  );
}
function StatusBadge({ status }: { status: UserStatus }) {
  useLocale();
  return (
    <span className={`account-status ${status}`}>
      <span />
      {t(userStatusLabels[status])}
    </span>
  );
}

export function AccountPage() {
  useLocale();
  const { user, updateProfile, changePassword } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [emailPassword, setEmailPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');

  useEffect(() => {
    setName(user?.name || '');
    setEmail(user?.email || '');
    setEmailPassword('');
  }, [user?.id, user?.name, user?.email]);
  if (!user) return null;
  const emailChanged = email.trim().toLowerCase() !== user.email;
  const profileChanged = name.trim() !== user.name || emailChanged;

  const saveProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProfileError('');
    setProfileSuccess('');
    if (!name.trim()) return setProfileError('이름을 입력해 주세요.');
    if (emailChanged && !emailPassword)
      return setProfileError('이메일을 변경하려면 현재 비밀번호를 입력해 주세요.');
    setProfileBusy(true);
    try {
      await updateProfile({
        name: name.trim(),
        email: email.trim(),
        ...(emailChanged ? { currentPassword: emailPassword } : {}),
      });
      setEmailPassword('');
      setProfileSuccess(
        emailChanged
          ? '이메일을 변경했습니다. 다음 로그인부터 새 이메일을 사용해 주세요.'
          : '내 정보를 저장했습니다.',
      );
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason.message : '내 정보를 저장하지 못했습니다.');
    } finally {
      setProfileBusy(false);
    }
  };
  const savePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordError('');
    if (newPassword.length < 12 || newPassword.length > 128)
      return setPasswordError('새 비밀번호는 12~128자로 입력해 주세요.');
    if (newPassword !== confirmPassword) return setPasswordError('새 비밀번호 확인이 일치하지 않습니다.');
    if (newPassword === currentPassword)
      return setPasswordError('현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.');
    setPasswordBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
    } catch (reason) {
      setPasswordError(reason instanceof Error ? reason.message : '비밀번호를 변경하지 못했습니다.');
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div className="account-page">
      <header className="account-page-header">
        <span className="eyebrow">MY ACCOUNT</span>
        <h1>{t('내 계정')}</h1>
        <p>{t('프로필을 최신 상태로 유지하고, 로그인 정보를 관리하세요.')}</p>
      </header>
      <section className="account-summary" aria-label={t('내 계정 요약')}>
        <AccountAvatar user={user} large />
        <div className="account-summary-identity">
          <h2>{user.name}</h2>
          <p>{user.email}</p>
        </div>
        <div className="account-summary-access">
          <RoleBadge role={user.role} />
          <StatusBadge status={user.status} />
        </div>
        <div className="account-summary-date">
          <span>{t('가입일')}</span>
          <strong>{dateText(user.createdAt)}</strong>
        </div>
      </section>
      <div className="account-settings-grid">
        <section className="account-card">
          <header className="account-card-header">
            <span className="heading-icon">
              <UserRound size={19} />
            </span>
            <div>
              <h2>{t('기본 정보')}</h2>
              <p>{t('팀에 표시되는 이름과 로그인 이메일입니다.')}</p>
            </div>
          </header>
          <form className="account-card-body" onSubmit={saveProfile}>
            <AuthNotice>{t(profileError)}</AuthNotice>
            <AuthNotice success>{t(profileSuccess)}</AuthNotice>
            <div className="auth-field">
              <label htmlFor="account-name">{t('이름')}</label>
              <input
                id="account-name"
                name="name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setProfileSuccess('');
                }}
                autoComplete="name"
                maxLength={100}
                required
                disabled={profileBusy || passwordBusy}
              />
            </div>
            <div className="auth-field">
              <label htmlFor="account-email">{t('이메일')}</label>
              <input
                id="account-email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setProfileSuccess('');
                }}
                autoComplete="username"
                maxLength={254}
                required
                disabled={profileBusy || passwordBusy}
              />
            </div>
            {emailChanged && (
              <PasswordField
                id="account-email-password"
                name="emailPassword"
                label={t('현재 비밀번호')}
                value={emailPassword}
                onChange={(event) => setEmailPassword(event.target.value)}
                autoComplete="current-password"
                required
                maxLength={128}
                disabled={profileBusy || passwordBusy}
                hint={t('이메일 변경 시 본인 확인이 필요합니다. 다른 기기에서는 다시 로그인하게 됩니다.')}
              />
            )}
            <div className="account-readonly-role">
              <span>{t('내 권한')}</span>
              <div>
                <RoleBadge role={user.role} />
                <p>{t(roleDescriptions[user.role])}</p>
              </div>
              <small>{t('권한 변경은 관리자에게 요청해 주세요.')}</small>
            </div>
            <div className="account-form-actions">
              <span>
                {profileChanged ? t('저장하지 않은 변경사항이 있습니다.') : t('변경한 내용을 저장해 주세요.')}
              </span>
              <button
                type="submit"
                className="button primary"
                disabled={!profileChanged || profileBusy || passwordBusy}
              >
                {profileBusy ? <RefreshCw size={16} className="auth-spin" /> : <Check size={16} />}
                {profileBusy ? t('저장 중') : t('변경사항 저장')}
              </button>
            </div>
          </form>
        </section>
        <section className="account-card">
          <header className="account-card-header">
            <span className="heading-icon">
              <LockKeyhole size={19} />
            </span>
            <div>
              <h2>{t('비밀번호 변경')}</h2>
              <p>{t('새 비밀번호로 계정을 안전하게 관리하세요.')}</p>
            </div>
          </header>
          <form className="account-card-body" onSubmit={savePassword}>
            <input
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              name="username"
              autoComplete="username"
              value={user.email}
              readOnly
            />
            <AuthNotice>{t(passwordError)}</AuthNotice>
            <PasswordField
              id="account-current-password"
              name="currentPassword"
              label={t('현재 비밀번호')}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              placeholder={t('현재 비밀번호를 입력하세요')}
              maxLength={128}
              required
              disabled={passwordBusy || profileBusy}
            />
            <PasswordField
              id="account-new-password"
              name="newPassword"
              label={t('새 비밀번호')}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              placeholder={t('새 비밀번호를 입력하세요')}
              minLength={12}
              maxLength={128}
              required
              disabled={passwordBusy || profileBusy}
              hint={t('12~128자로 입력해 주세요. 공백도 비밀번호에 포함됩니다.')}
            />
            <PasswordField
              id="account-confirm-password"
              name="confirmPassword"
              label={t('새 비밀번호 확인')}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              placeholder={t('새 비밀번호를 다시 입력하세요')}
              maxLength={128}
              required
              disabled={passwordBusy || profileBusy}
            />
            <div className="account-password-note">
              <LockKeyhole size={15} />
              <span>
                {t('변경하면 모든 기기에서 로그아웃됩니다.')}
                <br />
                {t('새 비밀번호로 다시 로그인해 주세요.')}
              </span>
            </div>
            <div className="account-form-actions">
              <button
                type="submit"
                className="button"
                disabled={!currentPassword || !newPassword || !confirmPassword || passwordBusy || profileBusy}
              >
                {passwordBusy ? <RefreshCw size={16} className="auth-spin" /> : <LockKeyhole size={16} />}
                {passwordBusy ? t('변경 중') : t('비밀번호 변경')}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

export function UsersPage() {
  useLocale();
  const { user: currentUser, refresh } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<UserStatus | 'all'>('all');
  const [role, setRole] = useState<UserRole | 'all'>('all');
  const [editing, setEditing] = useState<User | null>(null);
  const [editRole, setEditRole] = useState<UserRole>('viewer');
  const [editStatus, setEditStatus] = useState<UserStatus>('pending');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const request = ++loadGeneration.current;
    setLoading(true);
    setError('');
    try {
      const result = await authRequest<{ items: User[] }>('/admin/users');
      if (request === loadGeneration.current) setUsers(result.items);
    } catch (reason) {
      if (request === loadGeneration.current)
        setError(reason instanceof Error ? reason.message : '사용자 목록을 불러오지 못했습니다.');
    } finally {
      if (request === loadGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (currentUser?.role === 'admin') void load();
    return () => {
      ++loadGeneration.current;
    };
  }, [currentUser?.role, load]);

  const counts = useMemo(
    () => ({
      all: users.length,
      active: users.filter((user) => user.status === 'active').length,
      pending: users.filter((user) => user.status === 'pending').length,
      disabled: users.filter((user) => user.status === 'disabled').length,
    }),
    [users],
  );
  const filtered = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return users
      .filter(
        (user) =>
          (status === 'all' || user.status === status) &&
          (role === 'all' || user.role === role) &&
          (!text || `${user.name} ${user.email}`.toLocaleLowerCase().includes(text)),
      )
      .sort((a, b) => {
        const priority: Record<UserStatus, number> = { pending: 0, active: 1, disabled: 2 };
        return priority[a.status] - priority[b.status] || b.createdAt.localeCompare(a.createdAt);
      });
  }, [users, query, role, status]);
  const activeAdminCount = users.filter((user) => user.role === 'admin' && user.status === 'active').length;
  const isLastAdmin = editing?.role === 'admin' && editing.status === 'active' && activeAdminCount <= 1;
  const changed = editing && (editing.role !== editRole || editing.status !== editStatus);

  if (currentUser?.role !== 'admin')
    return (
      <div className="account-access-denied">
        <ShieldCheck size={30} />
        <h1>{t('관리자만 접근할 수 있습니다.')}</h1>
        <p>{t('사용자와 권한 관리는 관리자 계정으로 이용해 주세요.')}</p>
      </div>
    );

  const openEditor = (user: User, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setEditing(user);
    setEditRole(user.role);
    setEditStatus(user.status);
    setEditError('');
    setSuccess('');
  };
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !changed) return;
    setEditError('');
    if (isLastAdmin && (editRole !== 'admin' || editStatus !== 'active'))
      return setEditError(
        '활성 관리자는 최소 1명 필요합니다. 다른 사용자를 먼저 활성 관리자로 지정해 주세요.',
      );
    setSaving(true);
    try {
      const result = await authRequest<{ user: User }>(`/admin/users/${encodeURIComponent(editing.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: editRole, status: editStatus }),
      });
      setUsers((items) => items.map((user) => (user.id === result.user.id ? result.user : user)));
      setSuccess(`${result.user.name} 님의 권한과 상태를 저장했습니다.`);
      setEditing(null);
      if (result.user.id === currentUser.id) await refresh();
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : '사용자 정보를 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };
  const filterCards = [
    { value: 'all' as const, label: '전체 사용자', icon: Users, text: '워크스페이스에 가입한 계정' },
    {
      value: 'active' as const,
      label: '활성 사용자',
      icon: UserRoundCheck,
      text: 'CRM을 이용할 수 있는 계정',
    },
    { value: 'pending' as const, label: '승인 대기', icon: Clock3, text: '관리자 승인이 필요한 계정' },
    { value: 'disabled' as const, label: '이용 중지', icon: UserRoundX, text: '이용이 중지된 계정' },
  ];

  return (
    <div className="account-page">
      <header className="account-page-header users-page-header">
        <div>
          <span className="eyebrow">WORKSPACE MEMBERS</span>
          <h1>{t('사용자 관리')}</h1>
          <p>{t('가입을 승인하고, 팀원에게 알맞은 권한을 설정하세요.')}</p>
        </div>
        <button className="button" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'auth-spin' : ''} />
          {t('새로고침')}
        </button>
      </header>
      <div className="users-stats" aria-label={t('사용자 상태별 보기')}>
        {filterCards.map(({ value, label, icon: Icon, text }) => (
          <button
            key={value}
            className={`users-stat ${value} ${status === value ? 'selected' : ''}`}
            aria-pressed={status === value}
            onClick={() => setStatus(value)}
          >
            <div>
              <span>{t(label)}</span>
              <Icon size={18} />
            </div>
            <strong>
              {loading ? <span className="users-count-loading">—</span> : counts[value]}
              <small>{t('명')}</small>
            </strong>
            <p>{t(text)}</p>
          </button>
        ))}
      </div>
      <AuthNotice success>{t(success)}</AuthNotice>
      {error && (
        <div className="users-load-error">
          <AuthNotice>{t(error)}</AuthNotice>
          <button className="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} />
            {t('다시 시도')}
          </button>
        </div>
      )}
      <section className="account-card users-panel" aria-label={t('사용자 목록')}>
        <div className="users-panel-heading">
          <div>
            <h2>{t('워크스페이스 사용자')}</h2>
            <span className="count-chip">{users.length}</span>
          </div>
          <span>{t('가입 신청을 확인하고 이용 권한을 관리하세요.')}</span>
        </div>
        <div className="users-toolbar">
          <label className="users-search">
            <Search size={17} />
            <span className="sr-only">{t('이름 또는 이메일 검색')}</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('이름 또는 이메일 검색')}
              type="search"
            />
          </label>
          <div className="users-select-filters">
            <label>
              <span className="sr-only">{t('상태 필터')}</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as UserStatus | 'all')}
              >
                <option value="all">{t('모든 상태')}</option>
                {Object.entries(userStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <label>
              <span className="sr-only">{t('권한 필터')}</span>
              <select value={role} onChange={(event) => setRole(event.target.value as UserRole | 'all')}>
                <option value="all">{t('모든 권한')}</option>
                {Object.entries(roleLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
          </div>
        </div>
        <div className="users-list-context">
          <span>
            {t('총 ')}
            <strong>{filtered.length}</strong>
            {t('명')}
            {query.trim() ? t(' · “{0}” 검색 결과', [query.trim()]) : t(' · 승인 대기 계정부터 표시합니다.')}
          </span>
          {(query || status !== 'all' || role !== 'all') && (
            <button
              onClick={() => {
                setQuery('');
                setStatus('all');
                setRole('all');
              }}
            >
              {t('필터 초기화')}
              <X size={12} />
            </button>
          )}
        </div>
        <div className="users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th scope="col">{t('사용자')}</th>
                <th scope="col">{t('권한')}</th>
                <th scope="col">{t('상태')}</th>
                <th scope="col">{t('가입일')}</th>
                <th scope="col">
                  <span className="sr-only">{t('관리')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 4 }, (_, index) => (
                    <tr key={index} aria-hidden="true">
                      <td>
                        <div className="skeleton" />
                      </td>
                      <td>
                        <div className="skeleton" />
                      </td>
                      <td>
                        <div className="skeleton" />
                      </td>
                      <td>
                        <div className="skeleton" />
                      </td>
                      <td>
                        <div className="skeleton" />
                      </td>
                    </tr>
                  ))
                : filtered.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <div className="users-identity">
                          <AccountAvatar user={user} />
                          <div>
                            <strong>
                              {user.name}
                              {user.id === currentUser.id && <span className="users-self">{t('나')}</span>}
                            </strong>
                            <span>{user.email}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <RoleBadge role={user.role} />
                      </td>
                      <td>
                        <StatusBadge status={user.status} />
                      </td>
                      <td className="users-date">{dateText(user.createdAt)}</td>
                      <td>
                        <button
                          className={`button users-edit-button ${user.status === 'pending' ? 'pending' : ''}`}
                          onClick={(event) => openEditor(user, event.currentTarget)}
                          aria-label={t('{0} 권한 및 상태 관리', [user.name])}
                        >
                          <Pencil size={13} />
                          {user.status === 'pending' ? t('승인 · 관리') : t('관리')}
                        </button>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        {loading && (
          <span className="sr-only" role="status">
            {t('사용자 목록을 불러오는 중입니다.')}
          </span>
        )}
        {!loading && filtered.length === 0 && (
          <div className="users-empty">
            <Search size={29} strokeWidth={1.4} />
            <h3>{t('조건에 맞는 사용자가 없습니다.')}</h3>
            <p>{t('다른 이름이나 이메일로 검색하거나 필터를 변경해 주세요.')}</p>
          </div>
        )}
        <footer className="users-list-footer">
          <ShieldCheck size={14} />
          <span>{t('권한 또는 상태를 변경하면 해당 사용자는 다시 로그인해야 합니다.')}</span>
        </footer>
      </section>
      <Dialog.Root
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="account-user-dialog"
            onEscapeKeyDown={(event) => {
              if (saving) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (saving) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => {
                (triggerRef.current?.isConnected ? triggerRef.current : searchRef.current)?.focus();
              });
            }}
          >
            <div className="account-user-dialog-header">
              <span className="heading-icon">
                <ShieldCheck size={20} />
              </span>
              <div>
                <Dialog.Title>{t('사용자 권한 및 상태')}</Dialog.Title>
                <Dialog.Description>{t('업무에 맞는 권한과 계정 상태를 설정하세요.')}</Dialog.Description>
              </div>
              <Dialog.Close className="icon-button" aria-label={t('닫기')} disabled={saving}>
                <X size={20} />
              </Dialog.Close>
            </div>
            {editing && (
              <form onSubmit={save}>
                <div className="account-user-dialog-body">
                  <div className="users-edit-identity">
                    <AccountAvatar user={editing} />
                    <div>
                      <strong>
                        {editing.name}
                        {editing.id === currentUser.id && <span className="users-self">{t('나')}</span>}
                      </strong>
                      <span>{editing.email}</span>
                    </div>
                    <StatusBadge status={editing.status} />
                  </div>
                  <AuthNotice>{t(editError)}</AuthNotice>
                  <fieldset className="users-role-fieldset">
                    <legend>{t('이용 권한')}</legend>
                    {(['admin', 'editor', 'viewer'] as const).map((value) => (
                      <label
                        key={value}
                        className={`users-role-option ${editRole === value ? 'selected' : ''} ${isLastAdmin && value !== 'admin' ? 'unavailable' : ''}`}
                      >
                        <input
                          type="radio"
                          name="userRole"
                          value={value}
                          checked={editRole === value}
                          onChange={() => setEditRole(value)}
                          disabled={saving || (isLastAdmin && value !== 'admin')}
                        />
                        <span>
                          <strong>{t(roleLabels[value], undefined, 'role')}</strong>
                          <small>{t(roleDescriptions[value])}</small>
                        </span>
                        {editRole === value && <Check size={17} />}
                      </label>
                    ))}
                  </fieldset>
                  <div className="auth-field">
                    <label htmlFor="user-edit-status">{t('계정 상태')}</label>
                    <select
                      id="user-edit-status"
                      value={editStatus}
                      onChange={(event) => setEditStatus(event.target.value as UserStatus)}
                      disabled={saving}
                    >
                      {(['active', 'pending', 'disabled'] as const).map((value) => (
                        <option key={value} value={value} disabled={isLastAdmin && value !== 'active'}>
                          {t(userStatusLabels[value])}
                        </option>
                      ))}
                    </select>
                    <small>
                      {editStatus === 'active'
                        ? t('로그인 후 선택한 권한으로 CRM을 이용할 수 있습니다.')
                        : editStatus === 'pending'
                          ? t('관리자의 승인을 받기 전까지 CRM을 이용할 수 없습니다.')
                          : t('로그인과 CRM 이용이 중지됩니다.')}
                    </small>
                  </div>
                  {isLastAdmin ? (
                    <div className="users-admin-note">
                      <ShieldCheck size={17} />
                      <p>
                        {t('현재 유일한 활성 관리자입니다.')}
                        <br />
                        {t('권한이나 상태를 바꾸려면 다른 사용자를 먼저 활성 관리자로 지정해 주세요.')}
                      </p>
                    </div>
                  ) : editing.id === currentUser.id && changed ? (
                    <div className="users-admin-note">
                      <LockKeyhole size={17} />
                      <p>
                        {t(
                          '내 계정을 변경하면 로그아웃됩니다. 변경한 권한과 상태는 다시 로그인한 뒤 적용됩니다.',
                        )}
                      </p>
                    </div>
                  ) : editing.status === 'pending' && editStatus === 'active' ? (
                    <div className="users-approval-note">
                      <UserRoundCheck size={17} />
                      <p>
                        {t('저장하면 가입이 승인됩니다. 선택한 ')}
                        <strong>{t(roleLabels[editRole], undefined, 'role')}</strong>
                        {t(' 권한으로 CRM을 이용할 수 있습니다.')}
                      </p>
                    </div>
                  ) : null}
                </div>
                <div className="account-user-dialog-footer">
                  <Dialog.Close className="button" disabled={saving}>
                    {t('취소')}
                  </Dialog.Close>
                  <button type="submit" className="button primary" disabled={saving || !changed}>
                    {saving ? <RefreshCw size={16} className="auth-spin" /> : <Check size={16} />}
                    {saving
                      ? t('저장 중')
                      : editing.status === 'pending' && editStatus === 'active'
                        ? t('승인하고 저장')
                        : t('변경사항 저장')}
                  </button>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
