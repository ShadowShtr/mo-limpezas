// ============================================================================
// Gerar os fixos recorrentes — o único caminho do runtime até à 107
// ============================================================================
//
// 🔴 Isto ESCREVE. É chamado por exactamente dois sítios:
//
//      · o cron diário `/api/cron/generate-recurring-payments`;
//      · as acções explícitas de quem cria ou torna recorrente um fixo.
//
//    Nunca por uma leitura. `getPayments`, `getPaymentsReminder` e as páginas
//    não lhe chegam, e `payments-no-implicit-materialization.test.ts` falha se
//    alguma vez chegarem. Foi a materialização por leitura que causou o
//    incidente de 2026-08-03.
// ============================================================================

import type { createAdminClient } from "@/lib/supabase/admin";
import { janelaDeGeracao } from "@/domain/finance/payment-recurrence";

type AdminClient = ReturnType<typeof createAdminClient>;

export type ResultadoGeracao =
  | { ok: true; criados: number; saltadosFechados: number }
  | { ok: false; error: string };

export async function gerarFixosRecorrentes(
  admin: AdminClient,
  companyId: string,
  hoje: string,
  recurrenceId: string | null = null,
): Promise<ResultadoGeracao> {
  const { de, ate } = janelaDeGeracao(hoje);
  if (de > ate) return { ok: true, criados: 0, saltadosFechados: 0 };

  const { data, error } = await admin.rpc("generate_recurring_payments_atomic", {
    p_company_id: companyId,
    p_from_key: de,
    p_through_key: ate,
    p_recurrence_id: recurrenceId,
  });
  if (error) return { ok: false, error: error.message };

  const linha = (Array.isArray(data) ? data[0] : data) as
    | { criados?: unknown; saltados_fechados?: unknown }
    | null
    | undefined;
  const criados = Number(linha?.criados);
  const saltados = Number(linha?.saltados_fechados);
  // Fail-closed na leitura do resultado: uma forma inesperada é erro, não zero.
  if (!Number.isInteger(criados) || !Number.isInteger(saltados)) {
    return { ok: false, error: "RECURRENCE_GENERATION_RESULT_MALFORMED" };
  }
  return { ok: true, criados, saltadosFechados: saltados };
}
