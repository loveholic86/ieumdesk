import { t } from './i18n';
import { useLocale } from './use-locale';
import { canManageBusiness } from './permissions';
import { LanguageSelector } from './LanguageSelector';
import { ThemeToggle } from './ThemeSelector';
import { openProjectChannel, type ProjectChannel } from './project-channel';
import { usePublicBranding } from './use-public-branding';
import { readRememberedLoginId, saveRememberedLoginId } from './remembered-login';
import type { WorkspaceBranding } from './workspace-types';
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  ArrowRight,
  Building2,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Eye,
  EyeOff,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { privateFetch, publicErrorMessage } from './client-security';
import './auth.css';

export type UserRole = 'admin' | 'editor' | 'viewer';
export type UserStatus = 'active' | 'pending' | 'disabled';
export type User = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
};
export type AuthUser = User;
export const roleLabels: Record<UserRole, string> = {
  admin: '관리자',
  editor: '담당자',
  viewer: '조회 전용',
};
export const userStatusLabels: Record<UserStatus, string> = {
  active: '활성',
  pending: '승인 대기',
  disabled: '이용 중지',
};
export const statusLabels = userStatusLabels;
export const roleDescriptions: Record<UserRole, string> = {
  admin: 'CRM 업무, 사용자·권한 및 환경설정을 관리합니다.',
  editor: '사용자·권한 및 환경설정을 제외한 CRM 업무를 관리합니다.',
  viewer: 'CRM 데이터를 조회합니다.',
};

function validUser(value: unknown): value is User {
  if (!value || typeof value !== 'object') return false;
  const user = value as Partial<User>;
  return (
    typeof user.id === 'string' &&
    user.id.length > 0 &&
    typeof user.name === 'string' &&
    typeof user.email === 'string' &&
    ['admin', 'editor', 'viewer'].includes(user.role || '') &&
    ['active', 'pending', 'disabled'].includes(user.status || '') &&
    typeof user.createdAt === 'string' &&
    typeof user.updatedAt === 'string'
  );
}

