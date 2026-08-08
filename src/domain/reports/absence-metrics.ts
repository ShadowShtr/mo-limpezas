// ============================================================================
// T14 — Absentismo dentro do período
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê a base, não escreve, não altera dados.
//
// ----------------------------------------------------------------------------
//
// O defeito medido.
//
// `src/app/actions/reports.ts`, bloco ABSENTISMO:
//
//     .lte("starts_on", endDate).gte("ends_on", startDate)     // filtro certo
//     dias = round((ends_on − starts_on) / 86400000) + 1        // conta errada
//
// O filtro traz as ausências que TOCAM o período. A conta soma a duração
// INTEIRA de cada uma. Uma baixa de 1 de agosto a 30 de setembro entra no
// relatório de agosto com 61 dias — num mês de 31 — e entra outra vez no de
// setembro com os mesmos 61. Total anual: 122 dias para uma ausência de 61.
//
// O KPI "Dias de falta" da página de Relatórios soma exactamente esta coluna.
//
// A correcção é a interseção (`src/domain/reports/period.ts`): uma ausência
// contribui com os dias que estão dentro da janela e mais nenhum. A soma sobre
// meses consecutivos passa a dar a duração real, sem dupla contagem.
//
// ----------------------------------------------------------------------------
//
// Sobre HORAS de ausência — o que este módulo se recusa a inventar.
//
// Não existe no schema nenhuma jornada diária. `profiles.contracted_hours_month`
// é mensal; `payroll_records.absence_hours` é preenchido pela folha, por outro
// caminho. Converter dias em horas exige uma regra de negócio que ninguém
// escreveu: 8 h/dia? `contracted_hours_month / 22`? conta o sábado?
//
// Por isso `absenceHoursWithinPeriod` **exige** que quem chama passe a jornada
// explicitamente. Sem ela devolve `null` (não zero). Inventar 8 h aqui faria o
// absentismo em horas parecer um facto quando seria um palpite — e esse número
// entraria depois em comparações de custo.

import { type CivilPeriod, intersectionDays, makePeriod } from "./period";
import { type AbsenceInput, isAbsenceType } from "./report-sources";
import { type IntegrityIssue, issue } from "./integrity";

/** Contribuição de UMA ausência para UMA janela. */
export interface AbsenceContribution {
  absenceId: string;
  collaboratorId: string;
  type: string;
  /** Dias da ausência dentro da janela. Zero se não se tocam. */
  daysWithinPeriod: number;
  /** Duração total da ausência, para contexto. Nunca somar esta coluna. */
  totalDays: number;
  /** `true` se a ausência se estende para fora da janela. */
  truncated: boolean;
}

/**
 * Dias de uma ausência dentro da janela.
 *
 * Devolve `null` quando o intervalo da ausência é inválido (datas malformadas
 * ou `ends_on` anterior a `starts_on`). `null` obriga quem chama a registar
 * `INVALID_DATE_RANGE` em vez de somar um zero indistinguível de "não tocou o
 * período".
 */
export function absenceDaysWithinPeriod(
  absence: AbsenceInput,
  window: CivilPeriod,
): number | null {
  const range = makePeriod(absence.startsOn, absence.endsOn);
  if (!range) return null;
  return intersectionDays(range, window);
}

/**
 * Horas de ausência dentro da janela.
 *
 * `hoursPerDay` não tem valor por omissão, de propósito (ver cabeçalho).
 * `null` = não há regra para converter, e o resultado é `null`.
 */
export function absenceHoursWithinPeriod(
  absence: AbsenceInput,
  window: CivilPeriod,
  hoursPerDay: number | null,
): number | null {
  if (hoursPerDay == null || !Number.isFinite(hoursPerDay) || hoursPerDay < 0) return null;
  const days = absenceDaysWithinPeriod(absence, window);
  if (days == null) return null;
  return days * hoursPerDay;
}

/** Contribuições de um conjunto de ausências, com os problemas detectados. */
export function summariseAbsences(
  absences: readonly AbsenceInput[],
  window: CivilPeriod,
): { contributions: AbsenceContribution[]; issues: IntegrityIssue[] } {
  const contributions: AbsenceContribution[] = [];
  const issues: IntegrityIssue[] = [];
  const seen = new Set<string>();

  for (const a of absences) {
    if (seen.has(a.id)) {
      issues.push(
        issue("DUPLICATE_SERVICE_ID", {
          source: "absences",
          subject: a.id,
          detail: "ausência repetida no conjunto carregado",
        }),
      );
      continue;
    }
    seen.add(a.id);

    const range = makePeriod(a.startsOn, a.endsOn);
    if (!range) {
      issues.push(
        issue("INVALID_DATE_RANGE", {
          source: "absences",
          subject: a.id,
          detail: "starts_on/ends_on inválido ou invertido",
        }),
      );
      continue;
    }

    if (!isAbsenceType(a.type)) {
      issues.push(
        issue("UNKNOWN_STATUS", {
          source: "absences",
          subject: a.id,
          detail: `absence_type fora do CHECK do schema: ${a.type}`,
        }),
      );
    }

    const daysWithinPeriod = intersectionDays(range, window);
    const totalDays = intersectionDays(range, range);

    if (daysWithinPeriod === 0) {
      // Não é erro: a consulta pode trazer margem. Fica registado como INFO
      // para que uma janela mal construída seja visível em vez de silenciosa.
      issues.push(
        issue("RECORD_OUTSIDE_PERIOD", {
          source: "absences",
          subject: a.id,
          detail: "ausência carregada não toca o período do relatório",
        }),
      );
    }

    contributions.push({
      absenceId: a.id,
      collaboratorId: a.collaboratorId,
      type: a.type,
      daysWithinPeriod,
      totalDays,
      truncated: daysWithinPeriod < totalDays,
    });
  }

  return { contributions, issues };
}

/** Total de dias de ausência da janela, por tipo. */
export function absenceDaysByType(
  contributions: readonly AbsenceContribution[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of contributions) {
    if (c.daysWithinPeriod === 0) continue;
    out[c.type] = (out[c.type] ?? 0) + c.daysWithinPeriod;
  }
  return out;
}

/** Total de dias de ausência da janela, por colaborador. */
export function absenceDaysByCollaborator(
  contributions: readonly AbsenceContribution[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of contributions) {
    if (c.daysWithinPeriod === 0) continue;
    out[c.collaboratorId] = (out[c.collaboratorId] ?? 0) + c.daysWithinPeriod;
  }
  return out;
}

/**
 * Total de dias de ausência da janela.
 *
 * É este número — e não a soma das durações — que o KPI "Dias de falta" deve
 * mostrar. Nunca pode exceder `periodDays(window) × nº de colaboradores`, e o
 * teste de fronteira prova-o.
 */
export function totalAbsenceDays(contributions: readonly AbsenceContribution[]): number {
  let total = 0;
  for (const c of contributions) total += c.daysWithinPeriod;
  return total;
}
