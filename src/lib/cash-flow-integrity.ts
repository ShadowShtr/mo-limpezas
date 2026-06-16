export type CashFlowReferenceType = "invoice" | "payroll";

export function getMissingCashFlowReferenceIds(
  requestedIds: string[],
  existingReferenceIds: Array<string | null>,
): string[] {
  const existing = new Set(existingReferenceIds.filter((id): id is string => Boolean(id)));
  return [...new Set(requestedIds)].filter((id) => !existing.has(id));
}

export function isValidCashFlowAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0;
}
