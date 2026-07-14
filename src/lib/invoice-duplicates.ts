export interface MonthlyContractRow {
  id: string;
  location_id: string;
}

export interface DuplicateMonthlyContractGroup {
  location_id: string;
  contract_ids: string[];
}

/**
 * Agrupa contratos de avença mensal já filtrados como "ativos no período de
 * faturação" (ver generateInvoices em src/app/actions/invoices.ts) por local.
 * Mais de um contrato ativo para o mesmo local no mesmo período geraria duas
 * linhas idênticas na mesma fatura (o bug do "Parque Norte" duplicado) — este
 * helper deteta esses grupos para a geração ser bloqueada em vez de escolher
 * um contrato e ignorar o outro silenciosamente.
 */
export function findDuplicateMonthlyContractsByLocation(
  contracts: MonthlyContractRow[],
): DuplicateMonthlyContractGroup[] {
  const byLocation = new Map<string, string[]>();
  for (const c of contracts) {
    if (!byLocation.has(c.location_id)) byLocation.set(c.location_id, []);
    byLocation.get(c.location_id)!.push(c.id);
  }
  return [...byLocation.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([location_id, contract_ids]) => ({ location_id, contract_ids }));
}
