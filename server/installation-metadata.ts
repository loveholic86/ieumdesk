import { ApiError } from './errors.ts';
import { createHash } from 'node:crypto';
import { parseRecordPatch, type RecordInput } from './validation.ts';

/** Fields owned by the ordinary installation record, including the primary detail row. */
export const installationMetadataKeys = [
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
] as const;

export type InstallationMetadataKey = (typeof installationMetadataKeys)[number];

/** Only semantically equivalent source fields may update the primary record. */
export const installationMetadataAliases = {
  sv_version: 'serviceVersion',
  setup_date: 'installedAt',
  last_setup_date: 'patchedAt',
  setup_engineer: 'engineer',
  autoupdate_yn: 'autoUpdate',
} as const satisfies Readonly<Record<string, InstallationMetadataKey>>;

const allowedKeys = new Set<string>(installationMetadataKeys);
const defaults: Record<InstallationMetadataKey, string> = {
  systemCode: '',
  serviceVersion: 'Cloud',
  version: '',
  installedAt: '',
  patchedAt: '',
  engineer: '',
  accessType: '알 수 없음',
  autoUpdate: 'false',
  domain: '',
  note: '',
};

const invalid = () =>
  new ApiError(400, 'INSTALLATION_METADATA_INVALID', '설치 기본정보의 입력값을 확인해 주세요.');

function masked(value: string) {
  return /^(?:[•●*]{3,}|보호됨|\[보호됨\])$/u.test(value.trim());
}

function booleanValue(value: string) {
  const normalized = value.trim();
  if (['true', 'Y', '예'].includes(normalized)) return true;
  if (['false', 'N', '아니오'].includes(normalized)) return false;
  throw invalid();
}

/** Preserve omitted fields and explicit clears; reuse the record PATCH contract. */
export function installationMetadataPatch(values: Record<string, string>): Partial<RecordInput> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw invalid();
  const patch: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowedKeys.has(key) || typeof value !== 'string' || masked(value)) throw invalid();
    patch[key] = key === 'autoUpdate' ? booleanValue(value) : value;
  }
  return parseRecordPatch('installations', patch);
}

/** Return stored scalar text without labels or masking for the internal primary row. */
export function installationMetadataValues(
  record: Record<string, unknown>,
): Record<InstallationMetadataKey, string> {
  const values = {} as Record<InstallationMetadataKey, string>;
  for (const key of installationMetadataKeys) {
    const value = record[key];
    if (value === undefined || value === null) values[key] = defaults[key];
    else if (typeof value === 'string') values[key] = value;
    else if (key === 'autoUpdate' && typeof value === 'boolean') values[key] = String(value);
    else throw invalid();
  }
  return values;
}

/** Fingerprint only canonical metadata so unrelated record edits do not invalidate the detail form. */
export function installationMetadataRevision(record: object): string {
  return createHash('sha256')
    .update(JSON.stringify(installationMetadataValues(record as Record<string, unknown>)))
    .digest('hex');
}

/** Validate the already typed record PATCH again at the persistence boundary. */
export function installationMetadataRecordPatch(patch: Partial<RecordInput>): Partial<RecordInput> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid();
  return installationMetadataPatch(
    Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [
        key,
        key === 'autoUpdate' && typeof value === 'boolean' ? String(value) : value,
      ]),
    ) as Record<string, string>,
  );
}

export const installationMetadataConflict = () =>
  new ApiError(
    409,
    'INSTALLATION_METADATA_CONFLICT',
    '설치 기본정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.',
  );
