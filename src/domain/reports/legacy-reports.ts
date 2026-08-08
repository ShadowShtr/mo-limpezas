// ============================================================================
// T14 — As agregações de relatório antigas, capturadas tal como estão
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro, só para comparação. Não toca em dados nem em runtime.
//
// ----------------------------------------------------------------------------
//
// Porquê copiar código que queremos substituir.
//
// Mesma razão da T11 (`src/domain/billing/legacy-formulas.ts`): para medir a
// diferença é preciso ter os dois lados no mesmo sítio. Este ficheiro reproduz,
// linha a linha, o que `src/app/actions/reports.ts` e
// `src/app/actions/financial-dashboard.ts` fazem hoje — **sem alterar nada e
// sem ser chamado em produção**.
//
// Cada função aponta o ficheiro de onde foi transcrita. Se o original mudar,
// esta cópia fica desactualizada, e é isso que o comparador deve revelar.
//
// NÃO importar em código de aplicação.

import { type CivilPeriod, periodDays } from "./period";
import { type AbsenceInput, type ServiceInput } from "./report-sources";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Absentismo ─────────────────────────────────────────────────────────────

/**
 * `src/app/actions/reports.ts`, bloco ABSENTISMO (~linha 153).
 *
 *     dias = round((ends_on − starts_on) / 86400000) + 1
 *
 * Conta a duração INTEIRA da ausência, mesmo quando só parte dela cai no
 * período do relatório. Uma baixa de 61 dias entra com 61 dias tanto no
 * relatório de agosto como no de setembro.
 *
 * O `new Date("YYYY-MM-DD")` do original interpreta a data como meia-noite UTC;
 * como ambas as pontas sofrem a mesma interpretação, a subtração é estável e o
 * fuso não entra na conta. O defeito aqui é a ausência de interseção, não o
 * fuso — replicado com aritmética civil para o comparador isolar uma coisa de
 * cada vez.
 */
