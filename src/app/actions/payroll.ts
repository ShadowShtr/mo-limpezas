"use server";

import { requireProfile } from "@/lib/auth-guard";
import {
  monthRange,
  calcCollaboratorPayroll,
  calcOvertimeBonus,
  calcAdjustedNetSalary,
} from "@/lib/payroll-calc";
import { isNoRowsError, queryFailure } from "@/lib/query-error";
import {
  parsePayrollStatus,
  denyEconomicMutation,
  approveTransition,
  splitRecalculationScope,
  PAYROLL_MUTATION_DENIAL_MESSAGE,
  PAYROLL_APPROVE_DENIAL_MESSAGE,
} from "@/domain/payroll/payroll-state";
import { isValidFiniteNumber } from "@/lib/utils";
import { todayInLisbon } from "@/lib/lisbon-time";
import { revalidatePath } from "next/cache";

import { criarContextoPeriodo, lerEstadoPeriodo, type ClientePeriodo } from "@/lib/finance-period-guard";
import {
  mensagemPeriodoFechado,
  PAYROLL_PERIOD_CLOSED_NO_MATERIALIZATION,
} from "@/domain/finance-v2/financial-period";

/**
 * Guarda dura para as mutações da folha. A data autoritativa do período é o
 * par `period_year`/`period_month` do próprio registo — não uma data civil,
 * porque uma folha é do mês, não de um dia.
 *
 * Devolve `null` quando pode prosseguir, ou o erro a devolver ao chamador.
 * Falha fechada: se não se souber o estado, recusa.
 */
async function bloquearSePeriodoFechado(
  year: number,
  month: number,
): Promise<{ ok: false; error: string } | null> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };

  const estado = await lerEstadoPeriodo(
    guard.admin as unknown as ClientePeriodo,
    guard.profile.company_id,
    { year, month },
  );
  if (!estado.ok) {
    return {
      ok: false,
      error: "Não foi possível confirmar se o período financeiro está aberto. Nada foi alterado.",
    };
  }
  if (estado.estado.status === "closed") {
    return { ok: false, error: mensagemPeriodoFechado({ year, month }) };
  }
  return null;
}

/**
 * Como `bloquearSePeriodoFechado`, mas para as mutações que recebem **ids de
 * registo** em vez de ano/mês.
 *
 * 🔴 O período vem do próprio registo (`period_year`/`period_month`), nunca do
 *    mês seleccionado no ecrã. Aprovar uma linha de Julho enquanto se olha
 *    para Agosto tem de validar Julho — usar o mês da UI deixava passar
 *    escritas em meses fechados a partir de qualquer vista.
 *
 * Um lote com linhas de meses diferentes exige que **todos** estejam abertos:
 * uma operação em bloco não deve ficar meia-feita.
 */
async function bloquearSePeriodoFechadoPorIds(
  ids: string[],
): Promise<{ ok: false; error: string } | null> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return null;

  const { data, error } = await guard.admin
    .from("payroll_records")
    .select("period_year, period_month")
    .eq("company_id", guard.profile.company_id)
    .in("id", unicos);

  if (error) {
    return { ok: false, error: "Não foi possível confirmar o período dos registos. Nada foi alterado." };
  }

  const periodos = new Map<string, { year: number; month: number }>();
  for (const r of data ?? []) {
    const year = Number(r.period_year);
    const month = Number(r.period_month);
    periodos.set(`${year}-${month}`, { year, month });
  }

  const contexto = criarContextoPeriodo(guard.admin as unknown as ClientePeriodo);
  for (const p of periodos.values()) {
    const estado = await contexto.ler(guard.profile.company_id, p);
    if (!estado.ok) {
      return {
        ok: false,
        error: "Não foi possível confirmar se o período financeiro está aberto. Nada foi alterado.",
      };
    }
    if (estado.estado.status === "closed") {
      return { ok: false, error: mensagemPeriodoFechado(p) };
    }
  }
  return null;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface PayrollRecord {
  id: string;
  collaborator_id: string;
  full_name: string;
  avatar_url: string | null;
  period_year: number;
  period_month: number;
  contracted_hours: number;
  worked_hours: number;
  overtime_hours: number;
  absence_hours: number;
  days_worked: number;
  hourly_rate: number;
  gross_salary: number;
  meal_allowance: number;
  overtime_bonus: number;
  overtime_rate_pct?: number;
  absence_deductions: number;
  other_deductions: number;
  other_additions: number;
  net_salary: number;
  notes: string | null;
  status: "rascunho" | "aprovado" | "pago";
  paid_at: string | null;
}

