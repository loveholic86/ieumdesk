import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy, LockKeyhole, RefreshCw, X } from 'lucide-react';
import { AuthNotice, PasswordField, authRequest, type User } from './auth';
import { getLocaleTag, t } from './i18n';
import { useLocale } from './use-locale';

export type PasswordResetRequest = { userId: string; requestedAt: string };

export function AdminPasswordResetDialog({
  user,
  requestedAt,
  onClose,
  onIssued,
  onFocusFallback,
}: {
  user: User;
  requestedAt?: string;
  onClose: () => void;
  onIssued: () => void;
  onFocusFallback: () => void;
}) {
  useLocale();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<{ url: string; expiresAt: string } | null>(null);
  const linkRef = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const reset = await authRequest<{ resetPath: string; expiresAt: string }>(
        `/admin/users/${encodeURIComponent(user.id)}/password-reset`,
        { method: 'POST', body: JSON.stringify({ currentPassword: password }) },
      );
      setResult({ url: new URL(reset.resetPath, window.location.origin).href, expiresAt: reset.expiresAt });
      onIssued();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '재설정 링크를 발급하지 못했습니다.');
    } finally {
      setBusy(false);
      setPassword('');
    }
  };
  const copy = async () => {
    if (!result) return;
    setError('');
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
    } catch {
      linkRef.current?.focus();
      linkRef.current?.select();
      setError('복사하지 못했습니다. 링크를 직접 선택해 복사해 주세요.');
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
          className="account-user-dialog password-reset-dialog"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
            else onFocusFallback();
          }}
        >
          <div className="account-user-dialog-header">
            <span className="heading-icon">
              <LockKeyhole size={20} />
            </span>
            <div>
              <Dialog.Title>{t('비밀번호 초기화')}</Dialog.Title>
              <Dialog.Description>
                {t('본인 확인 후 고객에게 일회용 재설정 링크를 전달하세요.')}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label={t('닫기')} disabled={busy}>
              <X size={20} />
            </Dialog.Close>
          </div>
          <div className="account-user-dialog-body">
            <div className="reset-target">
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
            {requestedAt && (
              <p className="reset-help">
                {t('초기화 요청일: {0}', [new Date(requestedAt).toLocaleString(getLocaleTag())])}
              </p>
            )}
            <AuthNotice>{t(error)}</AuthNotice>
            {result ? (
              <div className="auth-form">
                <AuthNotice success>
                  {t('재설정 링크를 발급했습니다. 이 창을 닫으면 링크를 다시 확인할 수 없습니다.')}
                </AuthNotice>
                <div className="auth-field">
                  <label htmlFor="issued-reset-link">{t('일회용 재설정 링크')}</label>
                  <textarea
                    id="issued-reset-link"
                    ref={linkRef}
                    readOnly
                    value={result.url}
                    rows={3}
                    onFocus={(event) => event.currentTarget.select()}
                    spellCheck={false}
                  />
                </div>
                <p className="reset-help">
                  {t('만료 시각: {0}', [new Date(result.expiresAt).toLocaleString(getLocaleTag())])}
                </p>
                <button className="button primary" type="button" onClick={() => void copy()}>
                  <Copy size={16} />
                  {t(copied ? '복사했습니다' : '링크 복사')}
                </button>
                <p className="reset-help">
                  {t('고객이 링크에서 새 비밀번호를 저장하면 기존 비밀번호와 모든 로그인이 무효화됩니다.')}
                </p>
              </div>
            ) : (
              <form className="auth-form" onSubmit={submit}>
                <p className="reset-help">
                  {t(
                    '초기화 요청만으로는 본인이 확인되지 않습니다. 기존에 확인된 연락처로 본인 확인 후 링크를 전달하세요. 링크는 30분 동안 한 번만 사용할 수 있으며, 재발급하면 이전 링크는 무효화됩니다.',
                  )}
                </p>
                <PasswordField
                  id="admin-reset-password"
                  name="currentPassword"
                  label="관리자 본인의 비밀번호"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  maxLength={128}
                  required
                  disabled={busy}
                />
                <button className="button primary" type="submit" disabled={busy}>
                  {busy && <RefreshCw size={16} className="auth-spin" />}
                  {t(busy ? '발급 중' : '재설정 링크 발급')}
                </button>
              </form>
            )}
          </div>
          <div className="account-user-dialog-footer">
            <Dialog.Close className="button" disabled={busy}>
              {t('닫기')}
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
