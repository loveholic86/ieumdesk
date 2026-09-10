import { t, getLocaleTag } from './i18n';
import { useLocale } from './use-locale';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Code2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useAuth } from './auth';
import { installationRequest as request } from './installation-api';
import { catalogFormPayload } from './catalog-client';
import './catalog-support.css';

type Product = {
  id: string;
  name: string;
  unitPrice: number;
  description: string;
  active: boolean;
  revision: number;
  category?: string;
  subCategory?: string;
};
type Code = {
  id: string;
  group: string;
  groupName: string;
  code: string;
  name: string;
  parentCode: string;
  numericValue: number | null;
  active: boolean;
  revision: number;
};
type Entry = Product | Code;
type CatalogKind = 'products' | 'codes';
type Props = { notify?: (text: string, error?: boolean) => void };
type Draft = {
  name: string;
  unitPrice: string;
  description: string;
  active: boolean;
  category: string;
  subCategory: string;
  group: string;
  groupName: string;
  code: string;
  parentCode: string;
  numericValue: string;
};
const asDraft = (entry: Entry | null): Draft => {
  const product = entry as Product | null,
    code = entry as Code | null;
  return {
    name: entry?.name || '',
    unitPrice: String(product?.unitPrice ?? 0),
    description: product?.description || '',
    active: entry?.active ?? true,
    category: product?.category || '',
    subCategory: product?.subCategory || '',
    group: code?.group || '',
    groupName: code?.groupName || '',
    code: code?.code || '',
    parentCode: code?.parentCode || '',
    numericValue: code?.numericValue == null ? '' : String(code.numericValue),
  };
};
const validEntry = (value: unknown, kind: CatalogKind): value is Entry => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.active === 'boolean' &&
    Number.isSafeInteger(item.revision) &&
    (kind === 'products'
      ? Number.isSafeInteger(item.unitPrice) && typeof item.description === 'string'
      : typeof item.group === 'string' &&
        typeof item.groupName === 'string' &&
        typeof item.code === 'string' &&
        typeof item.parentCode === 'string' &&
        (item.numericValue === null ||
          (typeof item.numericValue === 'number' && Number.isFinite(item.numericValue))))
  );
};

export function ProductCatalogPage(props: Props = {}) {
  useLocale();
  return <CatalogManager kind="products" {...props} />;
}
export function CodeCatalogPage(props: Props = {}) {
  useLocale();
  return <CatalogManager kind="codes" {...props} />;
}

