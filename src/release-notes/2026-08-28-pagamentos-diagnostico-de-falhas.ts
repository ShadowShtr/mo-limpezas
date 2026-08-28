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
  key: "2026-08-28-pagamentos-diagnostico-de-falhas",
  publishedAt: "2026-08-28T09:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos: falhas mais fáceis de identificar",
  message:
    "Melhorámos a forma como o sistema identifica problemas ao marcar ou " +
    "desmarcar pagamentos. O funcionamento e as mensagens no ecrã mantêm-se " +
    "iguais, mas, se algo falhar, conseguimos perceber a causa sem pedir que " +
    "repita a operação.",
};
