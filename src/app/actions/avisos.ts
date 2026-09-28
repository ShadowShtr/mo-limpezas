"use server";

// ============================================================================
// AVISOS DE VENCIMENTO — leitura para o modal do dashboard
// ============================================================================
//
// Só isto: ler. Não há aqui nenhuma escrita, e o modal que consome esta action
// também não oferece nenhuma. Um lembrete que também marcasse o pagamento como
// pago seria um clique de distância entre «vi o aviso» e «mexi no dinheiro».
// ============================================================================

import { requireProfile } from "@/lib/auth-guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { carregarAvisos } from "@/lib/avisos/load-avisos";
import { todayInLisbon } from "@/lib/lisbon-time";
import type { AvisoItem } from "@/domain/avisos/types";

/**
 * Os avisos de hoje para quem gere a empresa.
 *
 * 🔴 NUNCA lança, e devolve `[]` em qualquer falha — mesmo parcial.
 *
 *    O molde é o de `getPendingNotices`: esta camada não é essencial ao
 *    dashboard, e derrubá-lo por causa de lembretes seria trocar um
 *    inconveniente por uma avaria. O erro é registado; mascará-lo sem log
 *    deixaria o defeito invisível.
 *
 *    O `carregarAvisos` lança se UMA das quatro fontes falhar, e é isso que se
 *    quer: devolver três como se a quarta estivesse vazia afirmaria «não há
 *    nada» quando o que se sabe é «não consegui perguntar».
 *
 * 🔴 Colaboradora não chega aqui por dois caminhos independentes: o guard de
 *    papéis, e o `redirect("/app")` do layout do dashboard. Um esconde, o
 *    outro autoriza — e é o segundo que conta.
 */
export async function getAvisosVencimento(): Promise<AvisoItem[]> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return [];

    return await carregarAvisos(
      createAdminClient(),
      guard.profile.company_id,
      todayInLisbon(),
    );
  } catch (e) {
    console.error("[avisos] getAvisosVencimento falhou:", e);
    return [];
  }
}
