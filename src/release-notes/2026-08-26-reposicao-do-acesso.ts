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
  key: "2026-08-26-reposicao-do-acesso",
  publishedAt: "2026-08-26T23:30:00.000Z",
  kind: "correcao",
  title: "Reposição do acesso ao sistema",
  message:
    "Uma alteração publicada a 26 de agosto impedia a entrada no sistema: o " +
    "programa passou a procurar a ficha de cada pessoa por um campo que ainda " +
    "não existia na base de dados, e ninguém conseguia passar do ecrã de " +
    "entrada. O acesso foi reposto no mesmo dia e o sistema voltou ao " +
    "comportamento anterior. Nenhum dado foi perdido nem alterado.\n\n" +
    "A criação de colaboradores apenas com o nome, que essa alteração " +
    "anunciava, fica para mais tarde — desta vez preparada por etapas, para " +
    "que a base de dados esteja pronta antes de o programa contar com ela.",
};
