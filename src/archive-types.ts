export const archiveAreas = [
  'companies',
  'activities',
  'tasks',
  'contacts',
  'sales',
  'quotations',
  'installations',
] as const;
export type ArchiveArea = (typeof archiveAreas)[number];
export interface ArchivedEntry {
  area: ArchiveArea;
  id: string;
  title: string;
  archivedAt: string;
  archivedBy: string;
}
export const archiveAreaLabels: Record<ArchiveArea, string> = {
  companies: '고객사',
  activities: '활동',
  tasks: '할일',
  contacts: '담당자',
  sales: '영업',
  quotations: '견적',
  installations: '설치',
};
