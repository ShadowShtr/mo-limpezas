"use server";

// ============================================================================
// Financeiro V2 — o motor de leitura
// ============================================================================
//
// 🔴 **Só leitura.** Não há aqui um único `insert`, `update`, `delete`,
//    `upsert` ou RPC de escrita, e um teste falha se aparecer. Este ficheiro
//    alimenta o Resumo, que é a página de entrada do módulo: se ele escrever,
//    abrir a página escreve — e foi exactamente esse o incidente que este
//    projecto passou semanas a conter.
//
// ---------------------------------------------------------------------------
// O que substitui, e porquê
// ---------------------------------------------------------------------------
// `getFinancialDashboard` **ignora o período**: recebe só `companyId` e decide
// o mês internamente com `new Date()`. O seletor da interface dizia «Agosto
// 2026» enquanto os números respondiam sobre o mês do relógio do servidor —
// que, na Vercel, corre em UTC.
//
// Aqui o período é o primeiro argumento e atravessa tudo. Nenhum adaptador
// chama `new Date()`: recebem o contexto já resolvido.
// ============================================================================

import { requireProfile } from "@/lib/auth-guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayInLisbon } from "@/lib/lisbon-time";
import { getUnbilledServices } from "@/app/actions/invoices";

import {
  calcularAging,
  calcularAlertas,
  calcularKpis,
  calcularDespesasPorCategoria,
  calcularPredios,
  calcularTopClientes,
  type FactoCaixa,
  type FactoFatura,
  type FactoFolha,
  type FactoPredio,
  type Fonte,
} from "@/domain/finance-v2/aggregate";
import {
  construirContexto,
  type AvisoSaude,
  type FalhaFonte,
  type FinanceDashboardSnapshot,
  type FinanceReadContext,
} from "@/domain/finance-v2/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// ─── Adaptadores ─────────────────────────────────────────────────────────────
//
// Cada um devolve factos **ou** a razão da falha. Nunca uma lista vazia a
// disfarçar um erro: `data ?? []` transforma uma query rebentada num zero que
// ninguém distingue de um zero verdadeiro.

async function loadInvoiceFacts(admin: AdminClient, ctx: FinanceReadContext): Promise<Fonte<FactoFatura>> {
  const { data, error } = await admin
    .from("invoices")
    .select("id, status, total, due_date, paid_at, period_start, client_id, clients(name)")
    .eq("company_id", ctx.companyId);

  if (error) return { ok: false, erro: error.message };

  type Linha = {
    id: string; status: string; total: number | null; due_date: string | null;
    paid_at: string | null; period_start: string | null; client_id: string | null;
    clients: { name: string } | { name: string }[] | null;
  };

  return {
    ok: true,
    factos: ((data ?? []) as unknown as Linha[]).map((r) => ({
      id: r.id,
      status: r.status,
      total: Number(r.total ?? 0),
      dueDate: r.due_date,
      paidAt: r.paid_at,
      periodStart: r.period_start,
      clientId: r.client_id,
      clientName: Array.isArray(r.clients) ? (r.clients[0]?.name ?? null) : (r.clients?.name ?? null),
    })),
  };
}

/** Mesma distinção que nas Contas: «falta a 071» não é «a consulta falhou». */
function categoriaEstruturadaEmFalta(erro: { code?: string; message?: string } | null): boolean {
  if (!erro) return false;
  if (["42P01", "42703", "PGRST200", "PGRST205"].includes(erro.code ?? "")) return true;
  return /expense_categor/i.test(erro.message ?? "")
    && /does not exist|could not find|no relationship/i.test(erro.message ?? "");
}

async function loadCashFacts(admin: AdminClient, ctx: FinanceReadContext): Promise<Fonte<FactoCaixa>> {
  // A categoria estruturada só existe depois da 071. Pede-se, e se a base
  // ainda não a tiver repete-se sem ela — mas só nesse caso: um erro de outra
  // natureza continua a ser erro, e não «mês sem movimentos».
  const COLUNAS = "date, type, status, amount, category";
  const consulta = (colunas: string) =>
    admin
      .from("cash_flow_entries")
      .select(colunas)
      .eq("company_id", ctx.companyId)
      .gte("date", ctx.periodStart)
      .lte("date", ctx.periodEnd);

  let { data, error } = await consulta(`${COLUNAS}, expense_categories(name, color_token)`);
  if (error && categoriaEstruturadaEmFalta(error)) {
    ({ data, error } = await consulta(COLUNAS));
  }

  if (error) return { ok: false, erro: error.message };

  type Linha = {
    date: string; type: string; status: string; amount: number | null; category: string | null;
    expense_categories?: { name: string; color_token: string | null }
      | { name: string; color_token: string | null }[] | null;
  };
  return {
    ok: true,
    factos: ((data ?? []) as unknown as Linha[]).map((r) => {
      const cat = Array.isArray(r.expense_categories) ? r.expense_categories[0] : r.expense_categories;
      return {
        date: r.date,
        tipo: (r.type === "entrada" ? "entrada" : "saida") as "entrada" | "saida",
        status: r.status,
        amount: Number(r.amount ?? 0),
        categoria: r.category,
        categoriaEstruturada: cat?.name ?? null,
        categoriaEstruturadaCor: cat?.color_token ?? null,
      };
    }),
  };
}

