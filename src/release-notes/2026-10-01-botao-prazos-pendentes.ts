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
  key: "2026-10-01-botao-prazos-pendentes",
  publishedAt: "2026-10-01T00:00:00.000Z",
  kind: "novidade",
  title: "Prazos pendentes sempre à mão",
  message:
    "Ao lado do sino há agora um botão «!» que abre a lista de prazos " +
    "pendentes a qualquer momento — atrasados, de hoje e de amanhã. O número " +
    "vermelho conta os atrasados e os de hoje. O aviso que aparece ao entrar " +
    "continua igual.",
};
