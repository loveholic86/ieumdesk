// Verified on 2026-09-09 against imported code_tb sales_st.num_val (read-only).
export const originalSalesWeights: Record<string, number> = {
  타겟고객: 0,
  통신접촉: 10,
  대면접촉: 20,
  협상: 50,
  성공: 100,
  실패: 0,
};
export function salesWeight(
  sale: { stage?: string; stageWeight?: number | null },
  policy: Record<string, number> = originalSalesWeights,
): number {
  return sale.stageWeight ?? policy[sale.stage || ''] ?? 0;
}
export function weightedRevenue(
  sale: { stage?: string; stageWeight?: number | null; expectedRevenue?: number },
  policy?: Record<string, number>,
): number {
  const amount = sale.expectedRevenue || 0;
  if (!Number.isSafeInteger(amount) || amount < 0) return 0;
  const weight = Math.round(salesWeight(sale, policy) * 100);
  return Number((BigInt(amount) * BigInt(weight) + 5000n) / 10000n);
}

export function configuredSalesWeights(
  codes: { group: string; code: string; name: string; numericValue: number | null; active: boolean }[],
): Record<string, number> {
  const policy = { ...originalSalesWeights };
  const stages: Record<string, string> = {
    SALESST001: '타겟고객',
    SALESST002: '통신접촉',
    SALESST003: '대면접촉',
    SALESST004: '협상',
    SALESST005: '성공',
    SALESST006: '실패',
  };
  for (const code of codes) {
    const stage =
      stages[code.code] || (Object.hasOwn(originalSalesWeights, code.name) ? code.name : undefined);
    if (
      code.group === 'sales_st' &&
      code.active &&
      stage &&
      code.numericValue !== null &&
      Number.isFinite(code.numericValue) &&
      code.numericValue >= 0 &&
      code.numericValue <= 100
    )
      policy[stage] = code.numericValue;
  }
  return policy;
}