export interface PayrollAdjust {
  other_additions?:    number;
  other_deductions?:   number;
  notes?:              string;
  worked_hours?:       number;
  overtime_hours?:     number;
  absence_hours?:      number;
  absence_deductions?: number;
  days_worked?:        number;
  hourly_rate?:        number;
  meal_allowance_day?: number;
}

type PayrollProfileJoin = {
  profiles?: { full_name: string; avatar_url: string | null } | null;
};

/**
 * Resultado de um cálculo de folha.
 *
 * `preservados` conta as linhas que **não** foram recalculadas por já estarem
 * aprovadas ou pagas. Existe para que a interface não possa dizer "folha
 * recalculada" depois de não ter tocado em metade delas.
 */
export type PayrollCalculationResult =
  | {
      ok: true;
      records: PayrollRecord[];
      materializado: boolean;
      motivo?: string;
      /** Linhas preservadas por estarem aprovadas ou pagas. */
      preservados: number;
    }
  | { ok: false; error: string };

// monthRange re-exported from payroll-calc (timezone-safe, uses Date.UTC)

// ─── Calcular e guardar folha de pagamento ────────────────────────────────────

async function runPayrollCalculation(
  year: number,
  month: number,
  // ─── Período financeiro fechado ────────────────────────────────────────────
  //
  // `permitirMaterializacao: false` é o modo usado pelo render da página. A
  // folha é calculada e devolvida, mas **não é gravada**.
  //
  // 🔴 Porque é que isto não é uma guarda normal que devolve erro:
  //
  //    `ensurePayrollCalculated` corre dentro do render de um Server Component
  //    — foi a correcção de Julho para o crash da Folha de Pagamento. Se
  //    devolvesse erro num mês fechado, abrir a folha de Agosto depois de
  //    fechar Agosto mostrava o error boundary em vez dos números. Uma leitura
  //    tem de continuar a ser uma leitura.
  //
  //    Mas o inverso também não serve: deixar o render gravar num mês fechado
  //    criava a pior excepção possível — «render é read-only, excepto quando
  //    recalcula financeiramente um período fechado». As duas regras
  //    coexistem por aqui: calcula, mostra, e não escreve.
  opcoes: { permitirMaterializacao?: boolean } = {},
): Promise<PayrollCalculationResult> {
  const permitirMaterializacao = opcoes.permitirMaterializacao ?? true;
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;
  const { start, end } = monthRange(year, month);

  // 1. Colaboradores ativos
  const { data: profiles, error: pErr } = await admin
    .from("profiles")
    .select("id, full_name, avatar_url, contracted_hours_month, hourly_rate")
    .eq("company_id", companyId)
    .in("role", ["colaborador", "gestor", "admin"])
    .eq("status", "ativo")
    .order("full_name");

  if (pErr) return queryFailure("runPayrollCalculation:profiles", pErr);
  if (!profiles?.length) return { ok: true, records: [], materializado: false, preservados: 0 };

  // 2. Configurações da empresa (salário/hora e sub. alimentação por defeito)
  //
  // 🔴 `.maybeSingle()` em vez de `.single()`: a empresa pode legitimamente não
  //    ter uma linha de definições, e isso não é uma avaria. Com `.single()` a
  //    ausência vinha como erro e ficava indistinguível de uma falha real.
  //
  //    A distinção importa em euros. Antes, `settings?.hourly_rate ?? 8` dava
  //    8 €/hora tanto para "não configuraram" como para "a consulta rebentou".
  //    A segunda leitura calcula uma folha inteira a um valor que ninguém
  //    escolheu. Agora a falha aborta e a ausência mantém os valores por
  //    omissão de sempre — o comportamento económico não muda.
  const { data: settings, error: sErr } = await admin
    .from("company_settings")
    .select("hourly_rate, meal_allowance_day, overtime_rate_pct")
    .eq("company_id", companyId)
    .maybeSingle();

  if (sErr && !isNoRowsError(sErr)) {
    return queryFailure("runPayrollCalculation:company_settings", sErr);
  }

  const defaultHourlyRate = settings?.hourly_rate ?? 8;
  const mealAllowanceDay  = settings?.meal_allowance_day ?? 9.6;
  const overtimeRatePct   = settings?.overtime_rate_pct ?? 25;

  const profileIds = profiles.map((p) => p.id);

  // 3. Ponto GERAL do mês (entrada→saída). É isto que conta para o salário —
  //    os pontos por serviço (timesheets) são apenas informativos.
  //
  // 🔴 Falhar aqui não pode dar uma folha de zero horas. Uma pessoa que
  //    trabalhou o mês inteiro sairia com o bruto a zero e o subsídio de
  //    alimentação a zero, e a folha seria gravada nesse estado.
  const { data: dailyClocks, error: cErr } = await admin
    .from("daily_clocks")
    .select("collaborator_id, work_date, clock_in_at, clock_out_at")
    .eq("company_id", companyId)
    .in("collaborator_id", profileIds)
    .gte("work_date", start)
    .lte("work_date", end);

  if (cErr) return queryFailure("runPayrollCalculation:daily_clocks", cErr);

  // Converte cada dia (com início e fim) numa entrada equivalente a um timesheet,
  // para reutilizar o cálculo existente sem o alterar.
  const timesheets = (dailyClocks ?? [])
    .filter((d) => d.clock_in_at && d.clock_out_at)
    .map((d) => ({
      collaborator_id: d.collaborator_id,
      clock_in_at: d.clock_in_at as string,
      duration_minutes: Math.max(0, Math.round(
        (new Date(d.clock_out_at as string).getTime() - new Date(d.clock_in_at as string).getTime()) / 60000,
      )),
    }));

  // 4. Faltas do mês
  //
  // 🔴 Falhar aqui daria "sem faltas": ninguém perderia retribuição por
  //    ausência injustificada, e a folha seria gravada como se o mês tivesse
  //    sido inteiramente trabalhado.
  const { data: absences, error: aErr } = await admin
    .from("absences")
    .select("collaborator_id, absence_type, starts_on, ends_on")
    .eq("company_id", companyId)
    .in("collaborator_id", profileIds)
    .lte("starts_on", end)
    .gte("ends_on", start);

  if (aErr) return queryFailure("runPayrollCalculation:absences", aErr);

  // 5. Registos existentes — decidem duas coisas: que ajustes manuais preservar
  //    e, sobretudo, em que linhas é sequer permitido tocar.
  //
  // 🔴 Falhar aqui era o pior dos quatro. Sem os registos existentes, o
  //    recálculo perdia os ajustes manuais **e** deixava de saber que uma
  //    linha estava aprovada ou paga — reescrevendo-a por cima.
  const { data: existing, error: eErr } = await admin
    .from("payroll_records")
    .select("collaborator_id, other_additions, other_deductions, notes, status, paid_at")
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month);

  if (eErr) return queryFailure("runPayrollCalculation:existing", eErr);

  const existingMap = Object.fromEntries(
    (existing ?? []).map((r) => [r.collaborator_id, r]),
  );

  // 6. Separar quem pode ser recalculado de quem já não pode
  //
  // 🔴 ESTE É O DEFEITO CENTRAL QUE A BLINDAGEM FECHA.
  //
  //    O código anterior calculava toda a gente e fazia `upsert` de toda a
  //    gente, preservando apenas `status` e `paid_at`. Os valores em euros —
  //    horas, bruto, subsídio, extra, deduções, líquido — eram reescritos
  //    mesmo em linhas aprovadas ou pagas.
  //
  //    Uma folha paga de €1.200 tem uma saída de caixa de €1.200 associada.
  //    Recalcular o mês depois de corrigir um ponto passava a folha para
  //    €1.250 e deixava o caixa em €1.200. A linha continuava a dizer "pago".
  //    Nada avisava.
  //
  //    Agora aprovado e pago são fotografias: o recálculo lê-os, conta-os, e
  //    não lhes toca.
  const { recalculable, preserved } = splitRecalculationScope(
    profiles,
    (p) => parsePayrollStatus(existingMap[p.id]?.status),
  );

  // 7. Calcular por colaborador — apenas os que ainda são rascunho
  const upserts = recalculable.map((p) => {
    const myTimesheets = (timesheets ?? []).filter((t) => t.collaborator_id === p.id);
    const myAbsences   = (absences   ?? []).filter((a) => a.collaborator_id === p.id);

    const contractedHours = p.contracted_hours_month ?? 168;
    const hourlyRate      = p.hourly_rate ?? defaultHourlyRate;

    const ex = existingMap[p.id];
    const otherAdditions  = ex?.other_additions  ?? 0;
    const otherDeductions = ex?.other_deductions ?? 0;
    const notes           = ex?.notes ?? null;
    // Só chegam aqui linhas inexistentes ou em rascunho — ver o split acima.
    // O estado não precisa de ser deduzido: é sempre este.
    const status  = "rascunho" as const;
    const paidAt  = null;

    const calc = calcCollaboratorPayroll(
      myTimesheets as { duration_minutes: number; clock_in_at: string }[],
      myAbsences,
      contractedHours,
      hourlyRate,
      { defaultHourlyRate, mealAllowanceDay, overtimeRatePct },
      start,
      end,
      otherAdditions,
      otherDeductions,
    );

    const {
      workedHours, daysWorked, overtimeHours,
      grossSalary, mealAllowance, overtimeBonus,
      absenceHours, absenceDeductions, netSalary,
    } = calc;

    return {
      company_id:          companyId,
      collaborator_id:     p.id,
      period_year:         year,
      period_month:        month,
      contracted_hours:    contractedHours,
      worked_hours:        workedHours,
      overtime_hours:      overtimeHours,
      absence_hours:       absenceHours,
      days_worked:         daysWorked,
      hourly_rate:         hourlyRate,
      gross_salary:        grossSalary,
      meal_allowance:      mealAllowance,
      overtime_bonus:      overtimeBonus,
      absence_deductions:  absenceDeductions,
      other_additions:     otherAdditions,
      other_deductions:    otherDeductions,
      net_salary:          netSalary,
      notes,
      status,
      paid_at:             paidAt,
    };
  });

  // 🔴 Mês fechado: calcula-se e devolve-se, mas não se grava. Os registos que
  //    já existem são lidos como estão — o que a gestora vê é o que ficou
  //    fixado no fecho, não um recálculo por cima.
  if (!permitirMaterializacao) {
    const existentes = await getPayrollRecords(companyId, year, month);
    if (!existentes.ok) return existentes;
    return {
      ok: true,
      records: existentes.records,
      materializado: false,
      motivo: PAYROLL_PERIOD_CLOSED_NO_MATERIALIZATION,
      preservados: preserved.length,
    };
  }

  // Toda a gente já está aprovada ou paga: não há nada para escrever, e um
  // upsert vazio não é uma escrita que valha a pena arriscar.
  if (upserts.length > 0) {
    const { error: uErr } = await admin.rpc("upsert_payroll_records_atomic", {
      p_company_id: companyId, p_period_year: year, p_period_month: month,
      p_records: upserts, p_actor: guard.profile.id,
    });

    if (uErr) return queryFailure("runPayrollCalculation:upsert", uErr);
  }

  const gravados = await getPayrollRecords(companyId, year, month);
  if (!gravados.ok) return gravados;
  return {
    ok: true,
    records: gravados.records,
    materializado: true,
    preservados: preserved.length,
  };
}

