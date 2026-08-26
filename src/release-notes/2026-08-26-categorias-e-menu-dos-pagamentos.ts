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
  key: "2026-08-26-categorias-e-menu-dos-pagamentos",
  publishedAt: "2026-08-26T18:00:00.000Z",
  kind: "correcao",
  title: "Categoria nos pagamentos e menu de ações corrigido",
  message:
    "Ao criar ou editar um pagamento passa a haver um campo Categoria, com a " +
    "lista já usada nas despesas. Deixar sem categoria continua a ser uma " +
    "opção. O menu «⋯» de cada linha deixou de fazer aparecer uma barra de " +
    "rolagem e já não fica cortado nas últimas linhas da tabela.",
};
