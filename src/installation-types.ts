export type InstallationSectionId =
  'installation' | 'access' | 'server' | 'yeta' | 'sap' | 'settings' | 'files';

export interface InstallationDetailField {
  /** Opaque stable identifier; use only for matching a temporary reveal response. */
  id: string;
  key: string;
  label: string;
  value: string;
  /** Safe canonical code value for a shared installation choice, when applicable. */
  optionValue?: string;
  secret: boolean;
  masked: boolean;
  present: boolean;
}

/** Address, VPN, and access rows that came from one migrated source. */
export type InstallationAccessOriginPart = 'address' | 'vpn' | 'access';

/** One installation-wide slot for the access remark only. VPN belongs to its server. */
export const accessCommonRowId = 'access-common';
export const accessVpnKeys = ['vpnsv_ip', 'vpnsv_id', 'vpnsv_pwd'] as const;
export const accessEtcKey = 'access_etc';
export const accessCommonFieldKeys = new Set<string>([accessEtcKey]);

const remarkKey = /^(?:note|etc)$|_etc$|_note$/;
const remarkLabel = /비고|참고사항/;

/**
 * Free-text remarks (비고/참고사항) are read-only. Their stored value is never rewritten, so they
 * stay visible in the detail view but are no longer offered as inputs. The installation-wide access
 * remark is the exception: it keeps its own panel and only its label changed.
 */
export function installationRemarkField(field: { key: string; label?: string }) {
  if (field.key === accessEtcKey) return false;
  return remarkKey.test(field.key) || remarkLabel.test(field.label ?? '');
}

/** List columns of the access table, in order. Only the access remark is installation-wide. */
export const accessListColumns = [
  { key: 'server', label: '서버' },
  { key: 'access_type', label: '접근 유형' },
  { key: 'domainurl', label: '도메인 URL' },
  { key: 'external_ip', label: '외부 IP' },
  { key: 'ssh_port', label: '외부 PORT' },
] as const;

const accessAddressKeys = new Set([
  'domainurl',
  'ssh_port',
  'external_ip',
  'internal_ip',
  'netmask',
  'gateway',
  'dns1',
  'dns2',
  'ssl_apply_yn',
  'ssl_manage_type',
  'ssl_applydate',
  'ssl_pwd',
]);

/** Short label of one child row inside a server unit. */
export const accessPartLabels: Record<InstallationAccessOriginPart, string> = {
  address: '접속 주소',
  vpn: 'VPN',
  access: '접근 정보',
};

/** Part a saved row holds: its migrated origin, or what its own fields are limited to. */
export function accessRowPart(row: {
  origin?: InstallationAccessOrigin;
  fields: readonly { key: string }[];
}): InstallationAccessOriginPart {
  if (row.origin) return row.origin.part;
  const keys = row.fields.map((field) => field.key);
  if (keys.length && keys.every((key) => (accessVpnKeys as readonly string[]).includes(key))) return 'vpn';
  return keys.length && keys.every((key) => accessAddressKeys.has(key)) ? 'address' : 'access';
}

/** The parts of a row that decide which server unit it belongs to. */
export type AccessServerUnitRow = {
  id: string;
  title?: string;
  serverId?: string;
  origin?: InstallationAccessOrigin;
  fields: readonly { key: string }[];
};

const legacyPartTitles: Record<string, InstallationAccessOriginPart> = {
  '이관 원본 address': 'address',
  '이관 원본 vpn': 'vpn',
  '이관 원본 접근 정보': 'access',
  '접속 주소': 'address',
  address: 'address',
  vpn: 'vpn',
  '접근 정보': 'access',
  '기존 접근 정보': 'access',
};

/** Part named by a migrated part row's own title. Custom titles never match. */
export function legacyAccessPart(row: { title?: string }): InstallationAccessOriginPart | undefined {
  return legacyPartTitles[(row.title ?? '').trim().toLowerCase()];
}

