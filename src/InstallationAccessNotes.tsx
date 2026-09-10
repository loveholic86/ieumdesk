import { t, getLocaleTag } from './i18n';
import { useLocale } from './use-locale';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, LockKeyhole, MessageSquareText, Pencil, Plus, Trash2 } from 'lucide-react';
import type { InstallationAccessNote } from './installation-types';
import './installation-access-notes.css';

export type InstallationAccessNotesProps = {
  notes: InstallationAccessNote[];
  revision: number;
  canManage: boolean;
  busy: boolean;
  policyPending: boolean;
  onCreate: (content: string, revision: number) => Promise<boolean>;
  onUpdate: (noteId: string, content: string, revision: number) => Promise<boolean>;
  onDelete: (noteId: string, revision: number) => Promise<boolean>;
  error?: string;
};

type NewDraft = { content: string; revision: number | null };
type EditDraft = { note: InstallationAccessNote; content: string; revision: number };
type DeleteTarget = { id: string; revision: number };
type PendingAction = 'create' | 'update' | 'delete' | null;

const maximumContentLength = 16_384;
const pageSize = 20;
const registeredAt = () =>
  new Intl.DateTimeFormat(getLocaleTag(), {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

function dateLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '등록일 확인 필요';
  return registeredAt().format(date);
}

function contentError(value: string) {
  if (!value.trim()) return '참고사항 내용을 입력해 주세요.';
  if (value.length > maximumContentLength) return '참고사항은 16,384자 이내로 입력해 주세요.';
  if (value.includes('\0')) return '참고사항에 사용할 수 없는 문자가 있습니다.';
  return '';
}

function NoteContent({ content, concealed }: { content: string; concealed: boolean }) {
  useLocale();
  const id = useId();
  const text = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useLayoutEffect(() => {
    setExpanded(false);
    if (concealed || !text.current) {
      setCanExpand(false);
      return;
    }
    const element = text.current;
    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight) || 24;
      setCanExpand(element.scrollHeight > lineHeight * 6 + 2);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, concealed]);

  if (concealed)
    return (
      <p className="installation-access-note-protected">
        <LockKeyhole size={14} aria-hidden="true" />
        {t('보호됨')}
      </p>
    );

  return (
    <div className="installation-access-note-text">
      <p id={id} ref={text} className={`installation-access-note-content${expanded ? '' : ' is-collapsed'}`}>
        {content}
      </p>
      {canExpand && (
        <button
          type="button"
          className="installation-access-note-expand"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
          {expanded ? t('접기') : t('더 보기')}
        </button>
      )}
    </div>
  );
}