export async function authRequest<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await privateFetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    });
  } catch {
    throw new Error('서버에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.');
  }
  if (response.status === 401 && !['/auth/session', '/auth/login', '/auth/register', '/auth/forgot-password', '/auth/reset-password'].includes(path))
    window.dispatchEvent(new Event('crm:unauthorized'));
  if (response.status === 403 && path.startsWith('/admin/'))
    window.dispatchEvent(new Event('crm:permissions-changed'));
  let body: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch {
    throw new Error('서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (!response.ok) {
    throw new Error(
      publicErrorMessage(body, response.status, '요청을 처리하지 못했습니다. 다시 시도해 주세요.'),
    );
  }
  const valid =
    path === '/auth/session'
      ? typeof body.setupRequired === 'boolean' && (body.user === null || validUser(body.user))
      : path === '/admin/users' && (!options?.method || options.method === 'GET')
        ? Array.isArray(body.items) && body.items.every(validUser)
        : path === '/admin/password-reset-requests'
          ? Array.isArray(body.items) && body.items.every(item => item && typeof item === 'object' && typeof item.userId === 'string' && Number.isFinite(Date.parse(item.requestedAt)))
        : /^\/admin\/users\/[^/]+\/password-reset$/.test(path)
          ? typeof body.resetPath === 'string' && /^\/#reset-password=[A-Za-z\d_-]{43}$/.test(body.resetPath) && typeof body.expiresAt === 'string' && Number.isFinite(Date.parse(body.expiresAt))
        : ['/auth/logout', '/auth/password', '/auth/forgot-password', '/auth/reset-password'].includes(path)
          ? body.ok === true
          : validUser(body.user);
  if (!valid) throw new Error('계정 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return body as T;
}

type ProfileUpdate = { name: string; email: string; currentPassword?: string };
type AuthContextValue = {
  branding: WorkspaceBranding;
  user: User | null;
  setupRequired: boolean;
  loading: boolean;
  error: string;
  notice: string;
  canWrite: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (profile: ProfileUpdate) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  resetPassword: (token: string, newPassword: string) => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  useLocale();
  const branding = usePublicBranding();
  const [user, setUser] = useState<User | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const sessionChannel = useRef<ProjectChannel | null>(null);

  const readSession = useCallback(async (background = false) => {
    const request = ++generation.current;
    if (!background) setLoading(true);
    try {
      const result = await authRequest<{ user: User | null; setupRequired: boolean }>('/auth/session');
      if (request !== generation.current) return;
      setUser(result.user);
      setSetupRequired(result.setupRequired);
      setError('');
    } catch (reason) {
      if (request !== generation.current) return;
      setUser(null);
      setError(reason instanceof Error ? reason.message : '로그인 상태를 확인하지 못했습니다.');
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);
  const refresh = useCallback(() => readSession(), [readSession]);

  useEffect(() => {
    void readSession();
    const invalidate = () => {
      setUser(null);
      setNotice('로그인 상태와 권한을 다시 확인합니다.');
      void readSession();
    };
    const onFocus = () => {
      if (document.visibilityState === 'visible') void readSession(true);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) invalidate();
    };
    // Other tabs share the cookie, but must never keep the previous account's in-memory workspace.
    sessionChannel.current = openProjectChannel('session', (event) => {
      if (event.data?.type === 'session-changed') invalidate();
    });
    const timer = window.setInterval(onFocus, 30_000);
    window.addEventListener('crm:unauthorized', invalidate);
    window.addEventListener('crm:permissions-changed', invalidate);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      ++generation.current;
      window.removeEventListener('crm:unauthorized', invalidate);
      window.removeEventListener('crm:permissions-changed', invalidate);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(timer);
      sessionChannel.current?.close();
      sessionChannel.current = null;
    };
  }, [readSession]);

  const establish = async (path: string, values: Record<string, string>) => {
    ++generation.current;
    const result = await authRequest<{ user: User }>(path, { method: 'POST', body: JSON.stringify(values) });
    ++generation.current;
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
    setUser(result.user);
    setSetupRequired(false);
    setLoading(false);
    setError('');
    setNotice('');
    sessionChannel.current?.postMessage({ type: 'session-changed' });
  };
  const logout = async () => {
    await authRequest('/auth/logout', { method: 'POST' });
    ++generation.current;
    setUser(null);
    setLoading(false);
    setError('');
    setNotice('로그아웃되었습니다.');
    sessionChannel.current?.postMessage({ type: 'session-changed' });
  };
  const updateProfile = async (profile: ProfileUpdate) => {
    const result = await authRequest<{ user: User }>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(profile),
    });
    ++generation.current;
    setUser(result.user);
    setError('');
  };
  const changePassword = async (currentPassword: string, newPassword: string) => {
    await authRequest('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    ++generation.current;
    setUser(null);
    setLoading(false);
    setError('');
    setNotice('비밀번호를 변경했습니다. 새 비밀번호로 다시 로그인해 주세요.');
    sessionChannel.current?.postMessage({ type: 'session-changed' });
  };
  const resetPassword = async (token: string, newPassword: string) => {
    await authRequest('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
    ++generation.current;
    setUser(null);
    setLoading(false);
    setError('');
    setNotice('비밀번호를 변경했습니다. 새 비밀번호로 다시 로그인해 주세요.');
    sessionChannel.current?.postMessage({ type: 'session-changed' });
  };

  return (
    <AuthContext.Provider
      value={{
        branding,
        user,
        setupRequired,
        loading,
        error,
        notice,
        canWrite: canManageBusiness(user),
        refresh,
        login: (email, password) => establish('/auth/login', { email, password }),
        register: (name, email, password) => establish('/auth/register', { name, email, password }),
        logout,
        updateProfile,
        changePassword,
        resetPassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider 안에서 계정 기능을 사용해 주세요.');
  return context;
}

export function AuthNotice({ children, success = false }: { children: ReactNode; success?: boolean }) {
  useLocale();
  if (!children) return null;
  return (
    <div
      className={`auth-notice ${success ? 'success' : ''}`}
      role={success ? 'status' : 'alert'}
      aria-live="polite"
    >
      {success ? <Check size={17} /> : <CircleAlert size={17} />}
      <span>{t(children)}</span>
    </div>
  );
}

export function PasswordField({
  label,
  hint,
  ...inputProps
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  useLocale();
  const generated = useId();
  const id = inputProps.id || generated;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const hide = () => setVisible(false);
    const timer = window.setTimeout(hide, 15_000);
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [visible]);
  useEffect(() => {
    if (inputProps.disabled) setVisible(false);
  }, [inputProps.disabled]);
  return (
    <div className="auth-field">
      <label htmlFor={id}>{t(label)}</label>
      <div
        className="auth-password"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setVisible(false);
        }}
      >
        <input
          {...inputProps}
          id={id}
          type={visible ? 'text' : 'password'}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          aria-label={t('{0} {1}', [t(label), visible ? t('숨기기') : t('보기')])}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
          disabled={inputProps.disabled}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {hint && <small id={`${id}-hint`}>{t(hint)}</small>}
    </div>
  );
}

function AuthBrand() {
  useLocale();
  const { branding: { brandName, workspaceName } } = useAuth();
  return (
    <div className="auth-brand" aria-label={brandName}>
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <div className="auth-brand-copy">
        <span title={brandName}>{brandName}</span>
        <small title={workspaceName}>{workspaceName}</small>
      </div>
    </div>
  );
}

export function AuthFrame({ children }: { children: ReactNode }) {
  useLocale();
  const { branding: { brandName } } = useAuth();
  return (
    <main className="auth-layout">
      <section className="auth-story" aria-label={t('{0} 소개', [brandName])}>
        <AuthBrand />
        <div className="auth-story-body">
          <span className="auth-story-kicker">YOUR CUSTOMER WORKSPACE</span>
          <h1>
            {t('고객을 이해하고,')}
            <br />
            {t('다음 기회를 연결하세요.')}
          </h1>
          <p>
            {t('고객사와 담당자, 영업과 서비스 이력까지.')}
            <br />
            {t('팀의 모든 고객 업무가 한곳에서 이어집니다.')}
          </p>
          <div className="auth-workflow" aria-label={t('고객 업무의 연결')}>
            <div>
              <span>
                <Building2 size={21} />
              </span>
              <strong>{t('고객 관계')}</strong>
              <small>{t('고객사 · 담당자')}</small>
            </div>
            <ChevronRight size={16} className="auth-flow-arrow" />
            <div>
              <span>
                <Users size={21} />
              </span>
              <strong>{t('영업 기회')}</strong>
              <small>{t('영업 · 견적')}</small>
            </div>
            <ChevronRight size={16} className="auth-flow-arrow" />
            <div>
              <span>
                <ShieldCheck size={21} />
              </span>
              <strong>{t('서비스 운영')}</strong>
              <small>{t('설치 · 활동 기록')}</small>
            </div>
          </div>
          <div className="auth-story-note">
            <span />
            {t('함께 쌓은 기록이, 더 나은 고객 경험으로.')}
          </div>
        </div>
        <div className="auth-story-footer">
          <span>{brandName} · CUSTOMER &amp; WORK MANAGEMENT</span>
          <span>WORK BETTER, TOGETHER</span>
        </div>
      </section>
      <section className="auth-main">
        <div className="auth-language">
          <ThemeToggle />
          <LanguageSelector />
        </div>
        <div className="auth-mobile-brand">
          <AuthBrand />
        </div>
        {children}
        <footer className="auth-main-footer">
          <LockKeyhole size={13} />
          {t('팀의 고객 정보를 안전하게 관리합니다.')}
        </footer>
      </section>
    </main>
  );
}

export function ForgotPasswordPage({ onBack }: { onBack: () => void }) {
  useLocale();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await authRequest('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      setSent(true);
      setEmail('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '초기화 요청을 처리하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame>
      <div className="auth-form-wrap">
        <div className="auth-form-heading">
          <span className="auth-eyebrow">ACCOUNT RECOVERY</span>
          <h2>{t('비밀번호 초기화 요청')}</h2>
          <p>
            {t(
              '가입 이메일을 입력하면 관리자에게 초기화 요청이 표시됩니다. 본인 확인 후 관리자가 전달하는 링크에서 새 비밀번호를 설정하세요.',
            )}
          </p>
        </div>
        <AuthNotice>{t(error)}</AuthNotice>
        {sent ? (
          <AuthNotice success>
            {t(
              '요청을 접수했습니다. 등록된 이용 가능 계정이면 관리자에게 요청이 표시됩니다. 관리자에게 연락해 본인 확인 후 재설정 링크를 받아 주세요.',
            )}
          </AuthNotice>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="auth-field">
              <label htmlFor="reset-request-email">{t('가입 이메일')}</label>
              <input
                id="reset-request-email"
                name="email"
                type="email"
                autoComplete="username"
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={busy}
                placeholder="name@company.com"
              />
            </div>
            <button className="button primary auth-submit" disabled={busy} type="submit">
              {busy && <RefreshCw size={16} className="auth-spin" />}
              {t(busy ? '요청 중' : '관리자에게 초기화 요청')}
            </button>
          </form>
        )}
        <button type="button" className="auth-reset-link" onClick={onBack} disabled={busy}>
          {t('로그인으로 돌아가기')}
        </button>
      </div>
    </AuthFrame>
  );
}

export function PasswordResetPage({ token, onBack }: { token: string; onBack: () => void }) {
  const locale = useLocale();
  const {
    resetPassword,
    branding: { brandName },
  } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const validToken = /^[A-Za-z\d_-]{43}$/.test(token);
  useEffect(() => {
    document.title = `${brandName} · ${t('새 비밀번호 설정')}`;
  }, [brandName, locale]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < 12 || password.length > 128)
      return setError('새 비밀번호는 12~128자로 입력해 주세요.');
    if (password !== confirmation) return setError('새 비밀번호 확인이 일치하지 않습니다.');
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
      setPassword('');
      setConfirmation('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '비밀번호를 변경하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame>
      <div className="auth-form-wrap">
        <div className="auth-form-heading">
          <span className="auth-eyebrow">RESET YOUR PASSWORD</span>
          <h2>{t(done ? '비밀번호를 재설정했습니다' : '새 비밀번호 설정')}</h2>
          <p>
            {t(
              done
                ? '새 비밀번호로 다시 로그인해 주세요.'
                : '새 비밀번호를 저장하면 모든 기기에서 로그아웃됩니다. 가입 승인과 이용 권한은 그대로 유지됩니다.',
            )}
          </p>
        </div>
        <AuthNotice>
          {t(validToken ? error : '재설정 링크가 유효하지 않습니다. 관리자에게 새 링크를 요청해 주세요.')}
        </AuthNotice>
        {!done && validToken && (
          <form className="auth-form" onSubmit={submit}>
            <PasswordField
              id="reset-new-password"
              name="newPassword"
              label="새 비밀번호"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint="12~128자로 입력해 주세요. 공백도 비밀번호에 포함됩니다."
              required
              disabled={busy}
            />
            <PasswordField
              id="reset-confirm-password"
              name="confirmPassword"
              label="새 비밀번호 확인"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              disabled={busy}
            />
            <button className="button primary auth-submit" type="submit" disabled={busy}>
              {busy && <RefreshCw size={16} className="auth-spin" />}
              {t(busy ? '변경 중' : '새 비밀번호 저장')}
            </button>
          </form>
        )}
        <button
          type="button"
          className={done ? 'button primary auth-submit' : 'auth-reset-link'}
          onClick={onBack}
          disabled={busy}
        >
          {t('로그인으로 돌아가기')}
        </button>
      </div>
    </AuthFrame>
  );
}

export function LoginPage() {
  const locale = useLocale();
  const { branding: { brandName }, setupRequired, login, register, notice, error: sessionError } = useAuth();
  const [signup, setSignup] = useState(setupRequired);
  const [forgotPassword, setForgotPassword] = useState(false);
  const [name, setName] = useState('');
  const [rememberedLoginId] = useState(readRememberedLoginId);
  const [rememberId, setRememberId] = useState(Boolean(rememberedLoginId));
  const [email, setEmail] = useState(setupRequired ? '' : rememberedLoginId);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const title = signup ? (setupRequired ? '최초 관리자 계정 만들기' : '회원가입') : '다시 만나 반갑습니다';

  useEffect(() => {
    document.title = `${brandName} · ${t(forgotPassword ? '비밀번호 초기화' : signup ? '회원가입' : '로그인')}`;
  }, [brandName, signup, forgotPassword, locale]);

  const toggleMode = () => {
    setSignup(!signup);
    setError('');
    setPassword('');
    setConfirmPassword('');
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    if (signup && !name.trim()) return setError('이름을 입력해 주세요.');
    if (signup && (password.length < 12 || password.length > 128))
      return setError('비밀번호는 12~128자로 입력해 주세요.');
    if (signup && password !== confirmPassword) return setError('비밀번호 확인이 일치하지 않습니다.');
    setBusy(true);
    try {
      if (signup) await register(name.trim(), email.trim(), password);
      else {
        await login(email.trim(), password);
        saveRememberedLoginId(email, rememberId);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '계정 요청을 처리하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  if (forgotPassword) return <ForgotPasswordPage onBack={() => setForgotPassword(false)} />;

  return (
    <AuthFrame>
      <div className="auth-form-wrap">
        <div className="auth-form-heading">
          <span className="auth-eyebrow">{signup ? 'JOIN YOUR WORKSPACE' : 'WELCOME BACK'}</span>
          <h2>{t(title)}</h2>
          <p>
            {signup
              ? setupRequired
                ? t('{0}에서 사용할 첫 번째 계정입니다.', [brandName])
                : t('팀과 함께 사용할 계정을 만들어 주세요.')
              : t('로그인하고 오늘의 고객 업무를 시작하세요.')}
          </p>
        </div>
        {signup && (
          <div className="auth-join-note">
            <ShieldCheck size={18} />
            <p>
              {setupRequired ? (
                <>
                  {t('첫 가입자는 ')}
                  <strong>{t('관리자')}</strong>
                  {t('로 등록되며, 바로 시작할 수 있습니다.')}
                </>
              ) : (
                <>
                  {t('가입 후 ')}
                  <strong>{t('관리자 승인')}</strong>
                  {t('을 받으면 CRM을 이용할 수 있습니다.')}
                </>
              )}
            </p>
          </div>
        )}
        {!signup && notice && <AuthNotice success>{t(notice)}</AuthNotice>}
        <AuthNotice>{t(error) || t(sessionError)}</AuthNotice>
        <form onSubmit={submit} className="auth-form">
          {signup && (
            <div className="auth-field">
              <label htmlFor="signup-name">{t('이름')}</label>
              <input
                id="signup-name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('이름을 입력하세요')}
                autoComplete="name"
                maxLength={100}
                required
                disabled={busy}
              />
            </div>
          )}
          <div className="auth-field">
            <label htmlFor="auth-email">{t('이메일')}</label>
            <input
              id="auth-email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              autoComplete="username"
              maxLength={254}
              required
              disabled={busy}
            />
          </div>
          <PasswordField
            id="auth-password"
            name="password"
            label={t('비밀번호')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={signup ? t('12자 이상 입력하세요') : t('비밀번호를 입력하세요')}
            autoComplete={signup ? 'new-password' : 'current-password'}
            minLength={signup ? 12 : undefined}
            maxLength={128}
            required
            disabled={busy}
            hint={signup ? t('12~128자로 입력해 주세요. 공백도 비밀번호에 포함됩니다.') : t(undefined)}
          />
          {signup && (
            <PasswordField
              id="auth-confirm-password"
              name="confirmPassword"
              label={t('비밀번호 확인')}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder={t('비밀번호를 다시 입력하세요')}
              autoComplete="new-password"
              maxLength={128}
              required
              disabled={busy}
            />
          )}
          {!signup && (
            <div className="auth-login-options">
              <label className="auth-remember-id">
                <input
                  type="checkbox"
                  checked={rememberId}
                  disabled={busy}
                  onChange={(event) => {
                    setRememberId(event.target.checked);
                    if (!event.target.checked) saveRememberedLoginId('', false);
                  }}
                />
                {t('ID 저장')}
              </label>
              <button type="button" className="auth-reset-link" disabled={busy} onClick={() => { setPassword(''); setError(''); setForgotPassword(true); }}>{t('비밀번호를 잊으셨나요?')}</button>
              <small>{t('이 브라우저에 이메일만 저장합니다.')}</small>
            </div>
          )}
          <button className="button primary auth-submit" type="submit" disabled={busy}>
            {busy ? (
              <>
                <RefreshCw size={17} className="auth-spin" />
                {signup ? t('계정 만드는 중') : t('로그인하는 중')}
              </>
            ) : (
              <>
                {signup
                  ? setupRequired
                    ? t('관리자 계정 만들고 시작하기')
                    : t('가입 신청하기')
                  : t('로그인')}
                <ArrowRight size={17} />
              </>
            )}
          </button>
        </form>
        <div className="auth-mode-switch">
          <span>{signup ? t('이미 계정이 있으신가요?') : t('아직 계정이 없으신가요?')}</span>
          <button onClick={toggleMode} disabled={busy}>
            {signup ? t('로그인') : t('회원가입')}
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </AuthFrame>
  );
}

export function PendingApprovalPage() {
  useLocale();
  const { user, refresh, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!user) return null;
  const pending = user.status === 'pending';
  const run = async (action: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame>
      <div className="auth-form-wrap auth-pending">
        <div className={`auth-state-icon ${pending ? '' : 'disabled'}`}>
          {pending ? <Clock3 size={29} strokeWidth={1.5} /> : <LockKeyhole size={29} strokeWidth={1.5} />}
        </div>
        <span className="auth-eyebrow">{pending ? 'ONE MORE STEP' : 'ACCOUNT STATUS'}</span>
        <h2>{pending ? t('관리자 승인을 기다리고 있어요') : t('계정 이용이 중지되었습니다')}</h2>
        <p>
          {pending
            ? t('가입 신청이 완료되었습니다. 관리자가 계정을 승인하면 고객 업무를 시작할 수 있습니다.')
            : t('CRM 이용 권한을 확인하려면 팀 관리자에게 문의해 주세요.')}
        </p>
        <div className="auth-pending-account">
          <div className="account-avatar">{user.name.trim().slice(0, 1) || 'Y'}</div>
          <div>
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
          <span className={`account-status ${user.status}`}>{t(userStatusLabels[user.status])}</span>
        </div>
        <AuthNotice>{t(error)}</AuthNotice>
        <button className="button primary auth-submit" disabled={busy} onClick={() => void run(refresh)}>
          <RefreshCw size={17} className={busy ? 'auth-spin' : ''} />
          {pending ? t('승인 상태 확인') : t('계정 상태 확인')}
        </button>
        <button className="auth-logout" disabled={busy} onClick={() => void run(logout)}>
          <LogOut size={16} />
          {t('로그아웃')}
        </button>
      </div>
    </AuthFrame>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  useLocale();
  const { user, loading, error, refresh } = useAuth();
  const readResetToken = (hash = window.location.hash) => {
    const params = new URLSearchParams(hash.slice(1));
    return params.has('reset-password') ? (params.getAll('reset-password').length === 1 ? params.get('reset-password')! : '') : null;
  };
  const [resetToken, setResetToken] = useState<string | null>(() => readResetToken());
  useEffect(() => {
    // Hash navigation also emits popstate. Handle it once and read the event URL,
    // since the credential is immediately removed from the address bar below.
    const receiveLink = (event: HashChangeEvent) => setResetToken(readResetToken(new URL(event.newURL).hash));
    window.addEventListener('hashchange', receiveLink);
    return () => { window.removeEventListener('hashchange', receiveLink); };
  }, []);
  useEffect(() => {
    if (resetToken !== null && new URLSearchParams(window.location.hash.slice(1)).has('reset-password'))
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, [resetToken]);
  if (resetToken !== null) return <PasswordResetPage key={resetToken} token={resetToken} onBack={() => { setResetToken(null); void refresh(); }} />;
  if (loading)
    return (
      <div className="auth-loading" role="status">
        <AuthBrand />
        <RefreshCw size={23} className="auth-spin" />
        <p>{t('워크스페이스를 준비하고 있습니다.')}</p>
      </div>
    );
  if (error && !user)
    return (
      <div className="auth-loading">
        <AuthBrand />
        <AuthNotice>{t(error)}</AuthNotice>
        <button className="button primary" onClick={() => void refresh()}>
          <RefreshCw size={16} />
          {t('다시 연결')}
        </button>
      </div>
    );
  if (!user) return <LoginPage />;
  if (user.status !== 'active') return <PendingApprovalPage />;
  return <Fragment key={`${user.id}:${user.role}:${user.status}`}>{children}</Fragment>;
}
