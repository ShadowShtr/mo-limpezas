// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
//
// A `key` liga ao registo de leitura de cada perfil: mudá-la faz o aviso
// reaparecer a quem já o confirmou. Reescrever o texto muda aquilo que alguém
// disse ter lido.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-30-pagamentos-vista-unificada",
  publishedAt: "2026-08-30T00:00:00.000Z",
  kind: "novidade",
  title: "Pagamentos: tudo do mês num só ecrã",
  message:
    "O ecrã de Pagamentos passa a reunir as contas a pagar do mês e os " +
    "movimentos de dinheiro do mesmo período. Tem filtros, totais e um resumo " +
    "por categoria, e pode registar um pagamento ou um movimento sem sair da " +
    "página. Um pagamento já associado ao seu movimento aparece uma só vez, " +
    "com o valor certo.",
};
