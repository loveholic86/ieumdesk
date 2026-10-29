import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { LockKeyhole } from 'lucide-react';
import { t } from './i18n';
import { useLocale } from './use-locale';
import {
  inlineRemarkKeyAction,
  inlineRemarkMaxLength,
  inlineRemarkMultiline,
  inlineRemarkPreview,
  inlineRemarkReduce,
  type InlineRemarkState,
} from './installation-inline-remark';
import type { InstallationDetailField, InstallationSectionId } from './installation-types';

export type InlineRemarkSave = (
  sectionId: InstallationSectionId,
  field: InstallationDetailField,
  draft: string,
) => Promise<boolean>;

/** One screen-wide contract: exactly one open session, only for the fields this phase allows. */
export type InstallationInlineRemarkControls = {
  canEdit: boolean;
  openFieldId: string;
  open: (field: InstallationDetailField) => void;
  /** Close only while this field still owns the session, so a handover is never cancelled. */
  close: (fieldId: string) => void;
  save: InlineRemarkSave;
};

/** No provider (other screens, unit tests) leaves the cards as plain read-only values. */
const controls = createContext<InstallationInlineRemarkControls | null>(null);
export const InstallationInlineRemarkProvider = controls.Provider;
export const useInstallationInlineRemark = () => useContext(controls);

type Props = {
  field: InstallationDetailField;
  sectionId: InstallationSectionId;
  /** Field label, and the base of the preview's accessible name. */
  label: string;
  /** Protected remark: the preview masks it and a blank draft keeps the stored value. */
  masked: boolean;
};

/**
 * A dependency-free Editable that follows the Park/Chakra activation and key contract: click to
 * edit, Enter commits a single line, ⌘/Ctrl+Enter commits a textarea (Enter is a newline), Escape
 * reverts without a request, and a blur commits only when the draft changed.
 *
 * The open session lives in the provider, so a screen holds exactly one editor. Clicking another
 * preview blurs this input first, which commits it before the next session opens.
 */
export default function InstallationEditable({ field, sectionId, label, masked }: Props) {
  useLocale();
  const inline = useInstallationInlineRemark();
  const open = inline?.openFieldId === field.id;
  const [session, setSession] = useState<InlineRemarkState>(() => inlineRemarkPreview(field.value));
  const current = useRef(session);
  current.current = session;
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    // Re-armed on every mount: StrictMode mounts, unmounts, and mounts again in development.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A closed session always reverts: the stored text is the only truth the preview shows.
  useEffect(() => {
    if (open)
      setSession(
        inlineRemarkReduce(current.current, {
          type: 'open',
          baseline: masked ? '' : field.value,
          masked,
        }).state,
      );
    else setSession(inlineRemarkPreview(masked ? '' : field.value, masked));
    // Only a session boundary re-seeds; typing must never be overwritten by an unrelated render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, masked, field.value]);

  useEffect(() => {
    if (session.phase !== 'editing') return;
    const element = input.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    // Park/Chakra place the caret at the end; selecting all would rewrite a remark on the first key.
    element.setSelectionRange(element.value.length, element.value.length);
  }, [session.phase]);

  const dispatch = (action: Parameters<typeof inlineRemarkReduce>[1]) => {
    const outcome = inlineRemarkReduce(current.current, action);
    if (outcome.state === current.current) return;
    current.current = outcome.state;
    setSession(outcome.state);
    if (!outcome.send) {
      if (outcome.state.phase === 'preview') inline?.close(field.id);
      return;
    }
    void inline!.save(sectionId, field, outcome.send).then(() => {
      if (!alive.current) return;
      // The owner re-reads the details, so a failed save shows the stored value, never the draft.
      const settled = inlineRemarkReduce(current.current, { type: 'settled' }).state;
      current.current = settled;
      setSession(settled);
      inline!.close(field.id);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const action = inlineRemarkKeyAction({
      key: event.key,
      multiline: inlineRemarkMultiline(field),
      modifier: event.metaKey || event.ctrlKey,
      composing: event.nativeEvent.isComposing,
    });
    if (action === 'ignore' || action === 'newline') return;
    event.preventDefault();
    // Escape also reaches the dialog, which would close the whole card; a cancel stops here.
    event.stopPropagation();
    dispatch({ type: action === 'cancel' ? 'escape' : 'confirm', stored: field.value });
  };

  const shown = masked ? (
    <span className="installation-protected-value">
      <LockKeyhole size={13} aria-hidden="true" />
      <span className="installation-mask" aria-hidden="true">
        ••••••••
      </span>
      <span className="installation-protected-label">{t('보호됨')}</span>
    </span>
  ) : field.value ? (
    field.value
  ) : (
    <span className="installation-missing">{t('미등록')}</span>
  );

  if (!open) {
    // Without write permission the value stays plain read-only text, never a button.
    if (!inline?.canEdit) return <span className="installation-editable is-readonly">{shown}</span>;
    return (
      <span className="installation-editable">
        <button
          type="button"
          className="installation-editable-preview"
          aria-label={t('{0} 수정', [label])}
          onClick={() => inline.open(field)}
        >
          {shown}
        </button>
      </span>
    );
  }

  const multiline = inlineRemarkMultiline(field);
  const saving = session.phase === 'saving';
  const shared = {
    className: 'installation-editable-input',
    value: session.draft,
    maxLength: inlineRemarkMaxLength(field),
    disabled: saving,
    spellCheck: false,
    autoComplete: 'off' as const,
    placeholder: masked ? t('새 값을 입력하면 기존 값이 교체됩니다.') : t('내용을 입력하세요'),
    'aria-label': t('{0} 편집', [label]),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      dispatch({ type: 'input', draft: event.target.value }),
    onKeyDown,
    onBlur: () => dispatch({ type: 'confirm', stored: field.value }),
  };
  return (
    <span className={`installation-editable is-editing${saving ? ' is-saving' : ''}`}>
      {multiline ? (
        <textarea {...shared} ref={input as RefObject<HTMLTextAreaElement>} rows={3} />
      ) : (
        <input {...shared} ref={input as RefObject<HTMLInputElement>} />
      )}
      <span className="installation-editable-hint" role={saving ? 'status' : undefined}>
        {saving
          ? t('저장 중…')
          : masked
            ? t('비워 두면 기존 값을 유지합니다.')
            : multiline
              ? t('Ctrl+Enter로 저장하고 Enter는 줄바꿈입니다.')
              : t('Enter로 저장하고 Esc로 취소합니다.')}
      </span>
    </span>
  );
}
