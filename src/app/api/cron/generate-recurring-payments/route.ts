import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/cron-auth";
import { todayInLisbon } from "@/lib/lisbon-time";
import { gerarFixosRecorrentes } from "@/lib/payment-recurrence-generation";
import { janelaDeGeracao } from "@/domain/finance/payment-recurrence";

export const maxDuration = 60;

// ============================================================================
// CRON DIÁRIO — os fixos recorrentes sempre quatro meses à frente
// ============================================================================
//
// 🔴 Este cron ESCREVE em produção depois de publicado.
//
//    Cria linhas em `fixed_variable_payments` a partir dos moldes de
//    `payment_recurrences` (107). Não é efeito secundário: é a função.
//
// Corre todos os dias, mas só cria alguma coisa quando um mês novo entra na
// janela (ou quando um fixo novo foi tornado recorrente e a acção imediata
// falhou). Correr duas vezes é inofensivo: a 107 é idempotente.
//
// Uma empresa de cada vez, e o erro de uma não impede as outras.
// ============================================================================

export async function GET(req: NextRequest) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const hoje = todayInLisbon();

  const { data: empresas, error } = await admin
    .from("payment_recurrences")
    .select("company_id")
    .eq("active", true);
  if (error) {
    console.error("[cron/generate-recurring-payments] leitura das recorrências falhou", error.message);
    return NextResponse.json({ ok: false, error: "RECURRENCES_READ_FAILED" }, { status: 500 });
  }

  const ids = [...new Set((empresas ?? []).map((e) => e.company_id as string))];
  const resultados: Record<string, unknown> = {};
  let falhas = 0;

  for (const companyId of ids) {
    const r = await gerarFixosRecorrentes(admin, companyId, hoje);
    resultados[companyId] = r;
    if (!r.ok) {
      falhas += 1;
      console.error("[cron/generate-recurring-payments] empresa falhou", companyId, r.error);
    }
  }

  return NextResponse.json(
    { ok: falhas === 0, hoje, janela: janelaDeGeracao(hoje), empresas: ids.length, resultados },
    { status: falhas === 0 ? 200 : 500 },
  );
}
