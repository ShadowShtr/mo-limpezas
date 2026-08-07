// ============================================================================
// T11 — As fórmulas antigas, capturadas tal como estão
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro, só de leitura conceptual. Não toca em dados nem em runtime.
//
// ----------------------------------------------------------------------------
//
// Porquê copiar código que queremos substituir.
//
// Para medir a diferença é preciso ter os dois lados no mesmo sítio. Este
// ficheiro reproduz, linha a linha, a aritmética que cada consumidor faz hoje —
// **sem a alterar e sem a chamar em produção**. Serve dois fins:
//
//   1. o comparador (`scripts/compare-billing-compat.ts`) mede legacy × canónico
//      sobre fixtures sintéticas, tal como o `compare-recurrence-compat.ts` fez
//      para a T07;
//   2. os testes fixam o comportamento antigo, para que a mudança apareça como
//      um número e não como uma surpresa no dia em que os consumidores forem
//      ligados.
//
// Cada função aponta o ficheiro e a linha de onde foi transcrita. Se o original
// mudar, esta cópia fica desactualizada — e é isso mesmo que o teste de paridade
// deve apanhar.
//
// NÃO importar este módulo em código de aplicação. Existe para ser comparado,
// não para ser usado.

/** Réplica de `round2` em `src/lib/service-value.ts`. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface LegacyAvencaInput {
  /** `contracts.fixed_price` em euros. */
  fixedPrice: number | null;
  /** Nº de ocorrências que o consumidor contou. */
  count: number;
  /** `contracts.apply_vat`. */
  applyVat: boolean;
  /** `company_settings.vat_rate` em pontos percentuais. */
  vatRatePct: number;
}

/**
 * `src/app/actions/daily-billing.ts`, `toRow` (~linha 166) e
 * `computeServiceBillingValue` (~linha 258) — duas cópias da mesma conta.
 *
 * Arredonda a QUOTA de cada serviço. É aqui que os cêntimos se perdem:
 * 100,00 € / 3 → 33,33 € por serviço → 99,99 € no total do mês.
 */
export function legacyDailyBillingBase(input: LegacyAvencaInput): number {
  const count = Math.max(1, input.count);
  return round2((input.fixedPrice ?? 0) / count);
}

/**
 * `src/app/actions/financial-dashboard.ts`, `valueOf` (~linha 160).
 *
 * Não arredonda a quota; multiplica logo pelo factor de IVA e só arredonda
 * depois de acumular. Devolve um valor COM IVA, sem nunca materializar o IVA —
 * impossível de reconciliar com a fatura.
 */
export function legacyDashboardValueWithVat(input: LegacyAvencaInput): number {
  const count = Math.max(1, input.count);
  const base = (input.fixedPrice ?? 0) / count;
  return base * (input.applyVat ? 1 + input.vatRatePct / 100 : 1);
}

/**
 * `src/app/actions/reports.ts`, bloco "FATURAÇÃO DIÁRIA" (~linha 313).
 *
 * Separa base e IVA (melhor que o dashboard), mas acumula ambos em vírgula
 * flutuante e arredonda só no fim de cada dia.
 */
export function legacyReportsParts(input: LegacyAvencaInput): { base: number; iva: number } {
  const count = Math.max(1, input.count);
  const base = (input.fixedPrice ?? 0) / count;
  return { base, iva: input.applyVat ? base * (input.vatRatePct / 100) : 0 };
}

/**
 * `src/app/actions/invoices.ts`, bloco "Contratos de avença mensal"
 * (~linha 232). **Não divide**: emite uma linha única com o valor mensal
 * inteiro, e o IVA é calculado sobre a base já somada da fatura.
 *
 * Esta é a razão pela qual somar o "realizado" do mês nunca dá o faturado.
 */
export function legacyInvoiceMonthlyLine(input: LegacyAvencaInput): number {
  return input.fixedPrice ?? 0;
}

/**
 * `withVat` em `src/lib/service-value.ts`.
 * Devolve o total com IVA, arredondado uma vez. Não expõe o imposto.
 */
export function legacyWithVat(baseValue: number, applyVat: boolean, vatRatePct: number): number {
  return applyVat ? round2(baseValue * (1 + vatRatePct / 100)) : baseValue;
}

/**
 * Total do mês tal como a Cobrança Diária o apresenta: soma das quotas já
 * arredondadas. É o número que diverge do valor do contrato.
 */
export function legacyDailyBillingMonthTotal(input: LegacyAvencaInput): number {
  const count = Math.max(1, input.count);
  const per = legacyDailyBillingBase(input);
  return round2(per * count);
}

/**
 * Total do mês tal como os Relatórios o apresentam: acumula sem arredondar e
 * arredonda no fim. Recupera os cêntimos que a Cobrança Diária perde, o que faz
 * com que os dois ecrãs mostrem totais diferentes para o mesmo mês.
 */
export function legacyReportsMonthTotal(input: LegacyAvencaInput): number {
  const count = Math.max(1, input.count);
  const { base } = legacyReportsParts(input);
  return round2(base * count);
}
