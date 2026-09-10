import { z } from 'zod';
import type { RecordKind } from '../src/types.ts';
const text = (length = 150) => z.string().trim().max(length);
const date = z.union([z.literal(''), z.iso.date()]);
const email = z.union([z.literal(''), z.email().max(254)]);
const website = text(500).refine((value) => {
  if (!value) return true;
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, 'http 또는 https 주소를 입력해 주세요.');
export const companySchema = z
  .object({
    name: text(150).min(1),
    businessNumber: text(30).default(''),
    industry: text().default(''),
    ceo: text().default(''),
    contactName: text().default(''),
    contactRole: text().default(''),
    email: email.default(''),
    phone: text(40).default(''),
    owner: text().default(''),
    status: z.enum(['active', 'prospect', 'paused', 'unclassified']).default('prospect'),
    products: z
      .array(text(50).min(1))
      .max(20)
      .transform((values) => [...new Set(values)])
      .default([]),
    employees: z.number().int().min(0).max(100_000_000).default(0),
    contractStart: date.default(''),
    contractEnd: date.default(''),
    contractAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    website: website.default(''),
    address: text(500).default(''),
    zipcode: text(20).default(''),
    note: text(10_000).default(''),
    companyCode: text(50).default(''),
    corporationNumber: text(50).default(''),
    companyType: text().default(''),
    groupName: text().default(''),
    firstContactDate: date.default(''),
    contactSource: text().default(''),
    contactDetail: text(500).default(''),
    serviceVersion: z.enum(['', 'SAP', 'On Premises', 'Cloud']).default(''),
  })
  .strict();
// Zod defaults also run inside .partial(); remove them so PATCH never resets omitted fields.
export const companyPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(companySchema.shape).map(([key, field]) => [
        key,
        (field instanceof z.ZodDefault ? field.removeDefault() : field).optional(),
      ]),
    ),
  )
  .strict() as z.ZodType<Partial<z.infer<typeof companySchema>>>;
export const activitySchema = z
  .object({
    type: z.enum(['call', 'email', 'meeting', 'note', 'invoice', 'quotation', 'contract']).default('note'),
    activityDate: date.optional(),
    title: text(200).min(1),
    body: text(10_000).default(''),
    author: text().min(1).default('내 계정'),
  })
  .strict();
export const activityPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(activitySchema.omit({ author: true }).shape).map(([key, field]) => [
        key,
        (field instanceof z.ZodDefault ? field.removeDefault() : field).optional(),
      ]),
    ),
  )
  .strict() as z.ZodType<Partial<Omit<z.infer<typeof activitySchema>, 'author'>>>;
export type ActivityPatch = z.infer<typeof activityPatchSchema>;
export const taskSchema = z
  .object({
    title: text(200).min(1),
    companyId: text(100).default(''),
    dueDate: date.default(''),
    startDate: date.default(''),
    contactId: text(100).default(''),
    contactName: text(150).default(''),
    completed: z.boolean().optional(),
    priority: z.enum(['high', 'normal']).default('normal'),
    status: z.enum(['received', 'in_progress', 'done', 'unclassified']).optional(),
    type: z.enum(['개발요청', '채권관리', '영업관리', '미분류']).default('개발요청'),
    owner: text().default(''),
    body: text(10_000).default(''),
  })
  .strict();
export const taskPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(taskSchema.shape).map(([key, field]) => [
        key,
        (field instanceof z.ZodDefault ? field.removeDefault() : field).optional(),
      ]),
    ),
  )
  .strict() as z.ZodType<Partial<z.infer<typeof taskSchema>>>;
