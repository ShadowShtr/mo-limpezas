// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-25-anexos-a-abrir",
  publishedAt: "2026-08-25T10:00:00.000Z",
  kind: "correcao",
  title: "Anexos a abrir corretamente",
  message:
    "Corrigimos a abertura de imagens e documentos anexados aos pagamentos. " +
    "Os ficheiros já enviados continuam todos disponíveis.",
};
