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
  key: "2026-08-20-avisos-de-atualizacao",
  publishedAt: "2026-08-20T10:00:00.000Z",
  kind: "novidade",
  title: "Avisos de atualização",
  message:
    "Passamos a mostrar um aviso quando há novidades ou correções na aplicação. " +
    "Aparece uma vez, e confirma-se com um clique.",
};
