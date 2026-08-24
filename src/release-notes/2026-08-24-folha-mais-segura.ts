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
  key: "2026-08-24-folha-mais-segura",
  publishedAt: "2026-08-24T14:00:00.000Z",
  kind: "correcao",
  title: "Folha de pagamento mais segura",
  message:
    "Reforçámos a folha de pagamento para impedir alterações em valores já " +
    "aprovados ou pagos e tornar falhas de cálculo visíveis.",
};