async function loadPayrollFacts(admin: AdminClient, ctx: FinanceReadContext): Promise<Fonte<FactoFolha>> {
  const { data, error } = await admin
    .from("payroll_records")
    .select("gross_salary, net_salary, worked_hours, status")
    .eq("company_id", ctx.companyId)
    .eq("period_year", ctx.year)
    .eq("period_month", ctx.month);

  if (error) return { ok: false, erro: error.message };

  type Linha = { gross_salary: number | null; net_salary: number | null; worked_hours: number | null; status: string };
  return {
    ok: true,
    factos: ((data ?? []) as unknown as Linha[]).map((r) => ({
      grossSalary: Number(r.gross_salary ?? 0),
      netSalary: Number(r.net_salary ?? 0),
      workedHours: Number(r.worked_hours ?? 0),
      status: r.status,
    })),
  };
}

async function loadServiceFacts(admin: AdminClient, ctx: FinanceReadContext) {
  const { data, error } = await admin
    .from("services")
    .select("status, calculated_value, manual_value")
    .eq("company_id", ctx.companyId)
    .gte("scheduled_start", `${ctx.periodStart}T00:00:00`)
    .lte("scheduled_start", `${ctx.periodEnd}T23:59:59`);

  if (error) return { ok: false as const, erro: error.message };

  type Linha = { status: string; calculated_value: number | null; manual_value: number | null };
  return { ok: true as const, factos: (data ?? []) as unknown as Linha[] };
}

/**
 * Os prédios da empresa.
 *
 * 🔴 Sem filtro de período, e é deliberado: `building_cards` descreve uma
 *    avença **mensal recorrente**, não um movimento datado. Filtrar por mês
 *    esvaziaria a lista sem nada ganhar.
 */
async function loadBuildingFacts(admin: AdminClient, ctx: FinanceReadContext): Promise<Fonte<FactoPredio>> {
  const { data, error } = await admin
    .from("building_cards")
    .select("id, name, address, weekday, sort_order, monthly_value")
    .eq("company_id", ctx.companyId);

  if (error) return { ok: false, erro: error.message };

  type Linha = {
    id: string; name: string; address: string | null; weekday: string | null;
    sort_order: number | null; monthly_value: number | null;
  };
  return {
    ok: true,
    factos: ((data ?? []) as unknown as Linha[]).map((r) => ({
      id: r.id,
      name: r.name,
      address: r.address,
      weekday: r.weekday,
      sortOrder: Number(r.sort_order ?? 0),
      // 🔴 Sem `?? 0`. Um valor por preencher continua desconhecido.
      monthlyValue: r.monthly_value === null || r.monthly_value === undefined
        ? null
        : Number(r.monthly_value),
    })),
  };
}

// ─── A fotografia ────────────────────────────────────────────────────────────

