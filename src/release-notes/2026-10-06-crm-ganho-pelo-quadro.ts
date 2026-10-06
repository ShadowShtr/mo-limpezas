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
  key: "2026-10-06-crm-ganho-pelo-quadro",
  publishedAt: "2026-10-06T00:00:00.000Z",
  kind: "correcao",
  title: "CRM: arrastar para «Ganho» abre a conversão",
  message:
    "Ao largar uma lead na coluna «Ganho», o sistema abre o orçamento aceite " +
    "dessa lead com o botão «Converter em cliente» — ao confirmar, a lead fica " +
    "ganha. Se ainda não houver orçamento aceite, aparece o que falta fazer. " +
    "Arrastar cartões também deixou de selecionar o texto da página.",
};
