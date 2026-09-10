export interface BackupCounts {
  tables: number;
  rows: number;
  files: number;
  fileBytes: number;
}
export interface BackupItem {
  id: string;
  createdAt: string;
  reason: 'manual' | 'scheduled' | 'pre-restore';
  bytes: number;
  counts: BackupCounts;
  verifiedAt: string | null;
}
export interface BackupSchedule {
  revision: number;
  enabled: boolean;
  intervalHours: number;
  nextRunAt: string | null;
}
export interface BackupHistory {
  id: string;
  action: string;
  outcome: 'success' | 'failed';
  backupId: string | null;
  createdAt: string;
  code: string | null;
}
export interface BackupPreview {
  id: string;
  canRestore: boolean;
  blockedCodes: string[];
  currentFingerprint: string;
  counts: BackupCounts;
  currentCounts: BackupCounts;
  requiresStoppedServer: true;
  revokesSessions: true;
}
export interface BackupOverview {
  items: BackupItem[];
  issues: { id: string; code: string }[];
  schedule: BackupSchedule;
  capabilities: {
    supported: boolean;
    format: 'encrypted-structured-v1';
    automaticRequiresRunningServer: true;
    restore: 'cli-only';
    keyIncluded: false;
  };
}
