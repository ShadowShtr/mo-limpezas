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
  key: "2026-08-28-pagamentos-so-pela-aplicacao",
  publishedAt: "2026-08-28T00:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos: quem vê e quem altera",
  message:
    "A lista de pagamentos passou a estar reservada a quem gere a empresa. " +
    "Marcar e desmarcar um pagamento faz-se pelo ecrã de Pagamentos, como " +
    "sempre — e agora é o único caminho, para que o estado do pagamento e o " +
    "movimento no fluxo de caixa nunca fiquem a dizer coisas diferentes.",
};
