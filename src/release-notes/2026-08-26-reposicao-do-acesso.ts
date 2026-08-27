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
    "Uma alteração publicada a 26 de agosto impedia a entrada no sistema: " +
    "ninguém conseguia passar do ecrã de entrada. O acesso foi reposto no " +
    "mesmo dia e tudo voltou ao que era. Nenhum dado foi perdido nem " +
    "alterado. A criação de colaboradores apenas com o nome, que essa " +
    "alteração anunciava, fica para mais tarde e será preparada por etapas.",
};
