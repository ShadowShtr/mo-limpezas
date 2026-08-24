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
  key: "2026-08-24-disponibilidade-mais-segura",
  publishedAt: "2026-08-24T16:00:00.000Z",
  kind: "correcao",
  title: "Disponibilidade mais segura",
  message:
    "Melhorámos a verificação de disponibilidade para evitar sugestões " +
    "incorretas quando não é possível confirmar faltas ou conflitos.",
};
