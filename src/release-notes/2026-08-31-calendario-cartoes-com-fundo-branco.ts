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
  key: "2026-08-31-calendario-cartoes-com-fundo-branco",
  publishedAt: "2026-08-31T00:00:00.000Z",
  kind: "novidade",
  title: "Calendário: cartões com fundo branco",
  message:
    "Os cartões dos serviços agendados passam a ter fundo branco, como os " +
    "cartões dos prédios. A cor da equipa continua na barra lateral de cada " +
    "cartão. Os serviços em curso, cancelados e com falta mantêm a cor de " +
    "sempre, para continuarem a distinguir-se de relance.",
};
