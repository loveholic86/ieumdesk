export type InstallationSectionId =
  'installation' | 'access' | 'server' | 'yeta' | 'sap' | 'settings' | 'files';

export interface InstallationDetailField {
  /** Opaque stable identifier; use only for matching a temporary reveal response. */
  id: string;
  key: string;
  label: string;
  value: string;
  secret: boolean;
  masked: boolean;
  present: boolean;
}

export interface InstallationDetailRow {
  id: string;
  title?: string;
  managed?: 'metadata';
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
