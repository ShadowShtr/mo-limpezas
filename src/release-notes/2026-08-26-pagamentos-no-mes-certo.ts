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
  key: "2026-08-26-pagamentos-no-mes-certo",
  publishedAt: "2026-08-26T09:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos ficam no mês do vencimento",
  message:
    "Um pagamento passa a pertencer ao mês da sua data de vencimento, e não ao " +
    "mês que estava aberto quando foi criado. Alterar a data move-o para o mês " +
    "certo. Pagamentos lançados antes desta correção podem continuar a aparecer " +
    "no mês errado até serem corrigidos.",
};
