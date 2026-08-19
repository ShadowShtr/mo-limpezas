// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
//
// A `key` liga ao registo de leitura de cada perfil: mudá-la faz o aviso
// reaparecer a quem já o confirmou. Reescrever o texto muda aquilo que alguém
// disse ter lido.
//
// Uma correcção ao que aqui está escreve-se numa nota nova.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-19-financeiro-e-anexos",
  publishedAt: "2026-08-19T12:00:00.000Z",
  kind: "correcao",
  title: "Financeiro e anexos mais estáveis",
  message:
    "Corrigimos a marcação de pagamentos e a permanência dos anexos. " +
    "Também adicionámos múltiplos anexos em Pagamentos, Tarefas e Faltas.",
};
