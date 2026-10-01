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
import { carregarQuadroAvisos, type QuadroAvisos } from "@/lib/avisos/load-avisos";
import { todayInLisbon } from "@/lib/lisbon-time";
import { JANELA_QUADRO } from "@/domain/avisos/types";

/**
 * O quadro de pendentes de quem gere a empresa.
 *
 * Janela do quadro (2026-10-01, decisão do dono): atrasados até 15 dias para
 * trás, próximos até 15 dias à frente, oito fontes internas. O sino continua
 * com a sua própria janela — ver `JANELA_SINO` e o cron.
 *
 * 🔴 NUNCA lança. Esta camada não é essencial ao dashboard, e derrubá-lo por
 *    causa de lembretes seria trocar um inconveniente por uma avaria.
 *
 * 🔴 Mas também não mente sobre o que não leu. Cada fonte falha sozinha e
 *    volta pelo nome em `fontesEmFalha`; uma falha geral volta com TODAS as
 *    fontes lá. O quadro diz «não consegui verificar», nunca «nada pendente»
 *    quando não perguntou.
 *
 * 🔴 Colaboradora não chega aqui por dois caminhos independentes: o guard de
 *    papéis, e o `redirect("/app")` do layout do dashboard. Um esconde, o
 *    outro autoriza — e é o segundo que conta.
 *
 *    O tipo `QuadroAvisos` vive em `load-avisos.ts` e não é reexportado daqui:
 *    num ficheiro "use server", até uma reexportação de tipo parte o grafo de
 *    Server Actions no Turbopack.
 */
export async function getAvisosVencimento(): Promise<QuadroAvisos> {
  try {
    const guard = await requireProfile({ roles: ["admin", "gestor"] });
    if (!guard.ok) return { itens: [], fontesEmFalha: [] };

    return await carregarQuadroAvisos(
      createAdminClient(),
      guard.profile.company_id,
      todayInLisbon(),
      JANELA_QUADRO,
    );
  } catch (e) {
    console.error("[avisos] getAvisosVencimento falhou:", e);
    return { itens: [], fontesEmFalha: [...JANELA_QUADRO.fontes] };
  }
}