export default function InstallationAccessNotes({
  notes,
  revision,
  canManage,
  busy,
  policyPending,
  onCreate,
  onUpdate,
  onDelete,
  error,
}: InstallationAccessNotesProps) {
  useLocale();
  const id = useId();
  const [draft, setDraft] = useState<NewDraft>({ content: '', revision: null });
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [pending, setPending] = useState<PendingAction>(null);
  const [attempted, setAttempted] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [requestError, setRequestError] = useState('');
  const mounted = useRef(false);
  const operation = useRef<number | null>(null);
  const generation = useRef(0);
  const current = useRef({ canManage, busy, policyPending });
  current.current = { canManage, busy, policyPending };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = null;
      ++generation.current;
    };
  }, []);

  const orderedNotes = useMemo(
    () => [...notes].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)),
    [notes],
  );
  const visibleNotes = orderedNotes.slice(0, visibleCount);
  const activeNoteId = editing?.note.id ?? deleting?.id;
  const activeNote = orderedNotes.find((note) => note.id === activeNoteId);
  // Keep an open editor or confirmation reachable if newer notes move it beyond this page.
  const displayedNotes =
    activeNote && !visibleNotes.some((note) => note.id === activeNote.id)
      ? [...visibleNotes, activeNote]
      : visibleNotes;
  const locked = busy || pending !== null || policyPending;
  const message = attempted ? validationError || error || requestError : '';
  const editingMissing = editing && !notes.some((note) => note.id === editing.note.id);

  useEffect(() => {
    if (deleting && !notes.some((note) => note.id === deleting.id)) {
      setDeleting(null);
      setAttempted(false);
      setValidationError('');
      setRequestError('');
    }
  }, [deleting, notes]);

  const resetFeedback = () => {
    setAttempted(false);
    setValidationError('');
    setRequestError('');
  };
  const mayAct = () =>
    current.current.canManage &&
    !current.current.busy &&
    !current.current.policyPending &&
    operation.current === null;
  const validate = (value: string) => {
    const invalid = contentError(value);
    setAttempted(true);
    setValidationError(invalid);
    return !invalid;
  };
  const run = async (
    action: Exclude<PendingAction, null>,
    request: () => Promise<boolean>,
    saved: () => void,
  ) => {
    if (!mayAct()) return;
    const token = ++generation.current;
    operation.current = token;
    setPending(action);
    setAttempted(true);
    setValidationError('');
    setRequestError('');
    try {
      const success = await request();
      if (!mounted.current || operation.current !== token) return;
      if (success) {
        saved();
        resetFeedback();
      } else {
        setRequestError('요청을 처리하지 못했습니다. 입력한 내용은 유지됩니다.');
      }
    } catch (reason) {
      if (mounted.current && operation.current === token)
        setRequestError(
          reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다. 다시 확인해 주세요.',
        );
    } finally {
      if (mounted.current && operation.current === token) {
        operation.current = null;
        setPending(null);
      }
    }
  };
  const submitNew = (event: React.FormEvent) => {
    event.preventDefault();
    if (!mayAct() || editing || deleting || !validate(draft.content)) return;
    const submitted = draft;
    void run(
      'create',
      () => onCreate(submitted.content, submitted.revision ?? revision),
      () => {
        setDraft((latest) =>
          latest.content === submitted.content && latest.revision === submitted.revision
            ? { content: '', revision: null }
            : latest,
        );
      },
    );
  };
  const submitEdit = (event: React.FormEvent, submitted: EditDraft) => {
    event.preventDefault();
    if (!mayAct() || !validate(submitted.content)) return;
    if (!submitted.note.masked && submitted.content === submitted.note.content) {
      setValidationError('변경한 참고사항 내용이 없습니다.');
      return;
    }
    void run(
      'update',
      () => onUpdate(submitted.note.id, submitted.content, submitted.revision),
      () => {
        setEditing((latest) =>
          latest?.note.id === submitted.note.id &&
          latest.content === submitted.content &&
          latest.revision === submitted.revision
            ? null
            : latest,
        );
      },
    );
  };

  const renderEditor = (entry: EditDraft) => (
    <form
      autoComplete="off"
      spellCheck={false}
      className="installation-access-note-editor"
      onSubmit={(event) => submitEdit(event, entry)}
    >
      <label htmlFor={`${id}-edit`}>{t('참고사항 수정 내용')}</label>
      {entry.note.masked && (
        <p className="installation-access-note-hint">
          <LockKeyhole size={13} aria-hidden="true" />
          {t('보호된 내용은 새로 입력한 내용으로 교체됩니다.')}
        </p>
      )}
      <textarea
        id={`${id}-edit`}
        rows={6}
        maxLength={maximumContentLength}
        value={policyPending ? '' : entry.content}
        placeholder={
          entry.note.masked ? t('변경할 내용을 새로 입력하세요.') : t('참고사항 내용을 입력하세요.')
        }
        disabled={locked}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          if (!mayAct()) return;
          const value = event.target.value;
          setEditing((latest) =>
            latest?.note.id === entry.note.id ? { ...latest, content: value } : latest,
          );
          resetFeedback();
        }}
      />
      <div className="installation-access-note-form-footer">
        <span className="installation-access-note-counter">
          {(policyPending ? 0 : entry.content.length).toLocaleString(getLocaleTag())} / 16,384
        </span>
        <div className="installation-access-note-buttons">
          <button
            type="button"
            className="button"
            disabled={locked}
            onClick={() => {
              if (!mayAct()) return;
              setEditing(null);
              resetFeedback();
            }}
          >
            {t('취소')}
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={
              locked || !entry.content.trim() || (!entry.note.masked && entry.content === entry.note.content)
            }
          >
            {pending === 'update' ? t('저장 중…') : t('수정 저장')}
          </button>
        </div>
      </div>
      {message && (
        <p className="installation-access-note-error" role="alert">
          {t(message)}
        </p>
      )}
    </form>
  );

  return (
    <section
      className="installation-access-notes"
      aria-labelledby={`${id}-title`}
      aria-busy={pending !== null}
    >
      <header className="installation-access-notes-heading">
        <div>
          <MessageSquareText size={17} aria-hidden="true" />
          <h3 id={`${id}-title`}>{t('참고사항')}</h3>
          <span className="installation-access-notes-count">
            {notes.length.toLocaleString(getLocaleTag())}
          </span>
        </div>
        <span className="installation-access-notes-order">{t('최신 등록순')}</span>
      </header>
      {policyPending && (
        <p className="installation-access-note-hint" role="status">
          {t('보호 설정을 확인하고 있습니다.')}
        </p>
      )}
      {canManage && (
        <form
          autoComplete="off"
          spellCheck={false}
          className="installation-access-notes-composer"
          onSubmit={submitNew}
        >
          <label htmlFor={`${id}-new`}>{t('참고사항 내용')}</label>
          <textarea
            id={`${id}-new`}
            rows={3}
            maxLength={maximumContentLength}
            value={policyPending ? '' : draft.content}
            placeholder={t('접근 시 참고할 내용을 입력하세요.')}
            disabled={locked || editing !== null || deleting !== null}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              if (!mayAct() || editing || deleting) return;
              const value = event.target.value;
              // A new list response must not silently advance an in-progress draft's revision.
              setDraft((latest) => ({
                content: value,
                revision: value ? (latest.revision ?? revision) : null,
              }));
              resetFeedback();
            }}
          />
          <div className="installation-access-note-form-footer">
            <span className="installation-access-note-counter">
              {(policyPending ? 0 : draft.content.length).toLocaleString(getLocaleTag())} / 16,384
            </span>
            <div className="installation-access-note-buttons">
              {draft.content && (
                <button
                  type="button"
                  className="button"
                  disabled={locked || editing !== null || deleting !== null}
                  onClick={() => {
                    if (!mayAct()) return;
                    setDraft({ content: '', revision: null });
                    resetFeedback();
                  }}
                >
                  {t('입력 취소')}
                </button>
              )}
              <button
                type="submit"
                className="button primary"
                disabled={locked || editing !== null || deleting !== null || !draft.content.trim()}
              >
                <Plus size={14} aria-hidden="true" />
                {pending === 'create' ? t('등록 중…') : t('등록')}
              </button>
            </div>
          </div>
          {!editing && !deleting && message && (
            <p className="installation-access-note-error" role="alert">
              {t(message)}
            </p>
          )}
        </form>
      )}
      {canManage && editingMissing && editing && (
        <div className="installation-access-note-detached">
          <p className="installation-access-note-hint">
            {t('수정 중인 참고사항이 목록에서 없어졌습니다. 입력한 내용은 유지됩니다.')}
          </p>
          {renderEditor(editing)}
        </div>
      )}
      {orderedNotes.length ? (
        <ol className="installation-access-notes-list">
          {displayedNotes.map((note) => {
            const editingThis = canManage && editing?.note.id === note.id;
            const deletingThis = canManage && deleting?.id === note.id;
            const createdAt = dateLabel(note.createdAt);
            return (
              <li key={note.id} className="installation-access-note-item">
                <article aria-label={t('{0} 등록 참고사항', [createdAt])}>
                  <header className="installation-access-note-meta">
                    <time dateTime={note.createdAt}>
                      <span>{t('등록일')}</span> {createdAt}
                    </time>
                    {canManage && !editingThis && !deletingThis && (
                      <div className="installation-access-note-actions">
                        <button
                          type="button"
                          className="installation-access-note-action"
                          disabled={locked || Boolean(editing || deleting || draft.content)}
                          aria-label={t('{0} 참고사항 수정', [createdAt])}
                          onClick={() => {
                            if (!mayAct() || editing || deleting || draft.content) return;
                            resetFeedback();
                            setEditing({
                              note: { ...note },
                              content: note.masked ? '' : note.content,
                              revision,
                            });
                          }}
                        >
                          <Pencil size={13} aria-hidden="true" />
                          {t('수정')}
                        </button>
                        <button
                          type="button"
                          className="installation-access-note-action is-danger"
                          disabled={locked || Boolean(editing || deleting || draft.content)}
                          aria-label={t('{0} 참고사항 삭제', [createdAt])}
                          onClick={() => {
                            if (!mayAct() || editing || deleting || draft.content) return;
                            resetFeedback();
                            setDeleting({ id: note.id, revision });
                          }}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                          {t('삭제')}
                        </button>
                      </div>
                    )}
                  </header>
                  {editingThis && editing ? (
                    renderEditor(editing)
                  ) : (
                    <NoteContent content={note.content} concealed={note.masked || policyPending} />
                  )}
                  {deletingThis && deleting && (
                    <div
                      className="installation-access-note-delete"
                      role="group"
                      aria-label={t('참고사항 삭제 확인')}
                    >
                      <p>{t('이 참고사항을 삭제할까요?')}</p>
                      <div className="installation-access-note-buttons">
                        <button
                          type="button"
                          className="button"
                          disabled={locked}
                          onClick={() => {
                            if (!mayAct()) return;
                            setDeleting(null);
                            resetFeedback();
                          }}
                        >
                          {t('취소')}
                        </button>
                        <button
                          type="button"
                          className="button danger"
                          disabled={locked}
                          onClick={() => {
                            const target = deleting;
                            void run(
                              'delete',
                              () => onDelete(target.id, target.revision),
                              () => {
                                setDeleting((latest) => (latest?.id === target.id ? null : latest));
                              },
                            );
                          }}
                        >
                          {pending === 'delete' ? t('삭제 중…') : t('삭제 확인')}
                        </button>
                      </div>
                      {message && (
                        <p className="installation-access-note-error" role="alert">
                          {t(message)}
                        </p>
                      )}
                    </div>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="installation-access-notes-empty">{t('등록된 참고사항이 없습니다.')}</p>
      )}
      {orderedNotes.length > displayedNotes.length && (
        <button
          type="button"
          className="installation-access-notes-more"
          onClick={() => setVisibleCount((count) => count + pageSize)}
        >
          <ChevronDown size={15} aria-hidden="true" />
          {t('이전 글 더 보기 ')}
          <span>
            ({Math.min(pageSize, orderedNotes.length - displayedNotes.length)}
            {t('개)')}
          </span>
        </button>
      )}
    </section>
  );
}
