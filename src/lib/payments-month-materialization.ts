// ============================================================================
// 🔴 QUARENTENA — materialização de mês em Pagamentos
// ============================================================================
//
// ESTE MÓDULO NÃO É USADO. Nenhum caminho da aplicação lhe chega, e um teste
// (`payments-no-implicit-materialization.test.ts`) falha se alguém o importar.
//
// Está aqui preservado, e não apagado, porque a lógica de repetir pagamentos
// recorrentes de um mês para o seguinte é uma necessidade real do negócio. O
// que não pode voltar é **esta** versão dela, e sobretudo não pode voltar
// ligada a um caminho de leitura.
//
// ---------------------------------------------------------------------------
// Porque foi desligada
// ---------------------------------------------------------------------------
//
// 1. **Corria durante a leitura.** `getPayments` e `getPaymentsReminder`
//    chamavam-na. Abrir a página de Pagamentos, mudar de mês, ou simplesmente
//    entrar no Dashboard depois do login criava linhas na base. Ler escrevia.
//
// 2. **`shiftDate` perde informação.** Guarda o dia e força o mês de destino.
//    Para um pagamento mensal está certo. Para um trimestral está errado, e o
//    erro é irreversível na linha gerada: a 2026-08-03, quatro pagamentos cujos
//    vencimentos eram 03/08, 03/11, 03/02 e 03/05 foram clonados todos como
//    **03/08**. A periodicidade não existe no modelo, por isso a função não
//    tinha como saber — e assumiu mensal para tudo.
//
// Ver `docs/incidents/2026-08-11-pagamentos-materializacao-implicita.md`.
//
// ---------------------------------------------------------------------------
// O que falta antes de isto poder voltar
// ---------------------------------------------------------------------------
//
// - `recurrence_interval_months` e `recurrence_anchor_date` no modelo;
// - a geração passar a ser um **acto explícito do utilizador**, nunca um efeito
//   de render;
// - as linhas existentes sem periodicidade conhecida tratadas como
//   `LEGACY_RECURRENCE_UNKNOWN` — perguntadas, não adivinhadas.
// ============================================================================

import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * ⚠️ DESLIGADA. Desloca uma data para o mês alvo mantendo o dia.
 *
 * Assume que todo o pagamento é mensal. Foi esta suposição que esmagou quatro
 * vencimentos trimestrais numa só data.
 */
export function shiftDateQuarantined(due: string | null, year: number, month: number): string | null {
  if (!due) return null;
  const day = Number(due.slice(8, 10)) || 1;
  const lastDay = new Date(year, month, 0).getDate();
  const d = Math.min(day, lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * ⚠️ DESLIGADA. Clonava os pagamentos fixos do mês anterior mais recente para o
 * mês pedido. Os variáveis nunca eram clonados — daí parecerem ter
 * desaparecido num mês materializado por leitura, onde só os fixos nasciam.
 */
export async function ensureMonthQuarantined(
  admin: AdminClient,
  companyId: string,
  year: number,
  month: number,
) {
  const { data: existingRecurring } = await admin
    .from("fixed_variable_payments")
    .select("id")
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month)
    .eq("recurring", true)
    .limit(1);
  if (existingRecurring && existingRecurring.length > 0) return; // já gerado

  // mês anterior mais recente com fixos
  const { data: prior } = await admin
    .from("fixed_variable_payments")
    .select("period_year, period_month")
    .eq("company_id", companyId)
    .eq("recurring", true)
    .or(`period_year.lt.${year},and(period_year.eq.${year},period_month.lt.${month})`)
    .order("period_year", { ascending: false })
    .order("period_month", { ascending: false })
    .limit(1);
  if (!prior || prior.length === 0) return; // não há fixos anteriores para repetir

  const src = prior[0];
  const { data: templates } = await admin
    .from("fixed_variable_payments")
    .select("id, description, amount, due_date, direct_debit, notes, sort_order, created_by")
    .eq("company_id", companyId)
    .eq("recurring", true)
    .eq("period_year", src.period_year)
    .eq("period_month", src.period_month);
  if (!templates || templates.length === 0) return;

  const rows = templates.map((t) => ({
    company_id: companyId,
    kind: "fixo" as const,
    description: t.description,
    amount: t.amount,
    due_date: shiftDateQuarantined(t.due_date, year, month),
    direct_debit: t.direct_debit,
    status: "pendente" as const,
    recurring: true,
    period_year: year,
    period_month: month,
    notes: t.notes,
    sort_order: t.sort_order,
    source_id: t.id,
    created_by: t.created_by ?? null,
  }));
  await admin.from("fixed_variable_payments").insert(rows);
}
