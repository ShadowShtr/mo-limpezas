// Fonte única do valor de um serviço (Causa 11 da auditoria de reversões).
//
// A fórmula estava copiada em pelo menos 4 sítios (reschedule.ts, o painel de
// detalhe do serviço, a reescrita de ocorrências futuras do contrato e o cron
// de geração mensal) — uma correção numa cópia não chegava às outras, o que
// fazia o mesmo serviço calcular valores diferentes conforme o caminho por
// onde passou. Qualquer fluxo que precise do valor de um serviço usa este
// helper.
export interface ServiceValueInput {
  durationMin: number;
  hourlyRate: number | null;
  numPeople: number | null;
  manualValue: number | null;
  fixedMonthly: boolean;             // contrato de avença mensal
  contractFixedPrice: number | null; // valor fixo POR SERVIÇO do contrato
  upholsteryUnits: number | null;
  upholsteryUnitPrice: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Prioridades:
 *  1. manual_value (a gestora fixou à mão — nunca recalcular por cima)
 *  2. estofos: units × unit_price
 *  3. avença mensal: o SERVIÇO vale 0 (a fatura cobra o contrato, 1 linha/mês;
 *     o daily-billing divide o valor pelo nº de serviços do mês — é design)
 *  4. valor fixo por serviço: contractFixedPrice
 *  5. por hora: duração × hourlyRate × numPeople
 */
export function calculateServiceValue(i: ServiceValueInput): number | null {
  if (i.manualValue != null) return i.manualValue;
  if (i.upholsteryUnits != null && i.upholsteryUnitPrice != null) {
    return round2(i.upholsteryUnits * i.upholsteryUnitPrice);
  }
  if (i.fixedMonthly) return 0;
  if (i.contractFixedPrice != null && i.contractFixedPrice > 0) return i.contractFixedPrice;
  if (i.hourlyRate != null && i.durationMin > 0) {
    const ppl = i.numPeople != null && i.numPeople >= 1 ? i.numPeople : 1;
    return round2((i.durationMin / 60) * i.hourlyRate * ppl);
  }
  return null;
}

/**
 * Aplica IVA a um valor base (fonte única — ver Causa "IVA divergente entre
 * painel do serviço e ficha do cliente", 2026-07-22). O mesmo serviço chegou
 * a mostrar valores diferentes em sítios diferentes porque cada um fazia a
 * sua própria conta `valor * (1 + taxa/100)` — bastava um deles esquecer o
 * apply_vat, ou usar uma taxa desatualizada, para divergir. Qualquer local
 * que mostre o valor de um serviço com IVA usa este helper.
 */
export function withVat(baseValue: number, applyVat: boolean, vatRatePct: number): number {
  return applyVat ? Math.round(baseValue * (1 + vatRatePct / 100) * 100) / 100 : baseValue;
}