export async function getFinanceDashboardV2(
  input: { year: number; month: number },
): Promise<{ ok: true; snapshot: FinanceDashboardSnapshot } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };

  const { admin } = guard;
  const ctx = construirContexto(guard.profile.company_id, input.year, input.month, todayInLisbon());

  // `allSettled`: um bloco em falha não derruba os outros. A página pode ter
  // KPIs disponíveis e a eficiência indisponível ao mesmo tempo — que é a
  // situação normal enquanto o domínio não estiver todo ligado.
  const [faturasR, caixaR, folhaR, servicosR, porFaturarR, prediosR] = await Promise.allSettled([
    loadInvoiceFacts(admin, ctx),
    loadCashFacts(admin, ctx),
    loadPayrollFacts(admin, ctx),
    loadServiceFacts(admin, ctx),
    getUnbilledServices(ctx.companyId),
    loadBuildingFacts(admin, ctx),
  ]);

  const falhas: FalhaFonte[] = [];
  const desembrulhar = <T,>(r: PromiseSettledResult<Fonte<T>>, fonte: string): Fonte<T> => {
    if (r.status === "rejected") {
      falhas.push({ fonte, mensagem: String(r.reason) });
      return { ok: false, erro: String(r.reason) };
    }
    if (!r.value.ok) falhas.push({ fonte, mensagem: r.value.erro });
    return r.value;
  };

  const faturas = desembrulhar(faturasR, "invoices");
  const caixa = desembrulhar(caixaR, "cash_flow_entries");
  const folha = desembrulhar(folhaR, "payroll_records");
  const predios = desembrulhar(prediosR, "building_cards");

  const porFaturar: Fonte<{ value: number }> =
    porFaturarR.status === "fulfilled" && porFaturarR.value.ok
      ? { ok: true, factos: porFaturarR.value.services.map((s) => ({ value: s.value ?? 0 })) }
      : { ok: false, erro: "serviços por faturar indisponíveis" };

  // ── Operação do período ───────────────────────────────────────────────────
  //
  // 🔴 Isto é a **agenda**, não dinheiro. Nunca se chama faturado nem recebido:
  //    é o valor previsto dos serviços marcados, que pode nunca ser cobrado.
  const servicos = servicosR.status === "fulfilled" ? servicosR.value : { ok: false as const, erro: "falhou" };
  const operation = servicos.ok
    ? {
        estado: "AVAILABLE" as const,
        previsto: Math.round(
          servicos.factos.reduce((a, s) => a + Number(s.manual_value ?? s.calculated_value ?? 0), 0) * 100,
        ) / 100,
        servicos: servicos.factos.length,
        concluidos: servicos.factos.filter((s) => s.status === "concluido").length,
      }
    : { estado: "ERROR" as const, previsto: null, servicos: 0, concluidos: 0, nota: servicos.erro };

  // ── Avisos de qualidade ───────────────────────────────────────────────────
  const warnings: AvisoSaude[] = [];
  if (operation.estado === "AVAILABLE" && operation.servicos > 0 && operation.concluidos === 0) {
    warnings.push("SERVICES_NOT_COMPLETED");
  }
  if (faturas.ok) {
    if (faturas.factos.some((f) => f.status === "rascunho")) warnings.push("DRAFT_INVOICES_PRESENT");
    if (!faturas.factos.some((f) => f.status !== "rascunho")) warnings.push("NO_ISSUED_INVOICES");
  }
  if (folha.ok && folha.factos.length > 0 && folha.factos.every((f) => f.grossSalary === 0)) {
    warnings.push("PAYROLL_ZERO_VALUES");
  }
  warnings.push("PAYMENT_RECURRENCE_INCIDENT");

  return {
    ok: true,
    snapshot: {
      period: { year: ctx.year, month: ctx.month, start: ctx.periodStart, end: ctx.periodEnd },
      generatedAt: new Date().toISOString(),
      health: { warnings, failures: falhas },
      kpis: calcularKpis(faturas, caixa, folha, ctx),
      // A série diária ainda não existe: não se distribui a folha por dia nem
      // se usa custo como série. Fica indisponível, e a vista mantém o gráfico
      // de 12 meses como recurso, rotulado como tal.
      dailySeries: {
        estado: "UNAVAILABLE",
        pontos: [],
        granularidade: "dia",
        nota: "Série diária por ligar — o Resumo usa a mensal enquanto isso.",
      },
      alerts: calcularAlertas(faturas, porFaturar, ctx),
      aging: calcularAging(faturas, ctx),
      topClients: calcularTopClientes(faturas, ctx),
      // Previsão fica de fora enquanto a periodicidade dos pagamentos estiver
      // comprometida — usar `fixed_variable_payments` projectaria as datas
      // esmagadas do incidente de Agosto.
      // A Previsão de caixa saiu do Resumo: continuava bloqueada pelo
      // incidente de periodicidade, e o lugar foi para os Prédios, que têm
      // fonte própria. O bloco fica no snapshot para quando voltar.
      forecast: { estado: "UNAVAILABLE", nota: "Bloqueada pelo incidente de periodicidade." },
      buildings: (() => {
        const b = calcularPredios(predios);
        return {
          estado: b.estado,
          linhas: b.linhas,
          totalConhecido: b.totalConhecido,
          contagem: b.contagem,
          comValor: b.comValor,
          semValor: b.semValor,
          nota: b.nota,
        };
      })(),
      expensesByCategory: (() => {
        const b = calcularDespesasPorCategoria(caixa, ctx);
        return {
          estado: b.estado,
          // A cor é decidida no agregador, que é quem sabe se duas fatias
          // colidiram. Recalculá-la aqui desfaria o desempate.
          fatias: b.fatias,
          pendentes: b.pendentes,
          total: b.total,
          semCategoria: b.semCategoria,
          nota: b.nota,
        };
      })(),
      // STANDBY: o componente fica, a fonte é que não existe. Volta quando os
      // serviços deixarem de estar todos por concluir e houver classificação.
      revenueByService: { estado: "UNAVAILABLE", nota: "Sem classificação de serviço na fonte." },
      teamEfficiency: { estado: "UNAVAILABLE", nota: "Horas trabalhadas a zero em toda a folha." },
      operation,
    },
  };
}