export function legacyAbsenceDays(absence: AbsenceInput): number {
  const start = Date.UTC(
    Number(absence.startsOn.slice(0, 4)),
    Number(absence.startsOn.slice(5, 7)) - 1,
    Number(absence.startsOn.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(absence.endsOn.slice(0, 4)),
    Number(absence.endsOn.slice(5, 7)) - 1,
    Number(absence.endsOn.slice(8, 10)),
  );
  return Math.round((end - start) / 86_400_000) + 1;
}

/** Soma do absentismo tal como o KPI "Dias de falta" a apresenta hoje. */
export function legacyTotalAbsenceDays(absences: readonly AbsenceInput[]): number {
  let total = 0;
  for (const a of absences) total += legacyAbsenceDays(a);
  return total;
}

/**
 * Limite superior legítimo do absentismo de um período: nenhum colaborador pode
 * faltar mais dias do que o período tem. Usado pelo comparador para mostrar
 * quando o número antigo é impossível, e não apenas diferente.
 */
export function absenceUpperBound(window: CivilPeriod, collaborators: number): number {
  return periodDays(window) * Math.max(0, collaborators);
}

// ─── Contagem de serviços ───────────────────────────────────────────────────

export interface LegacyServiceCounts {
  concluido: number;
  cancelado: number;
  falta: number;
  /** Balde do `else` final: agendado + em_curso + sem_cobertura + desconhecido. */
  agendado: number;
  total: number;
}

/**
 * `src/app/actions/reports.ts`, bloco SERVIÇOS POR EQUIPA (~linha 271).
 *
 *     if (concluido) … else if (cancelado) … else if (falta) … else agendado++
 *
 * O `else` final absorve `em_curso`, `sem_cobertura` e qualquer estado que o
 * schema venha a ter. Um serviço sem equipa atribuída é indistinguível de um
 * serviço normalmente agendado.
 */
export function legacyCountServices(services: readonly ServiceInput[]): LegacyServiceCounts {
  const out: LegacyServiceCounts = {
    concluido: 0,
    cancelado: 0,
    falta: 0,
    agendado: 0,
    total: 0,
  };
  for (const s of services) {
    out.total += 1;
    if (s.status === "concluido") out.concluido += 1;
    else if (s.status === "cancelado") out.cancelado += 1;
    else if (s.status === "falta") out.falta += 1;
    else out.agendado += 1;
  }
  return out;
}

// ─── Receita ────────────────────────────────────────────────────────────────

/**
 * `src/app/actions/reports.ts`, bloco RECEITA (~linha 219).
 *
 *     value = manual_value ?? calculated_value ?? 0
 *
 * Sobre serviços com `status = 'concluido'`. Note-se o que isto significa para
 * uma avença: o serviço vale 0 na base (é assim por desenho, ver
 * `calculateServiceValue`), por isso a receita da avença **não aparece de todo**
 * nesta tabela nem no KPI "Receita (s/ IVA)" da página de Relatórios.
 *
 * É a "avença invisível": um contrato de 300 €/mês com serviços concluídos
 * contribui com 0 € para a receita do relatório, enquanto a Faturação Diária —
 * no MESMO ecrã, no separador ao lado — mostra os 300 € divididos pelos dias.
 * Dois números na mesma página, ambos rotulados como receita.
 */
export function legacyRevenueFromServices(services: readonly ServiceInput[]): number {
  let total = 0;
  for (const s of services) {
    if (s.status !== "concluido") continue;
    total += s.valueCents == null ? 0 : s.valueCents / 100;
  }
  return round2(total);
}

/**
 * `reports-tabs.tsx`, exportação CSV da Receita (~linha 330).
 *
 *     IVA   = total_receita * vatFactor
 *     Total = total_receita * (1 + vatFactor)
 *
 * IVA aplicado sobre a SOMA do cliente, ignorando o `apply_vat` de cada linha.
 * Um cliente com serviços isentos e não isentos leva IVA a mais no ficheiro.
 */
export function legacyCsvVatFromTotal(
  totalNet: number,
  vatRatePct: number,
): { iva: number; total: number } {
  const factor = vatRatePct / 100;
  return {
    iva: round2(totalNet * factor),
    total: round2(totalNet * (1 + factor)),
  };
}

// ─── Faturação diária ───────────────────────────────────────────────────────

export interface LegacyDayTotals {
  servicos: number;
  subtotal: number;
  iva: number;
  total: number;
}

/**
 * `src/app/actions/reports.ts`, bloco FATURAÇÃO DIÁRIA (~linha 303).
 *
 * Acumula base e IVA em vírgula flutuante e arredonda só no fim de cada dia.
 * O mapa é construído **apenas a partir dos dias que têm serviço**: um dia sem
 * serviços não existe na saída, e o gráfico salta-o em vez de mostrar zero.
 */
export function legacyDailyTotals(
  services: readonly ServiceInput[],
  monthlyPriceByContract: ReadonlyMap<string, number>,
  applyVatByContract: ReadonlyMap<string, boolean>,
  vatRatePct: number,
): Map<string, LegacyDayTotals> {
  const vatFactor = vatRatePct / 100;

  const avencaCount = new Map<string, number>();
  for (const s of services) {
    if (!s.contractId) continue;
    if (!monthlyPriceByContract.has(s.contractId)) continue;
    avencaCount.set(s.contractId, (avencaCount.get(s.contractId) ?? 0) + 1);
  }

  const byDay = new Map<string, { servicos: number; subtotal: number; iva: number }>();
  for (const s of services) {
    if (s.status !== "concluido") continue;
    const day = s.occurrenceDate;
    if (!byDay.has(day)) byDay.set(day, { servicos: 0, subtotal: 0, iva: 0 });
    const entry = byDay.get(day)!;
    entry.servicos += 1;

    let value: number;
    let hasVat: boolean;
    if (s.contractId && monthlyPriceByContract.has(s.contractId)) {
      const count = avencaCount.get(s.contractId) ?? 1;
      value = (monthlyPriceByContract.get(s.contractId) ?? 0) / count;
      hasVat = applyVatByContract.get(s.contractId) === true;
    } else {
      value = s.valueCents == null ? 0 : s.valueCents / 100;
      hasVat = s.applyVat;
    }
    entry.subtotal += value;
    entry.iva += hasVat ? value * vatFactor : 0;
  }

  const out = new Map<string, LegacyDayTotals>();
  for (const [day, v] of byDay) {
    out.set(day, {
      servicos: v.servicos,
      subtotal: round2(v.subtotal),
      iva: round2(v.iva),
      total: round2(v.subtotal + v.iva),
    });
  }
  return out;
}
