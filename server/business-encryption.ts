import { ApiError } from './errors.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';

export const businessPrivateColumns = {
  companies: {
    name: '[암호화]',
    business_number: '',
    industry: '',
    ceo: '',
    contact_name: '',
    contact_role: '',
    email: '',
    phone: '',
    owner: '',
    products: [],
    employees: 0,
    contract_start: null,
    contract_end: null,
    contract_amount: 0,
    website: '',
    address: '',
    zipcode: null,
    note: '',
    company_code: '',
    corporation_number: '',
    company_type: '',
    group_name: '',
    first_contact_date: null,
    contact_source: '',
    contact_detail: '',
  },
  activities: { title: '[암호화]', body: '', author: '', activity_date: null },
  tasks: { title: '[암호화]', owner: '', body: '', start_date: null, due_date: null, contact_name: null },
} as const;
export type ScalarBusinessTable = keyof typeof businessPrivateColumns;
export type BusinessTable = ScalarBusinessTable | 'records' | 'catalog';
type Row = Record<string, unknown>;
export const storageUnavailable = () =>
  new ApiError(
    503,
    'STORAGE_ENCRYPTION_UNAVAILABLE',
    '암호화 저장소를 확인하지 못했습니다. 관리자에게 문의해 주세요.',
  );
const context = (table: BusinessTable, row: Row) => {
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    ((table === 'records' || table === 'catalog') && typeof row.kind !== 'string')
  )
    throw storageUnavailable();
  return {
    source: 'yeta-crm-business',
    table,
    primaryKey: JSON.stringify([row.kind ?? '', row.id]),
    batchId: 'storage-v1',
  };
};
const object = (value: unknown): value is Row =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Cleartext routing columns contain only relationships or keyed equality indexes. */
export function routingData(vault: LegacyVault, table: 'records' | 'catalog', row: Row, data: Row): Row {
  if (table === 'records') {
    if (
      data.relatedCompanyIds !== undefined &&
      (!Array.isArray(data.relatedCompanyIds) ||
        data.relatedCompanyIds.some((value) => typeof value !== 'string'))
    )
      throw storageUnavailable();
    return data.relatedCompanyIds === undefined ? {} : { relatedCompanyIds: data.relatedCompanyIds };
  }
  if (row.kind !== 'codes') return {};
  if (!vault.blindIndex || typeof data.group !== 'string' || typeof data.code !== 'string')
    throw storageUnavailable();
  return { lookup: vault.blindIndex('catalog-code-v1', JSON.stringify([data.group, data.code])) };
}

/** Used by the explicit transactional migration and by all live writes. No plaintext fallback. */
export function encryptBusinessRow(vault: LegacyVault, table: BusinessTable, row: Row): Row {
  try {
    const dateColumns =
      table === 'companies'
        ? ['contract_start', 'contract_end', 'first_contact_date']
        : table === 'activities'
          ? ['activity_date']
          : table === 'tasks'
            ? ['start_date', 'due_date']
            : [];
    for (const key of dateColumns) {
      const value = row[key];
      if (value != null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)))
        throw storageUnavailable();
    }
    const payload =
      table === 'records' || table === 'catalog'
        ? row.data
        : Object.fromEntries(
            Object.keys(businessPrivateColumns[table]).map((key) => [key, row[key] ?? null]),
          );
    if (!object(payload)) throw storageUnavailable();
    const encrypted = vault.encrypt(JSON.stringify(payload), context(table, row));
    if (table === 'records' || table === 'catalog')
      return { ...row, data: routingData(vault, table, row, payload), protected_data: encrypted };
    return { ...row, ...businessPrivateColumns[table], protected_data: encrypted };
  } catch {
    throw storageUnavailable();
  }
}

export function decryptBusinessRow(vault: LegacyVault, table: BusinessTable, row: Row): Row {
  try {
    if (!object(row.protected_data)) throw storageUnavailable();
    const payload = JSON.parse(
      vault.decrypt(row.protected_data as unknown as LegacyVaultEnvelope, context(table, row)),
    );
    if (!object(payload)) throw storageUnavailable();
    const { protected_data: _envelope, ...rest } = row;
    if (table === 'records' || table === 'catalog') {
      // Do not trust a modified cleartext relationship/index projection.
      if (JSON.stringify(row.data) !== JSON.stringify(routingData(vault, table, row, payload)))
        throw storageUnavailable();
      return { ...rest, data: payload };
    }
    if (
      Object.keys(payload).length !== Object.keys(businessPrivateColumns[table]).length ||
      Object.keys(businessPrivateColumns[table]).some((key) => !Object.hasOwn(payload, key))
    )
      throw storageUnavailable();
    return { ...rest, ...payload };
  } catch {
    throw storageUnavailable();
  }
}

export class BusinessEncryption {
  constructor(
    private getVault: () => Promise<LegacyVault> = () => openLegacyVault({ createIfMissing: false }),
  ) {}
  async encrypt(table: BusinessTable, row: Row) {
    return encryptBusinessRow(await this.getVault(), table, row);
  }
  async decrypt(table: BusinessTable, row: Row) {
    return decryptBusinessRow(await this.getVault(), table, row);
  }
  async ready() {
    await this.getVault();
  }
}
