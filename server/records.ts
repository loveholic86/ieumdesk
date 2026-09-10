import { randomUUID } from 'node:crypto';
import type {
  ContactRecord,
  CRMRecord,
  QuotationItem,
  QuotationRecord,
  RecordKind,
  SaleRecord,
  Task,
} from '../src/types.ts';
import type { RecordInput, TaskInput } from './validation.ts';
import { ApiError } from './errors.ts';
import { quotationTotals } from '../src/quotation-calculation.ts';

export function calculateQuotation(
  items: QuotationItem[],
): Pick<QuotationRecord, 'subtotal' | 'discount' | 'supplyAmount' | 'vat' | 'total'> {
  try {
    return quotationTotals(items);
  } catch (error) {
    throw new ApiError(
      400,
      'QUOTATION_AMOUNT_TOO_LARGE',
      error instanceof Error ? error.message : '견적 금액을 확인해 주세요.',
    );
  }
}

export function assembleRecord(
  kind: RecordKind,
  input: RecordInput | Partial<RecordInput>,
  id: string,
  existing?: CRMRecord,
  actorName?: string,
): CRMRecord {
  const record = { ...existing, ...input, id, updatedAt: new Date().toISOString() } as CRMRecord;
  if (kind === 'contacts') {
    const contact = record as ContactRecord & { comment?: string };
    if (contact.comment?.trim())
      contact.commentHistory = [
        ...(contact.commentHistory || []),
        {
          id: randomUUID(),
          body: contact.comment.trim(),
          createdAt: record.updatedAt,
          author: actorName || 'CRM',
        },
      ];
    delete contact.comment;
  }
  if (kind === 'sales') {
    const sale = record as SaleRecord;
    sale.relatedCompanyIds = [
      ...new Set(
        [sale.companyId, ...(sale.relatedCompanyIds || [])].filter((id): id is string => Boolean(id)),
      ),
    ];
  }
  if (kind === 'quotations') {
    const original = existing as (QuotationRecord & { legacyFinancials?: { locked: boolean } }) | undefined;
    if (original?.legacyFinancials?.locked === true) {
      if (Object.prototype.hasOwnProperty.call(input, 'items'))
        throw new ApiError(
          409,
          'LEGACY_QUOTATION_FINANCIALS_LOCKED',
          '이관된 견적의 품목과 금액은 변경할 수 없습니다. 금액 수정에는 별도 전환이 필요합니다.',
        );
      // Imported amounts reflect the original quotation's tax and rounding rules.
      // Keep the snapshot even when a caller supplies an unrelated metadata patch.
      Object.assign(record, {
        items: original.items,
        subtotal: original.subtotal,
        discount: original.discount,
        supplyAmount: original.supplyAmount,
        vat: original.vat,
        total: original.total,
        legacyFinancials: original.legacyFinancials,
      });
    } else Object.assign(record, calculateQuotation((record as QuotationRecord).items));
  }
  return record;
}

export function taskState(input: Partial<TaskInput>, existing?: Task) {
  if (
    input.status !== undefined &&
    input.completed !== undefined &&
    input.completed !== (input.status === 'done')
  ) {
    throw new ApiError(400, 'TASK_STATUS_CONFLICT', '할일 상태와 완료 여부가 일치하지 않습니다.');
  }
  const status =
    input.status ??
    (input.completed !== undefined
      ? input.completed
        ? 'done'
        : 'received'
      : (existing?.status ?? (existing?.completed ? 'done' : 'received')));
  return {
    status,
    completed: status === 'done',
    type: input.type ?? existing?.type ?? '개발요청',
    owner: input.owner ?? existing?.owner ?? '',
    body: input.body ?? existing?.body ?? '',
  };
}

/** Approval decisions and editing already approved documents require an administrator. */
export function assertQuotationPermission(
  role: string,
  input: Partial<QuotationRecord>,
  existing?: QuotationRecord,
) {
  if (role === 'admin') return;
  if (
    (input.status && input.status !== '발행' && input.status !== existing?.status) ||
    existing?.status === '승인'
  ) {
    throw new ApiError(
      403,
      'QUOTATION_APPROVAL_REQUIRED',
      '견적 승인·반려와 승인된 견적 수정은 관리자만 할 수 있습니다. 새 버전으로 제안을 작성할 수 있습니다.',
    );
  }
}
export function quotationRevision(source: QuotationRecord, record: CRMRecord): QuotationRecord {
  return {
    ...record,
    status: '발행',
    revisionOf: source.id,
    revisionNumber: (source.revisionNumber || 0) + 1,
  } as QuotationRecord;
}