/**
 * Estado atual da folha de um período, para quem precisa de o mostrar.
 *
 * 🔴 O nome é histórico e o comportamento já não é o que ele sugere: **não
 *    calcula nem grava nada**. É leitura pura.
 *
 *    O nome antigo descrevia o que a função fazia até à ronda do Financeiro
 *    V2: era chamada dentro do render de um Server Component e, se faltassem
 *    linhas, calculava a folha e fazia `upsert`. Abrir a página gravava. Essa
 *    chamada saiu da página (ver o comentário em `folha-pagamento/page.tsx`),
 *    mas a função continuava a existir com o motor de cálculo lá dentro —
 *    uma escrita à espera de quem a chamasse por engano.
 *
 *    Agora não há motor nenhum aqui. Um período sem folha calculada devolve
 *    lista vazia e `materializado: false`; quem vê decide se carrega em
 *    "Recalcular folha", que é o único caminho que escreve.
 *
 * O nome mantém-se porque `financeiro-v2-shell.test.ts` o vigia como acção
 * proibida no render — e uma acção que já não escreve continuar nessa lista é
 * conservador, não errado.
 */
export async function ensurePayrollCalculated(
  year: number,
  month: number,
): Promise<PayrollCalculationResult> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };

  const existentes = await getPayrollRecords(guard.profile.company_id, year, month);
  if (!existentes.ok) return existentes;

  return {
    ok: true,
    records: existentes.records,
    materializado: false,
    preservados: 0,
  };
}