export const querySchema = z.object({
  q: text(200).default(''),
  status: z.enum(['active', 'prospect', 'paused', 'unclassified', 'all', '']).default(''),
  product: text(50).default(''),
  owner: text().default(''),
  serviceVersion: z.enum(['', 'all', 'SAP', 'On Premises', 'Cloud']).default(''),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  sort: z.enum(['name', 'updatedAt', 'contractEnd']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQuery = z.infer<typeof querySchema>;
export type CompanyInput = z.infer<typeof companySchema>;
export type ActivityInput = z.infer<typeof activitySchema>;
export type TaskInput = z.infer<typeof taskSchema>;

const recordBase = { companyId: text(100).min(1), title: text(200).default('') };
const serviceVersion = z.enum(['SAP', 'On Premises', 'Cloud']);
export const quotationItemSchema = z
  .object({
    name: text(200).min(1),
    unitPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    quantity: z.number().int().min(1).max(100_000),
    months: z.number().int().min(1).max(1_200),
    catalogueItemId: text(100).optional(),
    discountType: z.enum(['percent', 'amount']).optional(),
    discountAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    discountPercent: z
      .number()
      .min(0)
      .max(100)
      .refine((value) => Number(value.toFixed(2)) === value, '할인율은 소수 둘째자리까지 입력해 주세요.'),
  })
  .strict();
export const recordSchemas = {
  contacts: z
    .object({
      ...recordBase,
      name: text().min(1),
      department: text().default(''),
      role: text().default(''),
      type: z.enum(['인사', '전산', '재무', '기타', '미분류']).default('기타'),
      phone: text(40).default(''),
      mobile: text(40).default(''),
      fax: text(40).default(''),
      workplace: text(500).default(''),
      zipcode: text(20).default(''),
      comment: text(10_000).optional(),
      email: email.default(''),
      note: text(10_000).default(''),
    })
    .strict(),
  sales: z
    .object({
      ...recordBase,
      name: text(200).min(1),
      customerType: z.enum(['신규', '고객', '회귀', '재영업', '재계약']).default('신규'),
      stage: z.enum(['타겟고객', '통신접촉', '대면접촉', '협상', '성공', '실패']).default('타겟고객'),
      serviceVersion: serviceVersion.default('Cloud'),
      employees: z.number().int().min(0).max(100_000_000).default(0),
      expectedRevenue: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      failedReason: text(10_000).default(''),
      retryProbability: z.enum(['', '상', '중', '하', '불가']).default(''),
      stageWeight: z
        .number()
        .min(0)
        .max(100)
        .refine((value) => Number(value.toFixed(2)) === value, '가중치는 소수 둘째자리까지 입력해 주세요.')
        .optional(),
      relatedCompanyIds: z
        .array(text(100).min(1))
        .max(500)
        .transform((ids) => [...new Set(ids)])
        .optional(),
      owner: text().default(''),
      note: text(10_000).default(''),
    })
    .strict(),
  quotations: z
    .object({
      ...recordBase,
      number: text(80).min(1),
      contactName: text().default(''),
      issueDate: date.default(''),
      status: z.enum(['발행', '승인', '반려']).default('발행'),
      quotationType: z.enum(['신규계약', '재계약', '미분류']).default('신규계약'),
      items: z.array(quotationItemSchema).min(1).max(100),
      note: text(10_000).default(''),
    })
    .strict(),
  installations: z
    .object({
      ...recordBase,
      systemCode: text(80).min(1),
      serviceVersion: serviceVersion.default('Cloud'),
      version: text(80).default(''),
      installedAt: date.default(''),
      patchedAt: date.default(''),
      engineer: text().default(''),
      accessType: z.enum(['알 수 없음', '바로 접근', '원격', '불가', 'VPN/VDI']).default('알 수 없음'),
      autoUpdate: z.boolean().default(false),
      domain: text(253)
        .refine(
          (value) =>
            !value || /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i.test(value),
          '도메인 이름만 입력해 주세요. 주소, 계정 또는 비밀번호는 저장하지 않습니다.',
        )
        .default(''),
      note: text(10_000).default(''),
    })
    .strict(),
} as const;
export type RecordInput = z.infer<(typeof recordSchemas)[RecordKind]>;
export function parseRecord(kind: RecordKind, input: unknown): RecordInput {
  return recordSchemas[kind].parse(input);
}
export function parseRecordPatch(kind: RecordKind, input: unknown): Partial<RecordInput> {
  const fields = Object.fromEntries(
    Object.entries(recordSchemas[kind].shape).map(([key, field]) => [
      key,
      (field instanceof z.ZodDefault ? field.removeDefault() : field).optional(),
    ]),
  );
  return z.object(fields).strict().parse(input) as Partial<RecordInput>;
}
