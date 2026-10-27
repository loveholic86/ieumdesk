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

/** One installation-wide slot. New saves put VPN and access remarks here, not on a server row. */
export const accessCommonRowId = 'access-common';
export const accessVpnKeys = ['vpnsv_ip', 'vpnsv_id', 'vpnsv_pwd'] as const;
export const accessEtcKey = 'access_etc';
export const accessCommonFieldKeys = new Set<string>([...accessVpnKeys, accessEtcKey]);

export interface InstallationAccessOrigin {
  /** Opaque id shared by those rows. Not a stored source key. */
  group: string;
  part: InstallationAccessOriginPart;
}

export interface InstallationDetailRow {
  id: string;
  title?: string;
  managed?: 'metadata';
  /** Read-only. Present only on migrated access rows. */
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
