// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-25-financeiro-muda-de-mes",
  publishedAt: "2026-08-25T12:00:00.000Z",
  kind: "correcao",
  title: "Financeiro atualizado ao mudar de mês",
  message:
    "Corrigimos a navegação mensal para mostrar sempre os dados do período " +
    "selecionado. Ao mudar de mês, os formulários abertos são fechados.",
};
