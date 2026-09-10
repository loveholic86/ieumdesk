import type { QuotationItem } from './types';
export type QuotationAmounts = {
  subtotal: number;
  discount: number;
  supplyAmount: number;
  vat: number;
  total: number;
};
export class QuotationCalculationError extends Error {}
const fail = (message: string): never => {
  throw new QuotationCalculationError(message);
};
const safe = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
export function quotationTotals(items: QuotationItem[]): QuotationAmounts {
  let subtotal = 0n,
    discount = 0n;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  for (const item of items) {
    if (!safe(item.unitPrice) || !safe(item.quantity, 1) || !safe(item.months, 1))
      fail('단가, 수량, 기간을 올바르게 입력해 주세요.');
    const base = BigInt(item.unitPrice) * BigInt(item.quantity) * BigInt(item.months);
    let discounted: bigint;
    if (item.discountType === 'amount') {
      if (!safe(item.discountAmount ?? 0)) fail('고정 할인 금액은 0 이상의 정수로 입력해 주세요.');
      discounted = BigInt(item.discountAmount ?? 0);
    } else {
      if (
        !Number.isFinite(item.discountPercent) ||
        item.discountPercent < 0 ||
        item.discountPercent > 100 ||
        Number(item.discountPercent.toFixed(2)) !== item.discountPercent
      )
        fail('할인율은 0~100 사이 소수 둘째자리까지 입력해 주세요.');
      discounted = (base * BigInt(Math.round(item.discountPercent * 100)) + 5_000n) / 10_000n;
    }
    if (discounted > base) fail('고정 할인 금액은 품목 합계를 넘을 수 없습니다.');
    subtotal += base;
    discount += discounted;
    if (base > max || subtotal > max) fail('견적 금액이 처리 가능한 범위를 넘었습니다.');
  }
  const supply = subtotal - discount,
    vat = (supply + 5n) / 10n,
    total = supply + vat;
  if (total > max) fail('부가세를 포함한 견적 금액이 처리 가능한 범위를 넘었습니다.');
  return {
    subtotal: Number(subtotal),
    discount: Number(discount),
    supplyAmount: Number(supply),
    vat: Number(vat),
    total: Number(total),
  };
}
/** Preserve list prices and distribute a target-total discount from the last item backwards. */
export function quotationForTarget(items: QuotationItem[], target: number): QuotationItem[] {
  if (!safe(target)) fail('목표 청구액은 0 이상의 정수로 입력해 주세요.');
  const undiscounted = items.map((item) => ({ ...item, discountType: 'amount' as const, discountAmount: 0 }));
  const maximum = quotationTotals(undiscounted);
  if (target > maximum.total) fail('목표 청구액은 할인 전 총 견적 금액을 넘을 수 없습니다.');
  let low = 0n,
    high = BigInt(maximum.subtotal),
    expected = BigInt(target);
  while (low < high) {
    const mid = (low + high) / 2n;
    if (mid + (mid + 5n) / 10n < expected) low = mid + 1n;
    else high = mid;
  }
  if (low + (low + 5n) / 10n !== expected)
    fail('이 목표액은 부가세 원 단위 반올림으로 맞출 수 없습니다. 1원 앞뒤 금액을 입력해 주세요.');
  let remaining = BigInt(maximum.subtotal) - low;
  for (let index = undiscounted.length - 1; index >= 0; index--) {
    const item = undiscounted[index],
      base = BigInt(item.unitPrice) * BigInt(item.quantity) * BigInt(item.months);
    const take = remaining > base ? base : remaining;
    item.discountAmount = Number(take);
    remaining -= take;
  }
  return undiscounted;
}