/**
 * Usada pelo botão "Calcular"/"Recalcular" no cliente — aqui revalidar é
 * válido, e aqui a guarda é dura: recalcular é um acto deliberado, e num mês
 * fechado a resposta certa é dizer que não, com a razão.
 */
export async function calculateAndSavePayroll(
  _companyId: string,
  year: number,
  month: number,
): Promise<PayrollCalculationResult> {
  const bloqueio = await bloquearSePeriodoFechado(year, month);
  if (bloqueio) return bloqueio;

  const result = await runPayrollCalculation(year, month);
  if (result.ok) revalidatePath("/dashboard/folha-pagamento");
  return result;
}

// ─── Ler registos guardados ───────────────────────────────────────────────────

export async function getPayrollRecords(
  _companyId: string,
  year: number,
  month: number,
): Promise<{ ok: true; records: PayrollRecord[] } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const { data, error } = await admin
    .from("payroll_records")
    .select("*, profiles!collaborator_id(full_name, avatar_url)")
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month)
    .order("profiles(full_name)");

  if (error) return { ok: false, error: error.message };

  const { data: settings, error: settingsError } = await admin
    .from("company_settings")
    .select("overtime_rate_pct")
    .eq("company_id", companyId)
    .maybeSingle();
  if (settingsError && !isNoRowsError(settingsError)) {
    return queryFailure("getPayrollRecords:company_settings", settingsError);
  }
  const overtimeRatePct = settings?.overtime_rate_pct ?? 25;

  const records: PayrollRecord[] = (data ?? []).map((r) => {
    const profile = (r as unknown as PayrollProfileJoin).profiles ?? null;
    return {
      id: r.id,
      collaborator_id:    r.collaborator_id,
      full_name:          profile?.full_name ?? "—",
      avatar_url:         profile?.avatar_url ?? null,
      period_year:        r.period_year,
      period_month:       r.period_month,
      contracted_hours:   r.contracted_hours ?? 0,
      worked_hours:       r.worked_hours ?? 0,
      overtime_hours:     r.overtime_hours ?? 0,
      absence_hours:      r.absence_hours ?? 0,
      days_worked:        r.days_worked ?? 0,
      hourly_rate:        r.hourly_rate ?? 0,
      gross_salary:       r.gross_salary ?? 0,
      meal_allowance:     r.meal_allowance ?? 0,
      overtime_bonus:     r.overtime_bonus ?? 0,
      overtime_rate_pct: overtimeRatePct,
      absence_deductions: r.absence_deductions ?? 0,
      other_additions:    r.other_additions ?? 0,
      other_deductions:   r.other_deductions ?? 0,
      net_salary:         r.net_salary ?? 0,
      notes:              r.notes ?? null,
      status:             r.status as PayrollRecord["status"],
      paid_at:            r.paid_at ?? null,
    };
  });

  return { ok: true, records };
}

