import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { t } from './i18n';
import { useLocale } from './use-locale';

export const InstallationEditorContext = createContext<{
  footer: HTMLElement | null;
  setDirty: (dirty: boolean) => void;
  cancel: () => void;
} | null>(null);

export function useInstallationDirty(dirty: boolean) {
  const context = useContext(InstallationEditorContext);
  const setDirty = context?.setDirty;
  useLayoutEffect(() => {
    setDirty?.(dirty);
    return () => setDirty?.(false);
  }, [setDirty, dirty]);
  return context;
}

export function InstallationEditorActions({ children }: { children: ReactNode }) {
  const context = useContext(InstallationEditorContext);
  const content = <div className="installation-editor-actions">{children}</div>;
  return context?.footer ? createPortal(content, context.footer) : content;
}

export function InstallationDiscardDialog({
  open,
  onOpenChange,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}) {
  useLocale();
  const keep = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="installation-edit-overlay" />
        <Dialog.Content
          className="installation-confirm-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current = document.activeElement as HTMLElement | null;
            keep.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current;
            requestAnimationFrame(() => {
              if (target?.isConnected) target.focus({ preventScroll: true });
            });
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.stopPropagation();
          }}
        >
          <Dialog.Title>{t('변경사항을 버릴까요?')}</Dialog.Title>
          <Dialog.Description>
            {t('저장하지 않은 입력이 있습니다. 계속 편집하거나 변경사항을 버릴 수 있습니다.')}
          </Dialog.Description>
          <div>
            <button
              type="button"
              className="button"
              onClick={() => {
                onOpenChange(false);
                onDiscard();
              }}
            >
              {t('변경사항 버리기')}
            </button>
            <button ref={keep} type="button" className="button primary" onClick={() => onOpenChange(false)}>
              {t('계속 편집')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
