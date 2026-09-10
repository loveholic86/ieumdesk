export type CompanyStatus = 'active' | 'prospect' | 'paused' | 'unclassified';
export interface ArchiveMetadata {
  archivedAt?: string;
  archivedBy?: string;
}
export interface Company extends ArchiveMetadata {
  id: string;
  name: string;
  businessNumber: string;
  industry: string;
  ceo: string;
  contactName: string;
  contactRole: string;
  email: string;
  phone: string;
  owner: string;
  status: CompanyStatus;
  products: string[];
  employees: number;
  contractStart: string;
  contractEnd: string;
  contractAmount: number;
  website: string;
  address: string;
  zipcode?: string;
  note: string;
  updatedAt: string;
  companyCode?: string;
  corporationNumber?: string;
  companyType?: string;
  groupName?: string;
  firstContactDate?: string;
  contactSource?: string;
  contactDetail?: string;
  serviceVersion?: '' | 'SAP' | 'On Premises' | 'Cloud';
}
export interface Activity extends ArchiveMetadata {
  id: string;
  companyId: string | null;
  type: 'call' | 'email' | 'meeting' | 'note' | 'invoice' | 'quotation' | 'contract';
  activityDate?: string;
  title: string;
  body: string;
  createdAt: string;
  author: string;
}
export interface Task extends ArchiveMetadata {
  id: string;
  title: string;
  companyId: string;
  dueDate: string;
  startDate?: string;
  contactId?: string;
  contactName?: string;
  completed: boolean;
  priority: 'high' | 'normal';
  status?: 'received' | 'in_progress' | 'done' | 'unclassified';
  type?: '개발요청' | '채권관리' | '영업관리' | '미분류';
  owner?: string;
  body?: string;
}
export interface CompanyList {
  items: Company[];
  total: number;
  page: number;
  pageSize: number;
  stats: { total: number; active: number; prospect: number; renewalDue: number };
  mode: 'demo' | 'postgres';
}
export type Health = { mode: 'demo' | 'postgres'; status?: string; database?: string };

export type RecordKind = 'contacts' | 'sales' | 'quotations' | 'installations';
export type ServiceVersion = 'SAP' | 'On Premises' | 'Cloud';
export interface RecordBase extends ArchiveMetadata {
  id: string;
  companyId: string | null;
  relatedCompanyIds?: string[];
  title?: string;
  updatedAt: string;
}
export interface ContactComment {
  id: string;
  body: string;
  createdAt: string;
  author: string;
}
export interface ContactRecord extends RecordBase {
  name: string;
  department: string;
  role: string;
  type: '인사' | '전산' | '재무' | '기타' | '미분류';
  phone: string;
  mobile: string;
  email: string;
  fax?: string;
  workplace?: string;
  zipcode?: string;
  commentHistory?: ContactComment[];
  note: string;
}
export interface SaleRecord extends RecordBase {
  name: string;
  customerType: '신규' | '고객' | '회귀' | '재영업' | '재계약';
  stage: '타겟고객' | '통신접촉' | '대면접촉' | '협상' | '성공' | '실패';
  serviceVersion: ServiceVersion;
  employees: number;
  expectedRevenue: number;
  failedReason?: string;
  retryProbability?: string;
  stageWeight?: number;
  owner: string;
  note: string;
}
export interface QuotationItem {
  name: string;
  unitPrice: number;
  quantity: number;
  months: number;
  discountPercent: number;
  discountType?: 'percent' | 'amount';
  discountAmount?: number;
  catalogueItemId?: string;
}
export interface QuotationRecord extends RecordBase {
  revisionOf?: string;
  revisionNumber?: number;
  number: string;
  contactName: string;
  issueDate: string;
  status: '발행' | '승인' | '반려';
  quotationType: '신규계약' | '재계약' | '미분류';
  items: QuotationItem[];
  note: string;
  subtotal: number;
  discount: number;
  supplyAmount: number;
  vat: number;
  total: number;
}
export interface InstallationRecord extends RecordBase {
  systemCode: string;
  serviceVersion: ServiceVersion;
  version: string;
  installedAt: string;
  patchedAt: string;
  engineer: string;
  accessType: '알 수 없음' | '바로 접근' | '원격' | '불가' | 'VPN/VDI';
  autoUpdate: boolean;
  domain: string;
  note: string;
}
export type CRMRecord = ContactRecord | SaleRecord | QuotationRecord | InstallationRecord;
export interface CRMRecordMap {
  contacts: ContactRecord;
  sales: SaleRecord;
  quotations: QuotationRecord;
  installations: InstallationRecord;
}
