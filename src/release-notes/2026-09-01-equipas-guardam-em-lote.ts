// ============================================================================
// PUBLICADA - IMUTAVEL
// ============================================================================
// Nao alterar `key`, `publishedAt`, `title` nem `message`.
//
// A `key` liga ao registo de leitura de cada perfil: muda-la faz o aviso
// reaparecer a quem ja o confirmou. Reescrever o texto muda aquilo que alguem
// disse ter lido.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-01-equipas-guardam-em-lote",
  publishedAt: "2026-09-01T00:00:00.000Z",
  kind: "novidade",
  title: "Equipas: guardar so quando terminares",
  message:
    "Ao organizar equipas no Calendario, arrastar pessoas fica primeiro como " +
    "rascunho. As alteracoes so sao gravadas quando escolheres Guardar, e a " +
    "pagina de Equipas passa a preservar melhor o historico das pessoas.",
};