/**
 * One server unit per parent link. New saves and migrated groups carry the link; origin-less
 * legacy rows fall back to a contiguous address/vpn/access run from one migrated source.
 * A run needs all three parts, so a lone row or a bare address/access pair is never merged.
 * Custom-titled rows never join a run, and a repeated part starts the next server.
 */
export function accessServerUnits<T extends AccessServerUnitRow>(
  rows: readonly T[],
): { id: string; rows: T[]; index: number }[] {
  const units: { id: string; rows: T[] }[] = [];
  const linked = new Map<string, { id: string; rows: T[] }>();
  let run: T[] = [];
  let parts = new Set<string>();
  const flush = () => {
    if (!run.length) return;
    if (parts.has('address') && parts.has('vpn') && parts.has('access'))
      units.push({ id: `row:${run[0].id}`, rows: run });
    else for (const row of run) units.push({ id: `row:${row.id}`, rows: [row] });
    run = [];
    parts = new Set();
  };
  for (const row of rows) {
    if (row.id === accessCommonRowId) continue;
    if (!row.fields.some((field) => !accessCommonFieldKeys.has(field.key))) continue;
    const link = row.serverId ?? row.origin?.group;
    if (link) {
      flush();
      const existing = linked.get(link);
      if (existing) existing.rows.push(row);
      else {
        const unit = { id: link, rows: [row] };
        linked.set(link, unit);
        units.push(unit);
      }
      continue;
    }
    const part = legacyAccessPart(row);
    if (!part) {
      flush();
      units.push({ id: `row:${row.id}`, rows: [row] });
      continue;
    }
    if (parts.has(part)) flush();
    run.push(row);
    parts.add(part);
  }
  flush();
  return units.map((unit, index) => ({ ...unit, index: index + 1 }));
}

export interface InstallationAccessOrigin {
  /** Opaque id shared by those rows. Not a stored source key. */
  group: string;
  part: InstallationAccessOriginPart;
}

/** One server unit: the parent id shared by its address, VPN, and access rows. */
export interface InstallationDetailRow {
  id: string;
  title?: string;
  /**
   * Server display name set by the user. Stored separately from `title`, so renaming a server
   * never disturbs the part titles that group a migrated server unit.
   */
  displayName?: string;
  managed?: 'metadata';
  /** Server parent link stored in the encrypted document, so it survives a missing 017 column. */
  serverId?: string;
  /** Read-only migrated link kept for older rows. The sidecar column does not always exist. */
  origin?: InstallationAccessOrigin;
  fields: InstallationDetailField[];
}

export interface InstallationDetailSection {
  id: InstallationSectionId;
  title: string;
  imported: boolean;
  note?: string;
  rows: InstallationDetailRow[];
}

export interface InstallationAccessNote {
  id: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
  masked: boolean;
}

export interface InstallationDetails {
  id: string;
  imported: boolean;
  /** Changes only when the encrypted installation workspace changes. */
  revision: number;
  metadataRevision?: string;
  sections: InstallationDetailSection[];
  /** Older responses may omit this list; current responses always include it. */
  accessNotes?: InstallationAccessNote[];
}

export interface InstallationAccessNoteInput {
  revision: number;
  content: string;
}

export interface InstallationWorkspaceFieldInput {
  key: string;
  label: string;
  value: string;
}
export interface InstallationRowCreate {
  revision: number;
  sectionId: InstallationSectionId;
  title: string;
  fields: InstallationWorkspaceFieldInput[];
}
export interface InstallationRowPatch {
  revision: number;
  metadataRevision?: string;
  title?: string;
  values?: Record<string, string>;
  removeFields?: string[];
  addFields?: InstallationWorkspaceFieldInput[];
}
export interface InstallationAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}
export interface InstallationAttachmentList {
  items: InstallationAttachment[];
  maxBytes: number;
  allowedExtensions: string[];
  downloadsEnabled: boolean;
}

export interface InstallationSecretReveal {
  id: string;
  expiresAt: string;
  values: Record<string, string>;
}
