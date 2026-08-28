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
  key: "2026-08-28-pagamentos-diagnostico",
  publishedAt: "2026-08-28T00:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos: perceber mais depressa o que falhou",
  message:
    "Melhorámos o diagnóstico quando uma alteração de estado de um pagamento " +
    "não se conclui. Quem marca ou desmarca um pagamento continua a ver a " +
    "mesma mensagem e a fazê-lo pelo mesmo sítio: isto não altera os dados, " +
    "não muda o que é permitido, e não cria um caminho alternativo de " +
    "pagamento. Serve apenas para que uma falha possa ser percebida sem ter " +
    "de repetir a operação.",
};