function CatalogManager({ kind, notify }: Props & { kind: CatalogKind }) {
  useLocale();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && user.status === 'active';
  const identity = `${user?.id || ''}:${user?.role || ''}:${user?.status || ''}`;
  const [items, setItems] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<Entry | 'new' | null>(null);
  const [busy, setBusy] = useState('');
  const [saveError, setSaveError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const opener = useRef<HTMLElement | null>(null);
  const isProduct = kind === 'products';
  const singular = isProduct ? '상품' : '코드';
  const base = `/catalog/${kind}`;
  useEffect(() => {
    alive.current = true;
    setEditing(null);
    setItems([]);
    setMessage('');
    setError('');
    setBusy('');
    operation.current?.abort();
    return () => {
      alive.current = false;
      operation.current?.abort();
    };
  }, [identity, kind]);
  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void request<{ items: Entry[] }>(`${base}?includeInactive=true`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!Array.isArray(result.items) || !result.items.every((item) => validEntry(item, kind)))
          throw new Error(`${singular} 목록 응답을 확인하지 못했습니다.`);
        if (!controller.signal.aborted && currentIdentity.current === identity) setItems(result.items);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : `${singular} 목록을 불러오지 못했습니다.`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, isProduct, kind, singular, retry, identity, isAdmin]);
  useEffect(() => {
    setPage(1);
  }, [query, group, statusFilter]);
  const groups = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((item) => (isProduct ? (item as Product).category || '' : (item as Code).group))
            .filter(Boolean),
        ),
      ).sort(),
    [items, isProduct],
  );
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        const targetGroup = isProduct ? (item as Product).category || '' : (item as Code).group;
        return (
          (!group || targetGroup === group) &&
          (!statusFilter || item.active === (statusFilter === 'active')) &&
          (!query.trim() ||
            Object.values(item)
              .filter((value) => typeof value === 'string')
              .join(' ')
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()))
        );
      }),
    [items, group, statusFilter, query, isProduct],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 15)),
    currentPage = Math.min(page, pages);
  const open = (entry: Entry | 'new') => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSaveError('');
    setEditing(entry);
  };
  const mutate = async (id: string | undefined, payload: Record<string, unknown>, success: string) => {
    if (!isAdmin || busy) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setBusy(id || 'new');
    setSaveError('');
    setError('');
    setMessage('');
    try {
      await request(`${base}${id ? `/${encodeURIComponent(id)}` : ''}`, {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!alive.current || currentIdentity.current !== identity || controller.signal.aborted) return;
      setEditing(null);
      setRetry((value) => value + 1);
      setMessage(success);
      notify?.(success);
    } catch (reason) {
      if (!controller.signal.aborted && alive.current && currentIdentity.current === identity) {
        const text = reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 확인해 주세요.';
        if (editing) setSaveError(text);
        else setError(text);
      }
    } finally {
      if (alive.current && currentIdentity.current === identity) {
        setBusy('');
        operation.current = null;
      }
    }
  };
  if (!isAdmin)
    return (
      <div className="catalog-empty">
        <CircleAlert size={26} />
        <h3>
          {t('관리자만 ')}
          {t(singular)}
          {t(' 목록을 관리할 수 있습니다.')}
        </h3>
      </div>
    );
  return (
    <section className="catalog-page">
      <header className="catalog-heading">
        <div className="catalog-mark">{isProduct ? <Package size={22} /> : <Code2 size={22} />}</div>
        <div>
          <h2>{isProduct ? t('견적 상품 관리') : t('코드 관리')}</h2>
          <p>
            {isProduct
              ? t('견적에 사용할 상품과 기본 단가를 관리합니다.')
              : t('업무 분류와 선택 항목에 사용하는 코드를 관리합니다.')}
          </p>
        </div>
        <button className="button primary" disabled={Boolean(busy)} onClick={() => open('new')}>
          <Plus size={16} />
          {t(singular)}
          {t(' 추가')}
        </button>
      </header>
      <div className="catalog-toolbar">
        <label className="catalog-search">
          <Search size={17} />
          <input
            aria-label={t('{0} 검색', [t(singular)])}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={isProduct ? t('상품명·설명 검색') : t('코드·이름·그룹 검색')}
          />
          {query && (
            <button className="icon-button" aria-label={t('검색어 지우기')} onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </label>
        <select
          aria-label={isProduct ? t('상품 분류') : t('코드 그룹')}
          value={group}
          onChange={(event) => setGroup(event.target.value)}
        >
          <option value="">{isProduct ? t('전체 분류') : t('전체 그룹')}</option>
          {groups.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label={t('{0} 사용 상태', [t(singular)])}
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="">{t('전체 상태')}</option>
          <option value="active">{t('사용 중')}</option>
          <option value="inactive">{t('사용 안 함')}</option>
        </select>
        <button
          className="button"
          disabled={loading || Boolean(busy)}
          onClick={() => setRetry((value) => value + 1)}
        >
          <RefreshCw size={15} className={loading ? 'auth-spin' : ''} />
          {t('새로고침')}
        </button>
      </div>
      {error && (
        <p className="catalog-message is-error" role="alert">
          {t(error)}
        </p>
      )}
      {message && (
        <p className="catalog-message" role="status">
          <Check size={15} />
          {t(message)}
        </p>
      )}
      <div
        className="catalog-table-wrap"
        tabIndex={0}
        role="region"
        aria-label={t('{0} 목록', [t(singular)])}
      >
        <table className="catalog-table">
          <thead>
            <tr>
              {(isProduct
                ? ['상품', '분류', '세부 분류', '기본 단가', '사용 상태', '관리']
                : ['코드 그룹', '코드', '코드 이름', '상위 코드', '숫자 값', '사용 상태', '관리']
              ).map((label) => (
                <th key={label} scope="col">
                  {t(label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice((currentPage - 1) * 15, currentPage * 15).map((item) => (
              <tr key={item.id} className={item.active ? '' : 'is-inactive'}>
                {isProduct ? (
                  <>
                    <td>
                      <button className="catalog-name" onClick={() => open(item)}>
                        {item.name}
                      </button>
                      <p className="catalog-description">{(item as Product).description || t('설명 없음')}</p>
                    </td>
                    <td>{(item as Product).category || t('미분류')}</td>
                    <td>{(item as Product).subCategory || '—'}</td>
                    <td className="catalog-number">
                      {(item as Product).unitPrice.toLocaleString(getLocaleTag())}
                      <small>{t('원')}</small>
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      <strong className="catalog-group">
                        {(item as Code).groupName || (item as Code).group}
                      </strong>
                      <small className="catalog-subtext">{(item as Code).group}</small>
                    </td>
                    <td className="catalog-code">{(item as Code).code}</td>
                    <td>
                      <button className="catalog-name" onClick={() => open(item)}>
                        {item.name}
                      </button>
                    </td>
                    <td>{(item as Code).parentCode || '—'}</td>
                    <td className="catalog-number">{(item as Code).numericValue ?? '—'}</td>
                  </>
                )}
                <td>
                  <span className={`catalog-state ${item.active ? 'active' : ''}`}>
                    {item.active ? t('사용 중') : t('사용 안 함')}
                  </span>
                </td>
                <td>
                  <div className="catalog-row-actions">
                    <button
                      className="icon-button"
                      aria-label={t('{0} 수정', [item.name])}
                      onClick={() => open(item)}
                      disabled={Boolean(busy)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="catalog-text-button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void mutate(
                          item.id,
                          { revision: item.revision, active: !item.active },
                          `${item.name} ${singular}을 ${item.active ? '사용 안 함' : '사용 중'}으로 변경했습니다.`,
                        )
                      }
                    >
                      {item.active ? t('비활성화') : t('활성화')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length && (
        <div className="catalog-empty" role={loading ? 'status' : undefined}>
          {loading ? (
            <>
              <RefreshCw size={25} className="auth-spin" />
              <p>
                {t(singular)}
                {t(' 목록을 불러오고 있습니다.')}
              </p>
            </>
          ) : (
            <>
              <Search size={26} />
              <h3>
                {items.length
                  ? t('조건에 맞는 항목이 없습니다.')
                  : t('등록된 {0}{1} 없습니다.', [t(singular), kind === 'products' ? t('이') : t('가')])}
              </h3>
              <p>
                {items.length
                  ? t('검색어나 필터를 변경해 주세요.')
                  : t('상단의 {0} 추가로 첫 항목을 등록하세요.', [t(singular)])}
              </p>
            </>
          )}
        </div>
      )}
      <footer className="catalog-pagination">
        <span>
          {t('전체 ')}
          <strong>{filtered.length.toLocaleString()}</strong>
          {t('개')}
        </span>
        <div>
          <button
            className="icon-button"
            aria-label={t('이전 페이지')}
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {currentPage} / {pages}
          </span>
          <button
            className="icon-button"
            aria-label={t('다음 페이지')}
            disabled={currentPage === pages}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </footer>
      {editing && (
        <CatalogEditor
          key={editing === 'new' ? 'new' : editing.id}
          kind={kind}
          entry={editing === 'new' ? null : editing}
          groups={groups}
          busy={Boolean(busy)}
          error={saveError}
          onClose={() => {
            setEditing(null);
            setSaveError('');
          }}
          onRestoreFocus={() => opener.current?.isConnected && opener.current.focus()}
          onSave={(payload) =>
            void mutate(
              editing === 'new' ? undefined : editing.id,
              { ...payload, ...(editing === 'new' ? {} : { revision: editing.revision }) },
              `${singular} 정보를 저장했습니다.`,
            )
          }
        />
      )}
    </section>
  );
}

function CatalogEditor({
  kind,
  entry,
  groups,
  busy,
  error,
  onClose,
  onRestoreFocus,
  onSave,
}: {
  kind: CatalogKind;
  entry: Entry | null;
  groups: string[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onRestoreFocus: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  useLocale();
  const [draft, setDraft] = useState(() => asDraft(entry));
  const [localError, setLocalError] = useState('');
  const change = (key: keyof Draft, value: string | boolean) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const product = kind === 'products';
  const saveFields = (values: Record<string, unknown>) => {
    try {
      onSave(catalogFormPayload(values, entry));
      setLocalError('');
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : '입력 내용을 확인해 주세요.');
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const name = draft.name.trim();
    if (!name) return setLocalError('이름을 입력해 주세요.');
    if (product) {
      const unitPrice = Number(draft.unitPrice);
      if (!draft.unitPrice.trim() || !Number.isSafeInteger(unitPrice) || unitPrice < 0)
        return setLocalError('기본 단가를 0 이상의 정수로 입력해 주세요.');
      saveFields({
        name,
        unitPrice,
        description: draft.description,
        active: draft.active,
        category: draft.category.trim(),
        subCategory: draft.subCategory.trim(),
      });
    } else {
      if (!draft.group.trim() || !draft.code.trim())
        return setLocalError('코드 그룹과 코드를 입력해 주세요.');
      const numericValue = draft.numericValue.trim() === '' ? null : Number(draft.numericValue);
      if (numericValue !== null && !Number.isSafeInteger(numericValue))
        return setLocalError('숫자 값은 안전한 범위의 정수로 입력해 주세요.');
      saveFields({
        name,
        group: draft.group.trim(),
        groupName: draft.groupName.trim(),
        code: draft.code.trim(),
        parentCode: draft.parentCode.trim(),
        numericValue,
        active: draft.active,
      });
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
          className="dialog catalog-dialog"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus();
          }}
        >
          <header className="catalog-dialog-heading">
            <div>
              <Dialog.Title>
                {product ? t('상품') : t('코드')} {entry ? t('수정') : t('추가')}
              </Dialog.Title>
              <Dialog.Description>
                {product
                  ? t('견적에 사용할 상품 정보와 기본 단가를 입력하세요.')
                  : t('코드의 분류와 표시할 이름을 입력하세요.')}
              </Dialog.Description>
            </div>
            <button className="icon-button" aria-label={t('편집 닫기')} disabled={busy} onClick={onClose}>
              <X size={19} />
            </button>
          </header>
          <form autoComplete="off" spellCheck={false} onSubmit={submit}>
            <div className="catalog-form-grid">
              <label className="catalog-form-field wide">
                {product ? t('상품명') : t('코드 이름')}
                <input
                  autoFocus
                  required
                  maxLength={200}
                  value={draft.name}
                  onChange={(event) => change('name', event.target.value)}
                  disabled={busy}
                />
              </label>
              {product ? (
                <>
                  <label className="catalog-form-field">
                    {t('분류')}
                    <input
                      list="catalog-product-categories"
                      maxLength={100}
                      value={draft.category}
                      onChange={(event) => change('category', event.target.value)}
                      disabled={busy}
                    />
                    <datalist id="catalog-product-categories">
                      {groups.map((group) => (
                        <option key={group} value={group} />
                      ))}
                    </datalist>
                  </label>
                  <label className="catalog-form-field">
                    {t('세부 분류')}
                    <input
                      maxLength={100}
                      value={draft.subCategory}
                      onChange={(event) => change('subCategory', event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label className="catalog-form-field">
                    {t('기본 단가 · 원')}
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      required
                      value={draft.unitPrice}
                      onChange={(event) => change('unitPrice', event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label className="catalog-form-field wide">
                    {t('설명')}
                    <textarea
                      rows={4}
                      maxLength={10000}
                      value={draft.description}
                      onChange={(event) => change('description', event.target.value)}
                      disabled={busy}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="catalog-form-field">
                    {t('코드 그룹')}
                    <input
                      required
                      list="catalog-code-groups"
                      maxLength={100}
                      value={draft.group}
                      onChange={(event) => change('group', event.target.value)}
                      disabled={busy}
                    />
                    <datalist id="catalog-code-groups">
                      {groups.map((group) => (
                        <option key={group} value={group} />
                      ))}
                    </datalist>
                  </label>
                  <label className="catalog-form-field">
                    {t('그룹 이름')}
                    <input
                      maxLength={200}
                      value={draft.groupName}
                      onChange={(event) => change('groupName', event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label className="catalog-form-field">
                    {t('코드')}
                    <input
                      required
                      maxLength={100}
                      value={draft.code}
                      onChange={(event) => change('code', event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label className="catalog-form-field">
                    {t('상위 코드')}
                    <input
                      maxLength={100}
                      value={draft.parentCode}
                      onChange={(event) => change('parentCode', event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label className="catalog-form-field">
                    {t('숫자 값')}
                    <input
                      type="number"
                      step={1}
                      value={draft.numericValue}
                      placeholder={t('미지정')}
                      onChange={(event) => change('numericValue', event.target.value)}
                      disabled={busy}
                    />
                  </label>
                </>
              )}
              <label className="catalog-active-field">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(event) => change('active', event.target.checked)}
                  disabled={busy}
                />
                <span>{t('사용 중')}</span>
              </label>
            </div>
            {(localError || error) && (
              <p className="catalog-message is-error" role="alert">
                {t(localError) || t(error)}
              </p>
            )}
            <footer className="catalog-dialog-footer">
              <button type="button" className="button" disabled={busy} onClick={onClose}>
                {t('취소')}
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? t('저장 중…') : t('저장')}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