// ─── Ajustar manualmente um registo ──────────────────────────────────────────

export async function adjustPayrollRecord(
  id: string,
  adjust: PayrollAdjust,
): Promise<{ ok: boolean; error?: string }> {
  // Ajuste manual de folha salarial — cada valor entra diretamente na
  // conta do net_salary pago à colaboradora, por isso é validado à entrada
  // (um NaN/negativo/absurdo aqui corrompe o salário real, não só a UI).
  for (const [field, value] of Object.entries(adjust)) {
    if (field === "notes") continue;
    if (!isValidFiniteNumber(value as number | undefined, { max: 100_000 })) {
      return { ok: false, error: `Valor inválido em "${field}".` };
    }
  }

  // Período do próprio registo — ajustar um salário altera o custo do mês a que
  // ele pertence, e é esse mês que tem de estar aberto.
  const bloqueio = await bloquearSePeriodoFechadoPorIds([id]);
  if (bloqueio) return bloqueio;

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  // Ler o registo atual: para recalcular, para auditar o antes verdadeiro e —
  // sobretudo — para saber se sequer se pode tocar nele.
  const { data: rec, error: rErr } = await admin
    .from("payroll_records")
    .select("company_id, status, gross_salary, meal_allowance, overtime_bonus, absence_deductions, other_additions, other_deductions, net_salary, worked_hours, overtime_hours, absence_hours, days_worked, hourly_rate, notes")
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();

  if (rErr && !isNoRowsError(rErr)) {
    return queryFailure("adjustPayrollRecord:record", rErr);
  }
  if (!rec) return { ok: false, error: "Registo não encontrado." };

  // ── Guarda de estado ───────────────────────────────────────────
  //
  // 🔴 Antes, a única guarda era o período financeiro estar aberto. Num mês
  //    aberto, uma folha já **paga** podia ser editada à vontade: os valores
  //    mudavam, o `status` continuava "pago", e a saída de caixa ficava com o
  //    montante antigo. Período aberto diz que o mês ainda se mexe; não diz
  //    que aquela linha em particular ainda se mexe.
  const status = parsePayrollStatus(rec.status);
  const recusa = denyEconomicMutation(status);
  if (recusa) return { ok: false, error: PAYROLL_MUTATION_DENIAL_MESSAGE[recusa] };

  const workedHours    = adjust.worked_hours      ?? rec.worked_hours       ?? 0;
  const overtimeHours  = adjust.overtime_hours    ?? rec.overtime_hours     ?? 0;
  const absenceHours   = adjust.absence_hours     ?? rec.absence_hours      ?? 0;
  const daysWorked     = adjust.days_worked       ?? rec.days_worked        ?? 0;
  const hourlyRate     = adjust.hourly_rate       ?? rec.hourly_rate        ?? 0;

  const rateChanged  = adjust.hourly_rate     !== undefined;
  const hoursChanged = adjust.worked_hours    !== undefined || adjust.overtime_hours !== undefined
    || adjust.days_worked !== undefined || adjust.absence_hours !== undefined;

  const grossSalary = (hoursChanged || rateChanged)
    ? Math.round(workedHours * hourlyRate * 100) / 100
    : (rec.gross_salary ?? 0);

  // Subsídio de alimentação: usa meal_allowance_day se fornecido, senão proporcional ao registo
  const mealPerDay = adjust.meal_allowance_day !== undefined
    ? adjust.meal_allowance_day
    : rec.days_worked > 0 ? (rec.meal_allowance ?? 0) / rec.days_worked : 0;
  const mealAllowance = (hoursChanged && adjust.days_worked !== undefined) || adjust.meal_allowance_day !== undefined
    ? Math.round(daysWorked * mealPerDay * 100) / 100
    : (rec.meal_allowance ?? 0);

  // ── Horas extra: uma regra só ────────────────────────────────────
  //
  // 🔴 Aqui estava `overtimeHours * hourlyRate * 0.25`, escrito à mão, enquanto
  //    o cálculo mensal usava `overtime_rate_pct` das definições da empresa.
  //    Uma empresa com 50% configurados tinha 50% no cálculo do mês e 25% em
  //    qualquer ajuste manual — dois valores para a mesma hora extra, e o que
  //    ficava gravado dependia de por onde o número tinha passado.
  //
  //    A percentagem vem agora da mesma fonte que o cálculo mensal. Se não a
  //    conseguirmos ler, o ajuste é recusado: assumir 25% é inventar dinheiro.
  const precisaTaxaExtra = adjust.overtime_hours !== undefined || rateChanged;
  let overtimeBonus = rec.overtime_bonus ?? 0;

  if (precisaTaxaExtra) {
    const { data: settings, error: sErr } = await admin
      .from("company_settings")
      .select("overtime_rate_pct")
      .eq("company_id", companyId)
      .maybeSingle();

    if (sErr && !isNoRowsError(sErr)) {
      return queryFailure("adjustPayrollRecord:company_settings", sErr);
    }

    // Sem linha de definições mantém-se o valor por omissão de sempre — é o
    // contrato do produto, e esta PR não muda contratos económicos.
    const overtimeRatePct = settings?.overtime_rate_pct ?? 25;
    overtimeBonus = calcOvertimeBonus(overtimeHours, hourlyRate, overtimeRatePct);
  }

  const absenceDed = adjust.absence_deductions ?? rec.absence_deductions ?? 0;
  const otherAdd   = adjust.other_additions    ?? rec.other_additions    ?? 0;
  const otherDed   = adjust.other_deductions   ?? rec.other_deductions   ?? 0;

  // A mesma soma que o cálculo mensal usa. Ver `calcAdjustedNetSalary`.
  const netSalary = calcAdjustedNetSalary(
    grossSalary, mealAllowance, overtimeBonus, otherAdd, absenceDed, otherDed,
  );

  const { error } = await admin.rpc("adjust_payroll_record_atomic", {
    p_company_id: companyId,
    p_record_id: id,
    p_actor: guard.profile.id,
    p_patch: {
      worked_hours: workedHours, overtime_hours: overtimeHours,
      absence_hours: absenceHours, days_worked: daysWorked,
      hourly_rate: hourlyRate, gross_salary: grossSalary,
      meal_allowance: mealAllowance, overtime_bonus: overtimeBonus,
      absence_deductions: absenceDed, other_additions: otherAdd,
      other_deductions: otherDed, net_salary: netSalary,
      ...(adjust.notes !== undefined ? { notes: adjust.notes } : {}),
    },
  });

  if (error) return queryFailure("adjustPayrollRecord:atomic", error);

  revalidatePath("/dashboard/folha-pagamento");
  return { ok: true };
}

// ─── Aprovar registos ────────────────────────────────────────────────────────

export async function approvePayrollRecords(
  ids: string[],
): Promise<{ ok: boolean; error?: string; aprovados?: number; jaAprovados?: number }> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return { ok: true, aprovados: 0, jaAprovados: 0 };

  // Aprovar fixa o valor a pagar. Num mês fechado isso já não se mexe.
  const bloqueio = await bloquearSePeriodoFechadoPorIds(uniqueIds);
  if (bloqueio) return bloqueio;

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  // ── Resolver o lote antes de lhe tocar ────────────────────────────────────
  //
  // 🔴 O código anterior fazia `update(...).in("id", ids).eq("company_id", ...)`
  //    e mais nada. Consequências:
  //
  //    · um id inexistente, ou de outra empresa, era silenciosamente ignorado
  //      — a operação dizia "ok" tendo aprovado menos linhas do que as pedidas,
  //      e ninguém ficava a saber quais;
  //    · o estado atual nunca era lido, por isso uma linha **paga** voltava a
  //      "aprovado". A saída de caixa ficava lá, e a folha passava a dizer que
  //      estava por pagar com o dinheiro já registado como saído.
  const { data: encontrados, error: fErr } = await admin
    .from("payroll_records")
    .select("id, status")
    .eq("company_id", companyId)
    .in("id", uniqueIds);

  if (fErr) return queryFailure("approvePayrollRecords:resolve", fErr);

  // Falha fechada: pedimos N, resolvemos N, ou não se escreve nada.
  //
  // A mensagem não diz *qual* id falhou nem porquê — distinguir "não existe"
  // de "é de outra empresa" confirmaria a existência de registos alheios a
  // quem tentasse adivinhar ids.
  if ((encontrados?.length ?? 0) !== uniqueIds.length) {
    return {
      ok: false,
      error: "A seleção já não corresponde aos registos existentes. Atualiza a página e tenta novamente.",
    };
  }

  const aAprovar: string[] = [];
  let jaAprovados = 0;

  for (const r of encontrados ?? []) {
    const resultado = approveTransition(parsePayrollStatus(r.status));
    // Um estado que não se pode aprovar derruba o lote inteiro. Aprovar
    // metade de uma seleção financeira deixa quem clicou sem saber o que
    // ficou feito — e é precisamente nessa dúvida que se clica outra vez.
    if (resultado.kind === "denied") {
      return { ok: false, error: PAYROLL_APPROVE_DENIAL_MESSAGE[resultado.code] };
    }
    if (resultado.kind === "noop") { jaAprovados += 1; continue; }
    aAprovar.push(r.id);
  }

  // Lote inteiro já aprovado: um segundo clique, ou um retry depois de a
  // resposta se ter perdido, não é erro. Idempotente, sem escrita.
  if (aAprovar.length === 0) {
    return { ok: true, aprovados: 0, jaAprovados };
  }

  const { data: approval, error } = await admin.rpc("approve_payroll_records_atomic", {
    p_company_id: companyId, p_record_ids: uniqueIds, p_actor: guard.profile.id,
  });
  if (error) return queryFailure("approvePayrollRecords:atomic", error);

  revalidatePath("/dashboard/folha-pagamento");
  const result = (approval as Array<{ approved_count?: number; already_approved_count?: number }> | null)?.[0];
  if (!result || typeof result.approved_count !== "number") return { ok: false, error: "Resposta inválida da operação atómica." };
  return { ok: true, aprovados: result.approved_count, jaAprovados: result.already_approved_count ?? 0 };
}

// ─── Marcar como pago ────────────────────────────────────────────────────────

export async function markPayrollPaid(
  ids: string[],
): Promise<{ ok: boolean; error?: string }> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return { ok: true };

  // Marcar como paga cria a saída de caixa do salário — é o facto económico
  // mais directo desta página.
  const bloqueio = await bloquearSePeriodoFechadoPorIds(uniqueIds);
  if (bloqueio) return bloqueio;

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const profile = guard.profile;

  const { error } = await admin.rpc("mark_payroll_paid_atomic", {
    p_company_id: profile.company_id,
    p_record_ids: uniqueIds,
    p_paid_on: todayInLisbon(),
    p_actor: profile.id,
  });
  if (error) return queryFailure("markPayrollPaid:atomic", error);

  revalidatePath("/dashboard/folha-pagamento");
  revalidatePath("/dashboard/financeiro");
  return { ok: true };
}
